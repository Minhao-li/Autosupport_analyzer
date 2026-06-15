"""Parse NetApp sktrace (kernel SK trace) log files into structured events for
tabular display and statistics.

Each record is a single line of the form:

  2025-10-19T15:19:25Z 42010053745721710    [17:0] STORAGEPORT_ERR:  \
      kern_storage_rdma_ports_get_info: Port e0a not found !! Line: 2253

Fields:
  ts      2025-10-19T15:19:25Z   ISO-8601 UTC timestamp
  tick    42010053745721710      high-resolution tick counter
  cpu     [17:0]                 [core:domain]
  tag     STORAGEPORT_ERR        trace tag (MODULE[_LEVEL]); severity is derived
                                  from the trailing level keyword in the tag
  func    kern_storage_..._info  emitting function (optional)
  message the remainder of the line
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from . import parsing

# Tag level keyword -> severity bucket. The trailing matching token of the tag
# wins (e.g. L3_NET_CONFIG_CRITICAL_INFO -> INFO, STORAGEPORT_ERR -> ERR).
_LEVEL_MAP = {
    "PANIC": "CRIT", "EMERG": "CRIT", "EMERGENCY": "CRIT", "ALERT": "CRIT",
    "FATAL": "CRIT", "CRIT": "CRIT", "CRITICAL": "CRIT",
    "ERR": "ERR", "ERROR": "ERR",
    "WARN": "WARN", "WARNING": "WARN",
    "NOTICE": "NOTICE",
    "INFO": "INFO", "DEFAULT": "INFO", "NORM": "INFO", "NORMAL": "INFO",
    "DEBUG": "DEBUG", "DBG": "DEBUG", "TRACE": "DEBUG", "VERBOSE": "DEBUG",
}

_LINE_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}T[0-9:]+Z)\s+"
    r"(?P<tick>\d+)\s+"
    r"\[(?P<core>\d+):(?P<domain>\d+)\]\s+"
    r"(?P<tag>[A-Za-z0-9_]+):\s+"
    r"(?P<rest>.*)$"
)

# Leading "func: message" split on the remainder (func is a bare identifier
# immediately followed by ': ').
_FUNC_RE = re.compile(r"^(?P<func>[A-Za-z_][A-Za-z0-9_]*):\s+(?P<msg>.*)$")

_TS_FMT = "%Y-%m-%dT%H:%M:%SZ"


def _severity_for_tag(tag: str) -> str:
    sev = "INFO"
    for tok in tag.split("_"):
        m = _LEVEL_MAP.get(tok.upper())
        if m:
            sev = m  # last matching token wins
    return sev


def looks_like_sktrace(text: str) -> bool:
    head = text.lstrip()[:4000]
    for line in head.splitlines():
        if _LINE_RE.match(line):
            return True
    return False


def _parse_ts(ts: str):
    try:
        dt = datetime.strptime(ts, _TS_FMT).replace(tzinfo=timezone.utc)
        return str(int(dt.timestamp()))
    except ValueError:
        return None


def parse_sktrace_log(path: str, max_records: int = 50000) -> dict:
    info = parsing.read_file_content(path, max_bytes=80_000_000)
    if info.get("binary") or "content" not in info:
        return {"ok": False, "error": "Not readable as text"}
    text = info["content"]
    if not looks_like_sktrace(text):
        return {"ok": False, "error": "Not an sktrace log (unrecognised line format)"}

    events = []
    total = 0
    last = None
    for raw in text.splitlines():
        if not raw.strip():
            continue
        m = _LINE_RE.match(raw)
        if not m:
            if last is not None:
                last["message"] = (last["message"] + "\n" + raw.rstrip())[:8000]
            continue
        total += 1
        if len(events) >= max_records:
            last = None
            continue
        g = m.groupdict()
        rest = g["rest"].rstrip()
        func = None
        msg = rest
        fm = _FUNC_RE.match(rest)
        if fm:
            func = fm.group("func")
            msg = fm.group("msg").strip()
        tag = g["tag"]
        ev = {
            "time": g["ts"],
            "ts": _parse_ts(g["ts"]),
            "tick": g["tick"],
            "cpu": f"{g['core']}:{g['domain']}",
            "core": g["core"],
            "tag": tag,
            "severity": _severity_for_tag(tag),
            "func": func,
            "message": rest,
            "detail": msg,
        }
        events.append(ev)
        last = ev

    return {
        "ok": True,
        "events": events,
        "total": total,
        "row_count": len(events),
        "truncated": total > len(events),
    }
