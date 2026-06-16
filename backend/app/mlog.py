"""Discover, classify and analyze ONTAP **mlog** files (the per-process daemon
logs under ``mroot/etc/log/mlog/``).

Path characteristics (learned from real ASUP log bundles)
---------------------------------------------------------
* mlog files live in a directory literally named ``mlog`` — in practice
  ``.../mroot/etc/log/mlog/`` — so we detect any path segment ``mlog/``.
* Each *log family* is rotated into many files that share a base name:
    ``mgwd.log``, ``mgwd.log.0000000113``, ``mgwd.4``, ``mgwd.log.gz`` …
  The family is the base name with the rotation suffix stripped. Compound
  names such as ``php-fpm.access`` / ``php-fpm.error`` and ``memsnap-<proc>``
  are preserved.
* Two on-disk line formats dominate:
    1. NetApp daemon envelope (mgwd, messages, audit, secd, vifmgr, notifyd …):
       ``<seq> <token> <Day Mon DD YYYY HH:MM:SS +TZ> [module:level:pid] … SEV: msg``
       — parsed by :mod:`app.mgwd_log` (rich severity extraction).
    2. sktrace style: ``<ISO-8601> <num> [x:y] TAG:  msg`` with severity implied
       by keywords in the TAG/message (CRITICAL/ERROR/WARNING/…).
  A keyword fallback covers anything else.
"""
from __future__ import annotations

import os
import re

from . import parsing
from .mgwd_log import parse_mgwd_log, looks_like_mgwd
from .sktrace_log import parse_sktrace_log, looks_like_sktrace

# A path is "mlog" when any directory segment is exactly ``mlog`` — i.e. the
# files live under ``mroot/etc/log/mlog/`` in a separate log bundle.
_MLOG_DIR_RE = re.compile(r"(?:^|/)mlog/", re.IGNORECASE)

# Rotation / packaging suffixes to strip when reducing a file name to its log
# family. Order matters; applied repeatedly until stable.
_ROTATION_RES = (
    re.compile(r"\.gz$", re.IGNORECASE),          # mgwd.gz
    re.compile(r"\.txt$", re.IGNORECASE),         # audit-mlog.txt
    re.compile(r"\.log\.\d+$", re.IGNORECASE),   # name.log.0000000113
    re.compile(r"\.log$", re.IGNORECASE),         # name.log
    re.compile(r"\.\d+$"),                          # name.4  /  name.0000000113
)
# Trailing daemon-mlog markers (after extension stripping): audit-mlog -> audit.
_MLOG_SUFFIX_RE = re.compile(r"[-_]mlog$", re.IGNORECASE)

# Map per-message level tokens to the app-wide severity buckets.
_SEV_ORDER = ["CRIT", "ERR", "WARN", "NOTICE", "INFO", "DEBUG"]
_KEYWORD_SEV = [
    (re.compile(r"\b(EMERG|EMERGENCY|ALERT|CRIT|CRITICAL|FATAL|PANIC)\b", re.I), "CRIT"),
    (re.compile(r"\b(ERR|ERROR|FAIL(?:ED|URE)?)\b", re.I), "ERR"),
    (re.compile(r"\b(WARN|WARNING)\b", re.I), "WARN"),
    (re.compile(r"\bNOTICE\b", re.I), "NOTICE"),
    (re.compile(r"\bDEBUG\b", re.I), "DEBUG"),
]


def family_of(name: str) -> str:
    """Reduce a file name to its rotation/packaging-independent log family."""
    base = name
    changed = True
    while changed:
        changed = False
        for rx in _ROTATION_RES:
            new = rx.sub("", base)
            if new != base and new:
                base = new
                changed = True
                break
    # Collapse the daemon-mlog marker: audit-mlog -> audit, sysmgr-mlog -> sysmgr.
    stripped = _MLOG_SUFFIX_RE.sub("", base)
    if stripped:
        base = stripped
    return base or name


def is_mlog_file(rel: str) -> bool:
    """True only for files that physically live under an ``mlog`` directory
    (e.g. ``mroot/etc/log/mlog/...``). mlog content is loaded from a separate
    log bundle, NOT taken from the flattened daemon logs inside an AutoSupport
    collection."""
    return bool(_MLOG_DIR_RE.search(rel or ""))


# Back-compat alias.
def is_mlog_path(rel: str) -> bool:
    return is_mlog_file(rel)


def find_mlog_files(root: str):
    """Yield ``(rel, full, size)`` for every daemon/mlog log file in a case."""
    for rel, full in parsing.walk_files(root):
        if not is_mlog_file(rel):
            continue
        try:
            size = os.path.getsize(full)
        except OSError:
            size = 0
        yield rel, full, size


def classify(root: str) -> list[dict]:
    """Group every mlog file by its log family. Returns one dict per family with
    its file list, aggregate size and rotation count, sorted by family name."""
    fams: dict[str, dict] = {}
    for rel, full, size in find_mlog_files(root):
        name = rel.rsplit("/", 1)[-1]
        if name.startswith("."):
            # rotation-control dotfiles (.sktrace_rotate, .daily_log) — skip
            continue
        fam = family_of(name)
        f = fams.setdefault(fam, {"family": fam, "files": [], "size": 0, "count": 0})
        f["files"].append({"path": rel, "size": size})
        f["size"] += size
        f["count"] += 1
    out = list(fams.values())
    for f in out:
        f["files"].sort(key=lambda x: x["path"])
    out.sort(key=lambda f: f["family"].lower())
    return out


def _keyword_sev(line: str) -> str:
    for rx, sev in _KEYWORD_SEV:
        if rx.search(line):
            return sev
    return "INFO"


def _empty_counts() -> dict:
    return {s: 0 for s in _SEV_ORDER}


def analyze_file(full: str, max_bytes: int = 8_000_000,
                 sample_limit: int = 25) -> dict:
    """Parse one mlog file and return severity counts, a line total, the first
    and last timestamps seen, and a few notable (CRIT/ERR/WARN) sample lines."""
    info = parsing.read_file_content(full, max_bytes=max_bytes)
    if info.get("binary") or "content" not in info:
        return {"ok": False, "counts": _empty_counts(), "lines": 0, "samples": [],
                "first_ts": None, "last_ts": None, "truncated": bool(info.get("truncated"))}
    text = info["content"]
    counts = _empty_counts()
    samples: list[dict] = []
    lines = 0
    first_ts = last_ts = None

    if looks_like_mgwd(text):
        parsed = parse_mgwd_log(full, max_records=200_000)
        for ev in parsed.get("events", []):
            lines += 1
            sev = ev.get("severity") or "INFO"
            counts[sev] = counts.get(sev, 0) + 1
            t = ev.get("time")
            if t:
                if first_ts is None:
                    first_ts = t
                last_ts = t
            if sev in ("CRIT", "ERR", "WARN") and len(samples) < sample_limit:
                samples.append({"severity": sev, "time": t,
                                "message": (ev.get("detail") or ev.get("message") or "")[:400]})
        return {"ok": True, "counts": counts, "lines": parsed.get("total", lines),
                "samples": samples, "first_ts": first_ts, "last_ts": last_ts,
                "truncated": bool(info.get("truncated") or parsed.get("truncated"))}

    # Generic / sktrace: keyword severity per line, ISO timestamp at line start.
    iso = re.compile(r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*)")
    for raw in text.splitlines():
        if not raw.strip():
            continue
        lines += 1
        sev = _keyword_sev(raw)
        counts[sev] = counts.get(sev, 0) + 1
        m = iso.match(raw)
        if m:
            if first_ts is None:
                first_ts = m.group(1)
            last_ts = m.group(1)
        if sev in ("CRIT", "ERR", "WARN") and len(samples) < sample_limit:
            samples.append({"severity": sev, "time": (m.group(1) if m else None),
                            "message": raw.strip()[:400]})
    return {"ok": True, "counts": counts, "lines": lines, "samples": samples,
            "first_ts": first_ts, "last_ts": last_ts,
            "truncated": bool(info.get("truncated"))}


def analyze_family(root: str, family: str, files: list[str] | None = None,
                   max_files: int = 40) -> dict:
    """Aggregate :func:`analyze_file` across every rotation of ``family``."""
    if files is None:
        fam = next((f for f in classify(root) if f["family"] == family), None)
        files = [x["path"] for x in (fam["files"] if fam else [])]
    counts = _empty_counts()
    samples: list[dict] = []
    total_lines = 0
    first_ts = last_ts = None
    analyzed = 0
    truncated = False
    for rel in files[:max_files]:
        full = os.path.join(root, rel.replace("/", os.sep))
        if not os.path.isfile(full):
            continue
        r = analyze_file(full)
        analyzed += 1
        for s in _SEV_ORDER:
            counts[s] += r["counts"].get(s, 0)
        total_lines += r.get("lines", 0)
        truncated = truncated or r.get("truncated", False)
        if r.get("first_ts") and (first_ts is None):
            first_ts = r["first_ts"]
        if r.get("last_ts"):
            last_ts = r["last_ts"]
        for s in r.get("samples", []):
            if len(samples) < 50:
                samples.append({**s, "file": rel})
    problems = counts["CRIT"] + counts["ERR"] + counts["WARN"]
    return {
        "family": family,
        "files_analyzed": analyzed,
        "lines": total_lines,
        "counts": counts,
        "problems": problems,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "samples": samples,
        "truncated": truncated,
    }


def analyze_all(root: str, max_files_per_family: int = 40) -> dict:
    """Classify and analyze every mlog family in a case."""
    fams = classify(root)
    results = []
    for f in fams:
        a = analyze_family(root, f["family"],
                           files=[x["path"] for x in f["files"]],
                           max_files=max_files_per_family)
        a["size"] = f["size"]
        a["file_count"] = f["count"]
        a["files"] = f["files"]           # [{path, size}] for the file browser
        results.append(a)
    results.sort(key=lambda r: (-r["problems"], r["family"].lower()))
    totals = {s: sum(r["counts"][s] for r in results) for s in _SEV_ORDER}
    return {
        "families": results,
        "family_count": len(results),
        "totals": totals,
        "total_lines": sum(r["lines"] for r in results),
        "total_problems": sum(r["problems"] for r in results),
    }


def parse_mlog_file(full: str, max_rows: int = 5000, max_bytes: int = 24_000_000) -> dict:
    """Parse a single mlog/daemon log file into human-friendly rows:
    ``{n, time, severity, module, message}`` — choosing the right format parser
    (mgwd daemon envelope, sktrace, or a generic line scan)."""
    info = parsing.read_file_content(full, max_bytes=max_bytes)
    if info.get("binary") or "content" not in info:
        return {"ok": False, "error": "Not readable as text", "rows": [], "total": 0,
                "format": "binary", "truncated": bool(info.get("truncated"))}
    text = info["content"]

    rows: list[dict] = []
    fmt = "generic"

    if looks_like_mgwd(text):
        fmt = "mgwd"
        parsed = parse_mgwd_log(full, max_records=max_rows)
        for i, ev in enumerate(parsed.get("events", []), 1):
            rows.append({
                "n": i,
                "time": ev.get("time"),
                "severity": ev.get("severity") or "INFO",
                "module": ev.get("subsystem") or ev.get("module") or "",
                "message": (ev.get("detail") or ev.get("message") or "")[:2000],
            })
        total = parsed.get("total", len(rows))
        truncated = bool(info.get("truncated") or parsed.get("truncated"))
    elif looks_like_sktrace(text):
        fmt = "sktrace"
        parsed = parse_sktrace_log(full, max_records=max_rows)
        for i, ev in enumerate(parsed.get("events", []), 1):
            rows.append({
                "n": i,
                "time": ev.get("time") or ev.get("ts"),
                "severity": ev.get("severity") or "INFO",
                "module": ev.get("tag") or ev.get("func") or "",
                "message": (ev.get("message") or ev.get("detail") or "")[:2000],
            })
        total = parsed.get("total", len(rows))
        truncated = bool(info.get("truncated") or parsed.get("truncated"))
    else:
        iso = re.compile(r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*)")
        total = 0
        for raw in text.splitlines():
            if not raw.strip():
                continue
            total += 1
            if len(rows) >= max_rows:
                continue
            m = iso.match(raw)
            rows.append({
                "n": total,
                "time": (m.group(1) if m else None),
                "severity": _keyword_sev(raw),
                "module": "",
                "message": raw.strip()[:2000],
            })
        truncated = bool(info.get("truncated") or total > len(rows))

    return {"ok": True, "format": fmt, "rows": rows, "total": total,
            "row_count": len(rows), "truncated": truncated}


def _safe_rel(name: str) -> str | None:
    """Sanitize an archive member path; keep only the ``mlog/<...>`` tail so the
    imported tree is compact and detection (``/mlog/``) still matches."""
    rel = (name or "").replace("\\", "/").lstrip("/")
    parts = [p for p in rel.split("/") if p and p not in (".", "..")]
    if not parts:
        return None
    # Trim everything before the last 'mlog' segment, keeping mlog/<file>.
    idx = max((i for i, p in enumerate(parts) if p.lower() == "mlog"), default=None)
    if idx is None:
        return None
    return "/".join(parts[idx:])


def extract_mlog_members(archive_path: str, dest_dir: str,
                         on_progress=None, max_files: int = 100000) -> int:
    """Extract ONLY the files under an ``mlog`` directory from a tar/zip archive
    into ``dest_dir`` (preserving the ``mlog/<...>`` tail). Returns the count.

    Selective extraction avoids unpacking the (often multi-GB) rest of a log
    bundle. For .7z, the caller should fall back to a full extract + copy."""
    import tarfile
    import zipfile

    low = archive_path.lower()
    count = 0

    def _emit():
        if on_progress and count % 50 == 0:
            on_progress(count)

    if low.endswith((".tgz", ".tar.gz", ".tar", ".tbz", ".tbz2", ".tar.bz2",
                     ".txz", ".tar.xz")):
        if low.endswith((".tgz", ".tar.gz")):
            mode = "r|gz"
        elif low.endswith((".tbz", ".tbz2", ".tar.bz2")):
            mode = "r|bz2"
        elif low.endswith((".txz", ".tar.xz")):
            mode = "r|xz"
        else:
            mode = "r|"
        # Streaming mode (r|*) reads sequentially without seeking — required for
        # large gzip bundles where random access would re-read the whole stream.
        with tarfile.open(archive_path, mode) as t:
            for m in t:
                if not m.isfile() or not is_mlog_file(m.name):
                    continue
                safe = _safe_rel(m.name)
                if not safe:
                    continue
                out = os.path.join(dest_dir, safe.replace("/", os.sep))
                if not os.path.abspath(out).startswith(os.path.abspath(dest_dir)):
                    continue
                os.makedirs(os.path.dirname(out), exist_ok=True)
                src = t.extractfile(m)
                if src is None:
                    continue
                with open(out, "wb") as fo:
                    while True:
                        chunk = src.read(1024 * 1024)
                        if not chunk:
                            break
                        fo.write(chunk)
                count += 1
                _emit()
                if count >= max_files:
                    break
    elif low.endswith(".zip"):
        with zipfile.ZipFile(archive_path) as z:
            for name in z.namelist():
                if name.endswith("/") or not is_mlog_file(name):
                    continue
                safe = _safe_rel(name)
                if not safe:
                    continue
                out = os.path.join(dest_dir, safe.replace("/", os.sep))
                if not os.path.abspath(out).startswith(os.path.abspath(dest_dir)):
                    continue
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with z.open(name) as src, open(out, "wb") as fo:
                    while True:
                        chunk = src.read(1024 * 1024)
                        if not chunk:
                            break
                        fo.write(chunk)
                count += 1
                _emit()
                if count >= max_files:
                    break
    else:
        return -1  # signal: caller should full-extract + copy (e.g. .7z)
    return count


def import_mlog_tree(src_dir: str, dest_dir: str) -> int:
    """Copy every ``mlog`` file found anywhere under ``src_dir`` into
    ``dest_dir`` (preserving the ``mlog/<...>`` tail). Returns the count."""
    import shutil
    count = 0
    for rel, full in parsing.walk_files(src_dir):
        if not is_mlog_file(rel):
            continue
        safe = _safe_rel(rel) or rel.split("/")[-1]
        out = os.path.join(dest_dir, safe.replace("/", os.sep))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        try:
            shutil.copy2(full, out)
            count += 1
        except OSError:
            pass
    return count
