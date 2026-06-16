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

# A path is "mlog" when any directory segment is exactly ``mlog`` (full log
# bundles: mroot/etc/log/mlog/...), OR — for AutoSupports, which flatten the
# daemon logs to the collection root — the file name is a known daemon log or
# carries the ``-mlog``/``mlog`` marker (e.g. ``mgwd.gz``, ``messages.log.gz``,
# ``audit-mlog.txt.gz``, ``sysmgr-mlog.txt.gz``).
_MLOG_DIR_RE = re.compile(r"(?:^|/)mlog/", re.IGNORECASE)

# Known ONTAP daemon / mlog log families (rotation- and extension-independent).
KNOWN_DAEMONS = {
    "mgwd", "messages", "secd", "vifmgr", "notifyd", "spmd", "vldb", "bcomd",
    "cfmd", "crs", "sysmgr", "servprocd", "ndmpd", "licensed", "fpolicy", "php",
    "php-fpm.access", "php-fpm.error", "sktrace", "audit", "auditlog", "debug",
    "hashd", "kmip2_client", "vserverdr", "ypbind", "perfstatd", "cm-daemon",
    "qpidd", "qdrouterd", "dotsql", "smnlog", "snapmirror", "snapmirror_audit",
    "snapmirror_error", "snapmirror-audit-log", "snapmirror-error-log",
    "apache_access", "apache_error", "csm-trace-buffer", "ems-log-file",
    "ems", "leak-data", "netsetup", "sp-debug", "sp-debug-old", "sp-mgmt",
    "coresegd", "named", "bgpd", "corefs", "httpd", "command-history",
    "mhd_stat", "spdebug",
}

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
    """True for a daemon/mlog log file — either physically under an ``mlog``
    directory, or an AutoSupport-flattened daemon log at the collection root."""
    if _MLOG_DIR_RE.search(rel or ""):
        return True
    name = (rel or "").rsplit("/", 1)[-1]
    if not name or name.startswith("."):
        return False
    low = name.lower()
    if "mlog" in low:
        return True
    return family_of(name).lower() in KNOWN_DAEMONS


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
