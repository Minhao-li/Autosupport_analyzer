"""Parse NetApp EMS log files (EMS-LOG-FILE) into structured events.

The EMS log is a stream of <LR> (log record) elements (no single root):

  <LR d="11Jun2026 07:17:32" n="node1" t="1781129852" id="0/33..." p="1"
      s="Ok" o="vifmgr" vf="" type="1" seq="3369" >
    <vifmgr_cluscheck_droppedall_1 src_vif="..." dst_node="..."/>
  </LR>

Each record carries metadata attributes on <LR> plus one child element whose
tag is the EMS event name and whose attributes are the event parameters.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET

from . import parsing

# EMS/syslog numeric priority -> severity bucket used across the app
_P_TO_SEV = {0: "CRIT", 1: "CRIT", 2: "CRIT", 3: "ERR",
             4: "WARN", 5: "NOTICE", 6: "INFO", 7: "DEBUG"}

_LR_RE = re.compile(r"<LR\b.*?</LR>", re.DOTALL)
_VER_SUFFIX = re.compile(r"_\d+$")

# Parameter keys that commonly carry the affected object, used to attribute an
# EMS event to a vserver / LIF / volume / aggregate for statistics.
_VSERVER_KEYS = ("vserver", "vserver_name", "vfiler", "vfiler_name", "vs", "svm")
_LIF_KEYS = ("lif", "lif_name", "src_vif", "dst_vif", "vif", "interface",
             "interface_name", "ifname", "logical_interface")
_VOL_KEYS = ("vol", "volume", "volume_name", "vol_name")
_AGGR_KEYS = ("aggregate", "aggr", "aggregate_name", "aggr_name")


def _first_param(params: dict, keys) -> str | None:
    for k in keys:
        v = params.get(k)
        if v:
            return v.strip() if isinstance(v, str) else v
    return None


def looks_like_ems(text: str) -> bool:
    head = text.lstrip()[:200]
    return head.startswith("<LR ") or "<LR " in text[:2000]


def parse_ems_log(path: str, max_records: int = 20000) -> dict:
    info = parsing.read_file_content(path, max_bytes=40_000_000)
    if info.get("binary") or "content" not in info:
        return {"ok": False, "error": "Not readable as text"}
    text = info["content"]
    if not looks_like_ems(text):
        return {"ok": False, "error": "Not an EMS log (no <LR> records)"}

    events = []
    total = 0
    for m in _LR_RE.finditer(text):
        total += 1
        if len(events) >= max_records:
            continue
        try:
            el = ET.fromstring(m.group(0))
        except ET.ParseError:
            continue
        a = el.attrib
        child = next(iter(el), None)
        ev_full = child.tag if child is not None else (a.get("o") or "event")
        params = dict(child.attrib) if child is not None else {}
        if child is not None:
            for sub in child:  # rare nested params
                params[sub.tag] = (sub.text or "").strip()
        try:
            p = int(a.get("p", "6"))
        except ValueError:
            p = 6
        events.append({
            "time": a.get("d"),
            "ts": a.get("t"),
            "node": a.get("n"),
            "severity": _P_TO_SEV.get(p, "INFO"),
            "priority": p,
            "event": _VER_SUFFIX.sub("", ev_full),
            "event_full": ev_full,
            "source": a.get("o"),
            "status": a.get("s"),
            "type": a.get("type"),
            "seq": a.get("seq"),
            "id": a.get("id"),
            "vserver": (a.get("vf") or _first_param(params, _VSERVER_KEYS)) or None,
            "lif": _first_param(params, _LIF_KEYS),
            "volume": _first_param(params, _VOL_KEYS),
            "aggregate": _first_param(params, _AGGR_KEYS),
            "params": params,
            "message": ", ".join(f"{k}={v}" for k, v in params.items()),
        })

    return {
        "ok": True,
        "events": events,
        "total": total,
        "row_count": len(events),
        "truncated": total > len(events),
    }
