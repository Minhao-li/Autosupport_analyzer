"""Parse NetApp IFSTAT (`ifstat -a`) per-interface counter dumps.

The text shape is a flat list of interface blocks, grouped under IPSpace
headers, each with RECEIVE / TRANSMIT / DEVICE / LINK INFO sections of
`Label: value | Label: value` counter pairs:

  ---- Default IPSpace ----
  -- interface  e0e  (428 days, 8 hours, ... ) --

  RECEIVE
   Total frames:        0  | Frames/second:       0  | Total bytes:         0
   Total errors:        0  | Total discards:      0  | ...
  TRANSMIT
   ...
  DEVICE
   ...
  LINK INFO
   Speed:               0  | Duplex:            full | Media state: no carrier

This module turns it into structured per-interface records and pulls out the
error / discard counters used by the statistics view to flag problem links.
"""
import re

from . import parsing

_IPSPACE_RE = re.compile(r"^----\s*(.+?)\s*IPSpace\s*----\s*$")
_IFACE_RE = re.compile(r"^--\s*interface\s+(\S+)\s*(?:\((.*?)\))?\s*--\s*$")
_SECTION_RE = re.compile(r"^(RECEIVE|TRANSMIT|DEVICE|LINK INFO)\s*$")
# counter pairs: "Label name:   value" possibly several per line split by '|'
_PAIR_RE = re.compile(r"([A-Za-z][\w /.+()-]*?):\s*([^|]+?)\s*(?:\||$)")

# Counters that indicate a problem when non-zero (per section).
_ERROR_KEYS = {
    "total errors", "errors/minute", "crc errors", "runt frames", "fragment",
    "long frames", "jabber", "length errors", "no buffer", "noproto",
    "error symbol", "illegal symbol", "bus overruns", "queue drops",
    "bad udp cksum", "bad udp6 cksum", "bad tcp cksum", "bad tcp6 cksum",
    "lagg errors", "lacp errors", "lacp pdu errors", "collisions",
    "max collisions", "late collisions", "queue overflow", "timeout",
    "tso non-tcp drop", "split hdr drop", "alignment errors",
    "unsupported op", "errored frames", "lagg no buffer", "lagg no entries",
    "lagg drops",
}
_DISCARD_KEYS = {"total discards", "discards/minute"}


def looks_like_ifstat(text: str) -> bool:
    head = text[:4000]
    return ("-- interface " in head) and ("RECEIVE" in head or "TRANSMIT" in head)


def _to_num(v: str):
    """Parse a counter value, expanding ONTAP's k/m/g/t magnitude suffixes."""
    s = (v or "").strip()
    m = re.fullmatch(r"(\d+(?:\.\d+)?)([kmgtKMGT])?", s)
    if not m:
        return None
    n = float(m.group(1))
    mult = {"k": 1e3, "m": 1e6, "g": 1e9, "t": 1e12}.get((m.group(2) or "").lower())
    if mult:
        n *= mult
    return int(n) if n.is_integer() else n


def _parse_pairs(line: str) -> dict:
    out = {}
    for m in _PAIR_RE.finditer(line):
        out[m.group(1).strip()] = m.group(2).strip()
    return out


def parse_ifstat(path: str, max_bytes: int = 8_000_000) -> dict:
    info = parsing.read_file_content(path, max_bytes=max_bytes)
    if info.get("binary") or "content" not in info:
        return {"ok": False, "error": "Not readable as text"}
    text = info["content"]
    if not looks_like_ifstat(text):
        return {"ok": False, "error": "Not an IFSTAT counter dump"}

    interfaces = []
    ipspace = None
    cur = None
    section = None

    def close():
        nonlocal cur
        if cur is not None:
            interfaces.append(cur)
            cur = None

    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        m = _IPSPACE_RE.match(line.strip())
        if m:
            ipspace = m.group(1).strip()
            continue
        m = _IFACE_RE.match(line.strip())
        if m:
            close()
            cur = {
                "interface": m.group(1),
                "ipspace": ipspace,
                "uptime": (m.group(2) or "").strip() or None,
                "sections": {"RECEIVE": {}, "TRANSMIT": {}, "DEVICE": {}, "LINK INFO": {}},
            }
            section = None
            continue
        m = _SECTION_RE.match(line.strip())
        if m:
            section = m.group(1)
            continue
        if cur is not None and section is not None:
            cur["sections"][section].update(_parse_pairs(line))
    close()

    # Derive per-interface error/discard totals + link state for quick stats.
    for it in interfaces:
        rx = it["sections"]["RECEIVE"]
        tx = it["sections"]["TRANSMIT"]
        link = it["sections"]["LINK INFO"]

        def sum_keys(sec, keyset):
            total = 0
            hits = {}
            for k, v in sec.items():
                if k.lower() in keyset:
                    n = _to_num(v)
                    if n:
                        total += n
                        hits[k] = n
            return total, hits

        rx_err, rx_err_hits = sum_keys(rx, _ERROR_KEYS)
        tx_err, tx_err_hits = sum_keys(tx, _ERROR_KEYS)
        rx_disc, rx_disc_hits = sum_keys(rx, _DISCARD_KEYS)
        tx_disc, tx_disc_hits = sum_keys(tx, _DISCARD_KEYS)

        it["rx_errors"] = rx_err
        it["tx_errors"] = tx_err
        it["rx_discards"] = rx_disc
        it["tx_discards"] = tx_disc
        it["total_errors"] = rx_err + tx_err
        it["total_discards"] = rx_disc + tx_disc
        it["error_breakdown"] = {**{f"rx {k}": v for k, v in rx_err_hits.items()},
                                 **{f"tx {k}": v for k, v in tx_err_hits.items()},
                                 **{f"rx {k}": v for k, v in rx_disc_hits.items()},
                                 **{f"tx {k}": v for k, v in tx_disc_hits.items()}}

        # Capture EVERY non-zero numeric counter across all sections, tagged by
        # section and classified (error/discard/info) so the UI can show the
        # full picture rather than only the known error keys.
        nonzero = []
        for sec_name in ("RECEIVE", "TRANSMIT", "DEVICE", "LINK INFO"):
            for k, v in it["sections"][sec_name].items():
                n = _to_num(v)
                if n is None or n == 0:
                    continue
                kl = k.lower()
                kind = ("error" if kl in _ERROR_KEYS else
                        "discard" if kl in _DISCARD_KEYS else "info")
                nonzero.append({"section": sec_name, "key": k, "value": n,
                                "raw": v, "kind": kind})
        it["nonzero"] = nonzero
        it["nonzero_count"] = len(nonzero)

        it["has_problem"] = (rx_err + tx_err + rx_disc + tx_disc) > 0
        it["speed"] = link.get("Speed")
        it["duplex"] = link.get("Duplex")
        it["flowcontrol"] = link.get("Flowcontrol")
        it["media_state"] = link.get("Media state")
        it["link_up_to_downs"] = _to_num(link.get("Up to downs", "")) or 0
        it["rx_total_frames"] = _to_num(rx.get("Total frames", "")) or 0
        it["tx_total_frames"] = _to_num(tx.get("Total frames", "")) or 0

    totals = {
        "interfaces": len(interfaces),
        "with_errors": sum(1 for i in interfaces if i["total_errors"] > 0),
        "with_discards": sum(1 for i in interfaces if i["total_discards"] > 0),
        "total_errors": sum(i["total_errors"] for i in interfaces),
        "total_discards": sum(i["total_discards"] for i in interfaces),
    }
    return {"ok": True, "interfaces": interfaces, "totals": totals,
            "count": len(interfaces)}
