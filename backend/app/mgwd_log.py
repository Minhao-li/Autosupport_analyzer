"""Parse NetApp mgwd (management gateway daemon) log files into structured
events for tabular display and statistics.

Each record is a single line of the form:

  00000015.04935987 0b688d2e Mon Oct 20 2025 00:15:41 +09:00 \
      [kern_mgwd:info:3642] 0x8371fc900: 0: ERR: Vscan::OnDemand: <message>

Fields:
  seq        00000015.04935987   record sequence id (hex.hex)
  token      0b688d2e            opaque per-record token
  date       Mon Oct 20 2025 00:15:41 +09:00
  module     kern_mgwd           logging facility module
  facility   info                facility level
  pid        3642                process id
  thread     0x8371fc900         thread / object pointer
  job        0 | 8603e9...       job / session id (0 when none)
  severity   ERR                 per-message level (DEBUG..CRIT)
  subsystem  Vscan::OnDemand     emitting subsystem (optional)
  message    the remainder of the line
"""
from __future__ import annotations

import re
from datetime import datetime

from . import parsing

# Per-message level token -> severity bucket used across the app.
_SEV_MAP = {
    "EMERG": "CRIT", "EMERGENCY": "CRIT", "ALERT": "CRIT",
    "CRIT": "CRIT", "CRITICAL": "CRIT", "FATAL": "CRIT",
    "ERR": "ERR", "ERROR": "ERR",
    "WARN": "WARN", "WARNING": "WARN",
    "NOTICE": "NOTICE",
    "INFO": "INFO",
    "DEBUG": "DEBUG", "TRACE": "DEBUG",
}

# Common leading envelope shared by all NetApp daemon mlogs (mgwd, secd,
# vifmgr, bcomd, …): "<seq> <token> <date> <rest>".
_ENVELOPE_RE = re.compile(
    r"^(?P<seq>[0-9a-fA-F]+\.[0-9a-fA-F]+)\s+"
    r"(?P<token>[0-9a-fA-F]+)\s+"
    r"(?P<date>[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{4}\s+"
    r"\d{2}:\d{2}:\d{2}\s+[+-]\d{2}:?\d{2})\s+"
    r"(?P<rest>.*)$"
)

# Optional "[module:facility:pid]" metadata block (e.g. [kern_mgwd:info:3642]).
_META_RE = re.compile(r"^\[(?P<module>[^\]:]+):(?P<facility>[^\]:]+):(?P<pid>\d+)\]\s*(?P<rest>.*)$")

# Rich mgwd tail after the metadata: "0xthread: job: SEV: message".
_MGWD_TAIL_RE = re.compile(
    r"^(?P<thread>0x[0-9a-fA-F]+):\s+"
    r"(?P<job>[^:\s]+):\s+"
    r"(?P<sev>[A-Za-z]+):\s*"
    r"(?P<rest>.*)$"
)

# secd-style inner severity, e.g. "| [002.008.206]  ALERT:  message" or
# "| [000.000.030]  debug:  message".
_INNER_SEV_RE = re.compile(
    r"^\|?\s*(?:\[[0-9.]+\]\s+)?"
    r"(?P<sev>DEBUG|TRACE|INFO|NOTICE|WARN|WARNING|ERR|ERROR|CRIT|CRITICAL|FATAL|ALERT|EMERG|EMERGENCY)\s*:\s",
    re.IGNORECASE,
)

# Optional "subsystem: message" split on the remainder. The subsystem may
# contain '::' but never a ': ' (colon followed by whitespace).
_SUBSYS_RE = re.compile(r"^(?P<subsystem>[A-Za-z_][A-Za-z0-9_:]*?):\s+(?P<msg>.*)$")

_DATE_FMT = "%a %b %d %Y %H:%M:%S %z"


def looks_like_mgwd(text: str) -> bool:
    head = text.lstrip()[:4000]
    for line in head.splitlines():
        if _ENVELOPE_RE.match(line):
            return True
    return False


def _parse_ts(date_str: str):
    s = re.sub(r"\s+", " ", date_str.strip())
    # Normalise +09:00 -> +0900 for broad strptime compatibility.
    s = re.sub(r"([+-]\d{2}):(\d{2})$", r"\1\2", s)
    try:
        dt = datetime.strptime(s, _DATE_FMT)
        return str(int(dt.timestamp()))
    except ValueError:
        return None


def parse_mgwd_log(path: str, max_records: int = 50000) -> dict:
    info = parsing.read_file_content(path, max_bytes=80_000_000)
    if info.get("binary") or "content" not in info:
        return {"ok": False, "error": "Not readable as text"}
    text = info["content"]
    if not looks_like_mgwd(text):
        return {"ok": False, "error": "Not an mgwd/daemon log (unrecognised line format)"}

    events = []
    total = 0
    last = None
    for raw in text.splitlines():
        if not raw.strip():
            continue
        m = _ENVELOPE_RE.match(raw)
        if not m:
            # Continuation of the previous record's message (rare).
            if last is not None:
                last["message"] = (last["message"] + "\n" + raw.rstrip())[:8000]
                last["detail"] = (last["detail"] + "\n" + raw.rstrip())[:8000]
            continue
        total += 1
        if len(events) >= max_records:
            last = None
            continue
        g = m.groupdict()
        rest = g["rest"].strip()

        module = facility = pid = thread = job = subsystem = None
        mm = _META_RE.match(rest)
        if mm:
            module = mm.group("module")
            facility = mm.group("facility")
            pid = mm.group("pid")
            rest = mm.group("rest").strip()

        level = None
        tail = _MGWD_TAIL_RE.match(rest)
        if tail:
            # Rich mgwd format: 0xthread: job: SEV: [subsystem:] message
            thread = tail.group("thread")
            job = tail.group("job") if tail.group("job") != "0" else None
            level = tail.group("sev").upper()
            rest = tail.group("rest").strip()
            sm = _SUBSYS_RE.match(rest)
            if sm:
                subsystem = sm.group("subsystem")
        else:
            # secd / other daemon format: severity (if any) is embedded inline.
            im = _INNER_SEV_RE.match(rest)
            if im:
                level = im.group("sev").upper()

        # Fall back to the metadata facility (e.g. info) when no inline level.
        sev = _SEV_MAP.get((level or "").upper()) or _SEV_MAP.get((facility or "").upper(), "INFO")

        msg = rest
        if subsystem:
            sm = _SUBSYS_RE.match(rest)
            if sm:
                msg = sm.group("msg").strip()

        ev = {
            "time": re.sub(r"\s+", " ", g["date"].strip()),
            "ts": _parse_ts(g["date"]),
            "seq": g["seq"],
            "module": module,
            "facility": facility,
            "pid": pid,
            "thread": thread,
            "job": job,
            "severity": sev,
            "level": level,
            "subsystem": subsystem,
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
