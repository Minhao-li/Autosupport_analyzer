"""Case ingestion: archive extraction, metadata detection, persistence."""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import tarfile
import zipfile
import gzip
import bz2
import lzma
from datetime import datetime, timezone

from .config import CASES_DIR
from .db import get_db
from . import parsing
from . import cluster

ARCHIVE_EXTS = (".zip", ".tgz", ".tar.gz", ".tar", ".7z",
                ".tbz", ".tbz2", ".tar.bz2", ".txz", ".tar.xz")


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def new_case_id() -> str:
    return secrets.token_hex(6)


def is_archive(name: str) -> bool:
    low = name.lower()
    return low.endswith(ARCHIVE_EXTS)


def extract_archive(src_file: str, dest_dir: str):
    low = src_file.lower()
    os.makedirs(dest_dir, exist_ok=True)
    if low.endswith(".zip"):
        with zipfile.ZipFile(src_file) as z:
            z.extractall(dest_dir)
    elif low.endswith((".tgz", ".tar.gz", ".tar", ".tbz", ".tbz2",
                       ".tar.bz2", ".txz", ".tar.xz")):
        if low.endswith((".tgz", ".tar.gz")):
            mode = "r:gz"
        elif low.endswith((".tbz", ".tbz2", ".tar.bz2")):
            mode = "r:bz2"
        elif low.endswith((".txz", ".tar.xz")):
            mode = "r:xz"
        else:
            mode = "r:"
        with tarfile.open(src_file, mode) as t:
            t.extractall(dest_dir)
    elif low.endswith(".7z"):
        try:
            import py7zr  # optional
            with py7zr.SevenZipFile(src_file, "r") as z:
                z.extractall(dest_dir)
        except ImportError:
            raise ValueError("7z support requires the py7zr package")
    else:
        raise ValueError("Not a supported archive (.7z/.tgz/.tar.gz/.tar.bz2/.tar.xz/.zip)")


def dir_size(path: str) -> int:
    total = 0
    for _root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(_root, f))
            except OSError:
                pass
    return total


_PKG_HINTS = ("autosupport", "asup", "x-header", "smc.xml", "body")


def detect_package_type(root: str) -> str:
    for rel, _full in parsing.walk_files(root):
        low = rel.lower()
        if any(h in low for h in _PKG_HINTS):
            return "asup"
    return "unknown"


_META_PATTERNS = {
    "cluster": [r"cluster[_\s-]*name[:=\s]+([\w.-]+)", r"\bcluster\b[:=\s]+([\w.-]+)"],
    "node": [r"\bnode[_\s-]*name[:=\s]+([\w.-]+)", r"\bhostname[:=\s]+([\w.-]+)"],
    "system_id": [r"system[_\s-]*id[:=\s]+(\d+)"],
    "serial": [r"serial[_\s-]*(?:number|no)?[:=\s]+([\w-]+)"],
    "model": [r"\bmodel[:=\s]+([\w.-]+)", r"\bplatform[:=\s]+([\w.-]+)"],
    "case_number": [r"case[_\s-]*(?:number|num)[:=\s]+(\d+)"],
    "os_version": [r"(NetApp Release [^\n\r]+)"],
    "trigger": [r"\btrigger[:=\s]+([\w.-]+)"],
    "generated_on": [r"generated[_\s-]*on[:=\s]+([^\n\r]+)"],
    "ha_partner": [r"(?:ha[_\s-]*partner|partner[_\s-]*node)[:=\s]+([\w.-]+)"],
}


def extract_metadata(root: str) -> dict:
    meta = {k: None for k in _META_PATTERNS}
    meta["cluster_uuid"] = None
    candidates = []
    for rel, full in parsing.walk_files(root):
        low = rel.lower()
        if any(h in low for h in ("header", "x-header", "asup", "sysconfig", "version", "smc.xml", "rc")):
            candidates.append(full)
    candidates = candidates[:40]
    blob = ""
    for full in candidates:
        info = parsing.read_file_content(full, max_bytes=200_000)
        if not info.get("binary"):
            blob += "\n" + info.get("content", "")
        if len(blob) > 4_000_000:
            break
    for key, pats in _META_PATTERNS.items():
        for p in pats:
            m = re.search(p, blob, re.IGNORECASE)
            if m:
                meta[key] = m.group(1).strip()
                break

    # Authoritative overlay from the ASUP node identity (X-HEADER / CLUSTER-INFO
    # / storage_failover). These win over the heuristic regex guesses and
    # provide the stable cluster_uuid used to auto-associate sibling nodes.
    try:
        ident = cluster.node_identity(root)
    except Exception:
        ident = {}
    overlay = {
        "cluster": ident.get("cluster_name"),
        "node": ident.get("node"),
        "system_id": ident.get("system_id"),
        "serial": ident.get("serial"),
        "model": ident.get("model"),
        "os_version": ident.get("os_version"),
        "generated_on": ident.get("generated_on"),
        "ha_partner": ident.get("ha_partner"),
        "cluster_uuid": ident.get("cluster_uuid"),
        "asup_type": ident.get("asup_type"),
    }
    for key, val in overlay.items():
        if val:
            meta[key] = val
    return meta


def save_case(case_id: str, source: str, root: str, case_number: str | None = None):
    pkg = detect_package_type(root)
    meta = extract_metadata(root)
    if case_number:
        meta["case_number"] = case_number
    elif not meta.get("case_number"):
        # Preserve a previously-stored case number on metadata refresh.
        existing = get_case(case_id)
        if existing and existing["case_number"]:
            meta["case_number"] = existing["case_number"]
    size = dir_size(root)
    with get_db() as db:
        db.execute(
            """INSERT OR REPLACE INTO cases
               (id, source, package_type, loaded_at, size_bytes, path, header,
                cluster, node, case_number, system_id, serial, trigger,
                generated_on, model, os_version, ha_partner, cluster_uuid, asup_type)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                case_id, source, pkg, now(), size, root, json.dumps(meta),
                meta.get("cluster"), meta.get("node"), meta.get("case_number"),
                meta.get("system_id"), meta.get("serial"), meta.get("trigger"),
                meta.get("generated_on"), meta.get("model"), meta.get("os_version"),
                meta.get("ha_partner"), meta.get("cluster_uuid"), meta.get("asup_type"),
            ),
        )
        db.commit()
    return get_case(case_id)


def case_to_dict(row):
    return {
        "id": row["id"], "source": row["source"], "package_type": row["package_type"],
        "loaded_at": row["loaded_at"], "size_bytes": row["size_bytes"],
        "cluster": row["cluster"], "node": row["node"], "case_number": row["case_number"],
        "system_id": row["system_id"], "serial": row["serial"], "trigger": row["trigger"],
        "generated_on": row["generated_on"], "model": row["model"],
        "os_version": row["os_version"], "ha_partner": row["ha_partner"],
        "cluster_uuid": (row["cluster_uuid"] if "cluster_uuid" in row.keys() else None),
        "asup_type": (row["asup_type"] if "asup_type" in row.keys() else None),
    }


def get_case(case_id: str):
    with get_db() as db:
        row = db.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
    return row


def list_cases():
    with get_db() as db:
        rows = db.execute("SELECT * FROM cases ORDER BY loaded_at DESC").fetchall()
    return [case_to_dict(r) for r in rows]


def delete_case(case_id: str):
    row = get_case(case_id)
    if not row:
        return False
    path = row["path"]
    if path and os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)
    with get_db() as db:
        db.execute("DELETE FROM cases WHERE id=?", (case_id,))
        db.commit()
    return True


def delete_all_cases() -> int:
    """Delete every loaded case (files + DB rows). Returns the number removed."""
    n = 0
    for c in list_cases():
        if delete_case(c["id"]):
            n += 1
    return n


def case_root(case_id: str) -> str | None:
    row = get_case(case_id)
    return row["path"] if row else None


def extract_all_nested(stage_dir: str, max_passes: int = 30, on_event=None) -> bool:
    """Recursively peel **every** nested compression layer under ``stage_dir``.

    Detection is by file magic bytes (not extension), so layers work regardless
    of naming and even when single-stream codecs are chained many levels deep
    (e.g. ``.7z`` → ``.gz`` → ``.tar`` → ``.xz`` → …):

      * container archives (zip / 7z / tar, incl. compressed tars) are extracted
        into a sibling ``<name>__x`` directory;
      * single-stream codecs (gzip / bzip2 / xz) that wrap another archive are
        decompressed one layer into ``<name>__d`` (handled on the next pass);
      * single-stream files that are **not** archives (e.g. a ``secd.gz`` log)
        are left untouched — only a 512-byte peek is decompressed to decide.

    ``on_event(count, name)`` is called (if given) each time a layer is peeled,
    so callers can report progress. Returns True if at least one layer was
    extracted.
    """
    stage_abs = os.path.abspath(stage_dir)
    clean = set()          # paths already known to be non-archives
    extracted_any = False
    peeled = 0

    def _peeled(name):
        nonlocal peeled, extracted_any
        peeled += 1
        extracted_any = True
        if on_event:
            try:
                on_event(peeled, os.path.basename(name))
            except Exception:
                pass

    for _ in range(max_passes):
        progressed = False
        for _rel, full in list(parsing.walk_files(stage_dir)):
            full = os.path.abspath(full)
            if full in clean:
                continue
            kind = _sniff_file(full)
            if kind is None:
                clean.add(full)
                continue
            sub = full + "__x"
            if kind in ("zip", "7z", "tar"):
                try:
                    os.makedirs(sub, exist_ok=True)
                    _extract_container(full, kind, sub)
                    os.remove(full)
                    progressed = True
                    _peeled(full)
                except Exception:
                    shutil.rmtree(sub, ignore_errors=True)
                    clean.add(full)
            else:  # gz / bz2 / xz single stream
                head = _peek_decompress(full, kind)
                inner = _sniff_bytes(head)
                if inner == "tar":
                    try:
                        os.makedirs(sub, exist_ok=True)
                        with tarfile.open(full, "r:*") as t:
                            t.extractall(sub)
                        os.remove(full)
                        progressed = True
                        _peeled(full)
                    except Exception:
                        shutil.rmtree(sub, ignore_errors=True)
                        clean.add(full)
                elif inner in ("zip", "7z", "gz", "bz2", "xz"):
                    out = full + "__d"
                    try:
                        _decompress_stream(full, kind, out)
                        os.remove(full)
                        progressed = True
                        _peeled(full)
                    except Exception:
                        if os.path.exists(out):
                            os.remove(out)
                        clean.add(full)
                else:
                    # Plain compressed file (e.g. a log) — leave it as-is.
                    clean.add(full)
        if not progressed:
            break
    return extracted_any


# --- archive magic-byte detection & extraction helpers -----------------------
_MAGICS = (
    (b"PK\x03\x04", "zip"), (b"PK\x05\x06", "zip"), (b"PK\x07\x08", "zip"),
    (b"7z\xbc\xaf\x27\x1c", "7z"),
    (b"\x1f\x8b", "gz"),
    (b"BZh", "bz2"),
    (b"\xfd7zXZ\x00", "xz"),
)
_STREAM_OPEN = {"gz": gzip.open, "bz2": bz2.open, "xz": lzma.open}


def _sniff_bytes(head: bytes):
    if head and len(head) >= 262 and head[257:262] == b"ustar":
        return "tar"
    for sig, kind in _MAGICS:
        if head.startswith(sig):
            return kind
    return None


def _sniff_file(path: str):
    try:
        with open(path, "rb") as f:
            return _sniff_bytes(f.read(512))
    except OSError:
        return None


def _extract_container(path: str, kind: str, dest: str):
    if kind == "zip":
        with zipfile.ZipFile(path) as z:
            z.extractall(dest)
    elif kind == "7z":
        import py7zr
        with py7zr.SevenZipFile(path, "r") as z:
            z.extractall(dest)
    elif kind == "tar":
        with tarfile.open(path, "r:*") as t:
            t.extractall(dest)


def _peek_decompress(path: str, kind: str, n: int = 512) -> bytes:
    op = _STREAM_OPEN.get(kind)
    if not op:
        return b""
    try:
        with op(path, "rb") as f:
            return f.read(n)
    except Exception:
        return b""


def _decompress_stream(path: str, kind: str, out: str):
    op = _STREAM_OPEN[kind]
    with op(path, "rb") as src, open(out, "wb") as dst:
        shutil.copyfileobj(src, dst)


# Files that mark the root of a single node's ASUP, most authoritative first.
_NODE_MARKERS = ("x-header-data.txt", "cluster-info.xml", "smc.xml")


def find_node_roots(stage_dir: str) -> list[str]:
    """Detect the per-node ASUP roots inside a fully-extracted tree.

    Scans every directory path for an ASUP node marker (``X-HEADER-DATA.TXT``
    primarily; ``CLUSTER-INFO.xml`` / ``smc.xml`` as fallbacks). For each marker
    it climbs to the highest ancestor whose subtree still contains only that one
    marker — i.e. that node's own folder (with its logs) — regardless of how
    deeply it is nested. Returns one directory per node.

    A single-node tree (or one with no recognisable marker) returns
    ``[stage_dir]`` so the whole tree becomes one case.
    """
    stage_abs = os.path.abspath(stage_dir)
    files = [os.path.abspath(full) for _rel, full in parsing.walk_files(stage_dir)]

    markers = []
    for name in _NODE_MARKERS:
        markers = [f for f in files if os.path.basename(f).lower() == name]
        if markers:
            break
    if len(markers) <= 1:
        return [stage_abs]

    def count_under(d: str) -> int:
        pref = d + os.sep
        return sum(1 for o in markers if o.startswith(pref))

    roots = set()
    for mk in markers:
        best = os.path.dirname(mk)
        cur = best
        while True:
            parent = os.path.dirname(cur)
            # Never climb to (or above) the staging root: it holds every node.
            if parent == cur or parent == stage_abs or not parent.startswith(stage_abs + os.sep):
                break
            if count_under(parent) == 1:
                best = cur = parent
            else:
                break
        roots.add(best)
    return sorted(roots)


def ingest_server_path(src_abs: str, dest_dir: str):
    """Bring a server-side file/dir into a case directory. Archives are
    extracted into the case root (consistent with archive upload); folders and
    plain files are copied verbatim, preserving their own name as the
    top-level entry under the case."""
    os.makedirs(dest_dir, exist_ok=True)
    name = os.path.basename(src_abs.rstrip("/\\"))
    if os.path.isdir(src_abs):
        shutil.copytree(src_abs, os.path.join(dest_dir, name), dirs_exist_ok=True)
    elif is_archive(name):
        extract_archive(src_abs, dest_dir)
    else:
        shutil.copy2(src_abs, os.path.join(dest_dir, name))
