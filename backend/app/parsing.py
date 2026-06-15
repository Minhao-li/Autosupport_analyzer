"""Log parsing helpers: event extraction, file enumeration, grep, search."""
from __future__ import annotations

import gzip
import os
import re
from datetime import datetime

SEVERITIES = ["CRIT", "ERR", "WARN", "NOTICE", "INFO", "DEBUG"]

# mlog/EMS style:  Tue Jun 03 21:43:06 EDT 2026 [node: process: subj:severity]: message
_MLOG_RE = re.compile(
    r"^(?P<ts>\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})"
    r"(?:\s+\S+)?\s+(?P<year>\d{4})?\s*\[(?P<src>[^\]]*)\]?:?\s*(?P<msg>.*)$"
)
# syslog style:  2026-06-03T21:43:06+00:00 host proc: message
_SYSLOG_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:[+-]\d{2}:?\d{2}|Z)?)\s+(?P<msg>.*)$"
)
_SEV_RE = re.compile(r"\b(CRIT(?:ICAL)?|ERR(?:OR)?|WARN(?:ING)?|NOTICE|INFO|DEBUG)\b", re.IGNORECASE)

TEXT_EXTS = {".log", ".txt", ".xml", ".out", ".cfg", ".conf", ".csv", ".json", ".sh", ""}
BINARY_HINT = re.compile(rb"[\x00-\x08\x0e-\x1f]")


def normalize_sev(raw: str | None) -> str:
    if not raw:
        return "INFO"
    r = raw.upper()
    if r.startswith("CRIT"):
        return "CRIT"
    if r.startswith("ERR"):
        return "ERR"
    if r.startswith("WARN"):
        return "WARN"
    if r.startswith("NOTICE"):
        return "NOTICE"
    if r.startswith("DEBUG"):
        return "DEBUG"
    return "INFO"


def _is_gz(path: str) -> bool:
    return path.lower().endswith(".gz")


def _inner_name(path: str) -> str:
    """Filename with a trailing .gz stripped, for ext/text detection."""
    return path[:-3] if _is_gz(path) else path


def _open_bytes(path: str):
    """Open a (possibly gzipped) file in binary mode."""
    return gzip.open(path, "rb") if _is_gz(path) else open(path, "rb")


def is_text_file(path: str) -> bool:
    ext = os.path.splitext(_inner_name(path))[1].lower()
    if ext in TEXT_EXTS:
        return True
    try:
        with _open_bytes(path) as f:
            chunk = f.read(2048)
        return not BINARY_HINT.search(chunk)
    except (OSError, EOFError, gzip.BadGzipFile):
        return False


def walk_files(root: str):
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace("\\", "/")
            yield rel, full


def read_file_content(full: str, max_bytes: int = 1_000_000):
    try:
        comp_size = os.path.getsize(full)
    except OSError:
        return {"error": "not found"}
    binary = not is_text_file(full)
    try:
        with _open_bytes(full) as f:
            data = f.read(max_bytes + 1)
    except (OSError, EOFError, gzip.BadGzipFile) as e:
        return {"error": f"read error: {e}"}
    truncated = len(data) > max_bytes
    data = data[:max_bytes]
    # For .gz report decompressed bytes read; otherwise the file size.
    size = len(data) if _is_gz(full) else comp_size
    if binary:
        return {"binary": True, "size": comp_size, "truncated": truncated, "content": "",
                "gz": _is_gz(full)}
    return {
        "binary": False,
        "size": size,
        "truncated": truncated,
        "gz": _is_gz(full),
        "content": data.decode("utf-8", errors="replace"),
    }


def parse_line(line: str):
    """Return (timestamp_str|None, severity, message) for a single log line."""
    line = line.rstrip("\n")
    if not line.strip():
        return None
    m = _MLOG_RE.match(line)
    ts = None
    msg = line
    if m:
        ts = m.group("ts")
        if m.group("year"):
            ts = f"{ts} {m.group('year')}"
        msg = (m.group("src") or "") + " " + (m.group("msg") or "")
    else:
        m2 = _SYSLOG_RE.match(line)
        if m2:
            ts = m2.group("ts")
            msg = m2.group("msg")
    sev_m = _SEV_RE.search(line)
    sev = normalize_sev(sev_m.group(1) if sev_m else None)
    return {"ts": ts, "severity": sev, "sev_explicit": bool(sev_m),
            "message": msg.strip(), "raw": line}


def parse_file(full: str, limit: int = 20000):
    events = []
    info = read_file_content(full, max_bytes=8_000_000)
    if info.get("binary") or "content" not in info:
        return events
    for line in info["content"].splitlines():
        ev = parse_line(line)
        if ev:
            events.append(ev)
            if len(events) >= limit:
                break
    return events


def parse_query(q: str):
    """Parse a search string into AND-groups of OR-terms.

    OR separator:  "|"  or the whole word "or"
    AND separator: "||" or the whole word "and"  (nested filter)

    Returns list[list[str]] — every group must match (AND); within a group any
    term matches (OR). Terms keep their original case. An empty/operator-only
    query returns [].
    """
    s = q or ""
    and_parts = re.split(r"\s*\|\|\s*|\s+and\s+", s, flags=re.IGNORECASE)
    groups = []
    for part in and_parts:
        terms = [t.strip() for t in re.split(r"\s*\|\s*|\s+or\s+", part, flags=re.IGNORECASE) if t.strip() != ""]
        if terms:
            groups.append(terms)
    return groups


def grep_files(files: list[str], pattern: str, regex: bool, case_sensitive: bool,
               context: int, max_hits_per_file: int, max_total_hits: int):
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        if regex:
            # User-supplied regex: one matcher, "|" is native alternation.
            rxs = [re.compile(pattern, flags)]
        else:
            # Literal search with AND-groups of OR-terms. Each group compiles to
            # an OR alternation; a line must match ALL groups (nested filter).
            groups = parse_query(pattern) or [[pattern]]
            rxs = [re.compile("|".join(re.escape(t) for t in terms), flags) for terms in groups]
    except re.error as e:
        return {"error": f"bad regex: {e}", "results": [], "total": 0}
    results = []
    total = 0
    for full in files:
        if total >= max_total_hits:
            break
        if not os.path.isfile(full) or not is_text_file(full):
            continue
        hits = []
        try:
            with _open_bytes(full) as f:
                lines = f.read().decode("utf-8", errors="replace").splitlines(keepends=True)
        except (OSError, EOFError, gzip.BadGzipFile):
            continue
        for i, ln in enumerate(lines):
            if all(rx.search(ln) for rx in rxs):
                lo = max(0, i - context)
                hi = min(len(lines), i + context + 1)
                hits.append({
                    "line": i + 1,
                    "text": ln.rstrip("\n"),
                    "context": [lines[j].rstrip("\n") for j in range(lo, hi)] if context else [],
                })
                total += 1
                if len(hits) >= max_hits_per_file or total >= max_total_hits:
                    break
        if hits:
            results.append({"path": full, "hits": hits})
    return {"results": results, "total": total}
