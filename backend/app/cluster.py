"""Cluster topology & HA association built from ASUP node identity.

Each ASUP package describes a single node but carries cluster-wide context:
  - ``X-HEADER-DATA.TXT``  -> this node's identity (hostname, system-id, serial,
    model, os-version, HA partner hostname/system-id, cluster name + uuid).
  - ``CLUSTER-INFO.xml``   -> the full cluster member list (node/serial/systemid).
  - ``storage_failover.xml`` -> node -> partner HA pairs.

On load, :func:`node_identity` provides the authoritative metadata that
``cases.extract_metadata`` overlays onto its regex guesses (notably the stable
``cluster_uuid`` association key).  :func:`build_clusters` groups every loaded
case by ``cluster_uuid`` (falling back to cluster name), pairs nodes by their HA
partner, and surfaces siblings that belong to the cluster but have not been
loaded yet.
"""
from __future__ import annotations

import os
import re

from . import parsing
from . import topology as topo
from .asup_xml import parse_asup_xml
from .db import get_db

_XHDR_PREFIX = "x-netapp-asup-"
_PLACEHOLDERS = {"", "<unknown>", "unknown", "none", "<none>", "0000000000",
                 "0", "n/a", "na"}


def _clean(v):
    if v is None:
        return None
    v = str(v).strip()
    if v.lower() in _PLACEHOLDERS:
        return None
    return v


def _find_file(root: str, *basenames):
    wanted = {b.lower() for b in basenames}
    for rel, full in parsing.walk_files(root):
        if os.path.basename(rel).lower() in wanted:
            return full
    return None


def parse_x_header(root: str) -> dict:
    """Parse ``X-HEADER-DATA.TXT`` into a {suffix: value} dict (prefix stripped)."""
    full = _find_file(root, "x-header-data.txt")
    if not full:
        return {}
    info = parsing.read_file_content(full, max_bytes=200_000)
    if info.get("binary") or not info.get("content"):
        return {}
    out = {}
    for line in info["content"].splitlines():
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        k = k.strip().lower()
        if k.startswith(_XHDR_PREFIX):
            out[k[len(_XHDR_PREFIX):]] = v.strip()
    return out


def parse_cluster_members(root: str) -> list[dict]:
    """Cluster member nodes from ``CLUSTER-INFO.xml`` (cluster-scoped table)."""
    full = _find_file(root, "cluster-info.xml", "cluster_info.xml")
    if not full:
        return []
    d = parse_asup_xml(full)
    if not d.get("ok"):
        return []
    members = []
    for r in d.get("rows", []):
        node = _clean(r.get("node"))
        if not node:
            continue
        members.append({
            "node": node,
            "serial": _clean(r.get("serialnumber")),
            "system_id": _clean(r.get("systemid")),
            "cluster_name": _clean(r.get("cluster-name")),
            "is_self": (r.get("is-self") or "").strip().lower() == "true",
        })
    return members


def parse_ha_pairs(root: str) -> list[tuple]:
    """(node, partner) HA tuples from ``storage_failover.xml``."""
    full = _find_file(root, "storage_failover.xml", "storage-failover.xml")
    if not full:
        return []
    d = parse_asup_xml(full)
    if not d.get("ok"):
        return []
    pairs = []
    for r in d.get("rows", []):
        node = _clean(r.get("node_name") or r.get("node"))
        partner = _clean(r.get("partner_name"))
        if node and partner:
            pairs.append((node, partner))
    return pairs


def _cluster_uuid_from_xml(root: str) -> str | None:
    """Fallback cluster_uuid from any ASUP table's root attribute."""
    full = _find_file(root, "cluster-info.xml", "cluster_info.xml",
                      "storage_failover.xml", "cluster_ha.xml")
    if not full:
        return None
    d = parse_asup_xml(full)
    return _clean((d.get("meta") or {}).get("cluster_uuid")) if d.get("ok") else None


_ASUP_TYPE_LABELS = {
    "WEEKLY_LOG": "Weekly", "WEEKLY": "Weekly",
    "DAILY_LOG": "Daily", "DAILY": "Daily",
    "NIGHTLY_LOG": "Nightly", "NIGHTLY": "Nightly",
    "MANAGEMENT_LOG": "Management", "MANAGEMENT": "Management",
    "PERFORMANCE DATA": "Performance", "PERFORMANCE_DATA": "Performance",
    "PERFORMANCE": "Performance", "PERF": "Performance",
    "STORAGE": "Storage", "BOOTTIME": "Boot-time", "BOOT": "Boot-time",
    "ALL": "Full", "FULL": "Full",
    "USER_TRIGGERED": "User-triggered", "TEST": "Test",
}


def asup_type_from_header(h: dict) -> str | None:
    """Derive a friendly AutoSupport type (Weekly / Full / Management / …) from
    the ASUP X-HEADER ``subject`` (the trigger is named in parentheses, e.g.
    ``(MANAGEMENT_LOG)`` or ``(USER_TRIGGERED (ALL))``), falling back to the
    payload-type (periodic vs trigger)."""
    subject = _clean(h.get("subject"))
    if subject:
        # First word inside the first parenthesised group.
        m = re.search(r"\(\s*([A-Za-z][A-Za-z0-9_ ]*?)\s*(?:\(|\)|:)", subject)
        token = (m.group(1).strip().upper() if m else "")
        if token:
            label = _ASUP_TYPE_LABELS.get(token) or token.replace("_", " ").title()
            if token == "USER_TRIGGERED":
                inner = re.search(r"USER_TRIGGERED\s*\(\s*([A-Za-z0-9_]+)", subject, re.IGNORECASE)
                if inner:
                    sub = inner.group(1).upper()
                    label = f"User-triggered ({_ASUP_TYPE_LABELS.get(sub, sub.title())})"
            return label
    payload = _clean(h.get("payload-type"))
    if payload:
        p = payload.lower()
        if "trigger" in p:
            return "Triggered"
        if "periodic" in p:
            return "Periodic"
        return payload
    return None


def node_identity(root: str) -> dict:
    """Authoritative identity for the node this ASUP package belongs to."""
    h = parse_x_header(root)
    ident = {
        "cluster_uuid": _clean(h.get("cluster-uuid")),
        "cluster_name": _clean(h.get("cluster-name")),
        "node": _clean(h.get("hostname")),
        "system_id": _clean(h.get("system-id")),
        "serial": _clean(h.get("serial-num")),
        "model": _clean(h.get("model-name")),
        "os_version": _clean(h.get("os-version")),
        "generated_on": _clean(h.get("generated-on")),
        "ha_partner": _clean(h.get("partner-hostname")),
        "partner_system_id": _clean(h.get("partner-system-id")),
        "asup_type": asup_type_from_header(h),
    }

    # Fall back to CLUSTER-INFO for the self node when X-HEADER is absent.
    if not (ident["cluster_uuid"] and ident["node"] and ident["serial"]):
        self_node = next((m for m in parse_cluster_members(root) if m["is_self"]), None)
        if self_node:
            ident["node"] = ident["node"] or self_node["node"]
            ident["serial"] = ident["serial"] or self_node["serial"]
            ident["system_id"] = ident["system_id"] or self_node["system_id"]
            ident["cluster_name"] = ident["cluster_name"] or self_node["cluster_name"]

    if not ident["cluster_uuid"]:
        ident["cluster_uuid"] = _cluster_uuid_from_xml(root)

    if not ident["ha_partner"] and ident["node"]:
        for n, p in parse_ha_pairs(root):
            if n == ident["node"]:
                ident["ha_partner"] = p
                break
    return ident


def _row_get(row, key):
    try:
        return row[key]
    except (IndexError, KeyError):
        return None


def build_clusters() -> dict:
    """Group all loaded cases into clusters with HA pairs and per-node info."""
    with get_db() as db:
        rows = db.execute("SELECT * FROM cases").fetchall()

    clusters: dict[str, dict] = {}

    for row in rows:
        root = _row_get(row, "path")
        has_root = bool(root) and os.path.isdir(root)
        ident = node_identity(root) if has_root else {}

        cuuid = _clean(_row_get(row, "cluster_uuid")) or ident.get("cluster_uuid")
        cname = _clean(_row_get(row, "cluster")) or ident.get("cluster_name")
        key = cuuid or ("name:" + (cname or _row_get(row, "id") or "?"))

        c = clusters.setdefault(key, {
            "cluster_uuid": cuuid, "cluster_name": cname,
            "nodes": {}, "ha_pairs": set(), "case_count": 0,
        })
        c["cluster_uuid"] = c["cluster_uuid"] or cuuid
        c["cluster_name"] = c["cluster_name"] or cname
        c["case_count"] += 1

        node_name = _clean(_row_get(row, "node")) or ident.get("node") or _row_get(row, "id")
        ha_partner = _clean(_row_get(row, "ha_partner")) or ident.get("ha_partner")
        n = c["nodes"].setdefault(node_name, {"node": node_name, "loaded": False})
        n.update({
            "node": node_name,
            "model": _clean(_row_get(row, "model")) or ident.get("model"),
            "serial": _clean(_row_get(row, "serial")) or ident.get("serial"),
            "system_id": _clean(_row_get(row, "system_id")) or ident.get("system_id"),
            "os_version": _clean(_row_get(row, "os_version")) or ident.get("os_version"),
            "generated_on": _clean(_row_get(row, "generated_on")) or ident.get("generated_on"),
            "ha_partner": ha_partner,
            "loaded": True,
            "case_id": _row_get(row, "id"),
            "case_number": _row_get(row, "case_number"),
            "size_bytes": _row_get(row, "size_bytes"),
        })

        # Discover sibling nodes that belong to the cluster but aren't loaded.
        for m in (parse_cluster_members(root) if has_root else []):
            sib = c["nodes"].setdefault(m["node"], {"node": m["node"], "loaded": False})
            sib.setdefault("loaded", False)
            sib["serial"] = sib.get("serial") or m["serial"]
            sib["system_id"] = sib.get("system_id") or m["system_id"]

        # HA pairs: from this node's partner and from the SFO table.
        if node_name and ha_partner:
            c["ha_pairs"].add(frozenset((node_name, ha_partner)))
        for a, b in (parse_ha_pairs(root) if has_root else []):
            c["ha_pairs"].add(frozenset((a, b)))

    out = []
    for c in clusters.values():
        ha_pairs = sorted(sorted(p) for p in c["ha_pairs"] if len(p) == 2)
        paired = {x for p in ha_pairs for x in p}
        nodes = sorted(c["nodes"].values(), key=lambda x: (x["node"] or "").lower())
        for nd in nodes:
            nd["has_ha"] = (nd["node"] in paired) or bool(nd.get("ha_partner"))
        out.append({
            "cluster_uuid": c["cluster_uuid"],
            "cluster_name": c["cluster_name"] or "(unknown cluster)",
            "nodes": nodes,
            "ha_pairs": ha_pairs,
            "node_count": len(nodes),
            "loaded_count": sum(1 for n in nodes if n.get("loaded")),
            "case_count": c["case_count"],
        })
    out.sort(key=lambda x: (x["cluster_name"] or "").lower())
    return {"clusters": out, "count": len(out)}


# --------------------- cluster-merged network topology ---------------------
def _empty_topo() -> dict:
    return {"available": False, "nodes": [], "lifs": [], "vservers": [],
            "types": [], "orphan_lifs": [], "vserver_routes": {},
            "counts": {"nodes": 0, "ports": 0, "lifs": 0, "vservers": 0,
                       "routes": 0, "active_routes": 0}}


def _merge_topologies(roots: list[str]) -> dict:
    """Merge per-case (node-scoped) topologies into one cluster-wide view.

    Each loaded node's ASUP usually only carries its own ports/LIFs/routes, so
    to show the whole cluster we union the nodes/ports/LIFs across every loaded
    case of the cluster (deduplicated by node -> port -> LIF name).
    """
    nodes: dict[str, dict] = {}      # node -> {port -> port dict with _lifs}
    orphans: dict[str, dict] = {}
    vservers: set = set()
    types: set = set()
    vserver_routes: dict[str, dict] = {}
    all_lifs: dict = {}
    available = False

    for root in roots:
        t = topo.get_topology(root)
        if not t.get("available"):
            continue
        available = True
        for nd in t.get("nodes", []):
            pmap = nodes.setdefault(nd.get("node"), {})
            for p in nd.get("ports", []):
                pp = pmap.get(p.get("port"))
                if not pp:
                    pp = {k: v for k, v in p.items() if k != "lifs"}
                    pp["_lifs"] = {}
                    pmap[p.get("port")] = pp
                for l in p.get("lifs", []):
                    pp["_lifs"].setdefault(l.get("name"), l)
        for l in t.get("orphan_lifs", []):
            orphans.setdefault(l.get("name"), l)
        vservers.update(v for v in (t.get("vservers") or []) if v)
        types.update(tt for tt in (t.get("types") or []) if tt)
        for l in t.get("lifs", []):
            all_lifs.setdefault((l.get("vserver"), l.get("name")), l)
        for vs, e in (t.get("vserver_routes") or {}).items():
            cur = vserver_routes.setdefault(vs, {"routes": [], "active": [], "default_gateway": None})
            seen_r = {(r.get("destination"), r.get("gateway")) for r in cur["routes"]}
            for r in e.get("routes", []):
                k = (r.get("destination"), r.get("gateway"))
                if k not in seen_r:
                    seen_r.add(k); cur["routes"].append(r)
            seen_a = {(r.get("node"), r.get("destination"), r.get("gateway"), r.get("interface")) for r in cur["active"]}
            for r in e.get("active", []):
                k = (r.get("node"), r.get("destination"), r.get("gateway"), r.get("interface"))
                if k not in seen_a:
                    seen_a.add(k); cur["active"].append(r)
            if not cur["default_gateway"] and e.get("default_gateway"):
                cur["default_gateway"] = e["default_gateway"]

    if not available:
        return _empty_topo()

    out_nodes = []
    total_ports = total_lifs = 0
    for nm in sorted(nodes, key=lambda x: (x or "").lower()):
        ports = []
        for pk in sorted(nodes[nm], key=lambda x: (x or "")):
            pp = nodes[nm][pk]
            pp["lifs"] = list(pp.pop("_lifs").values())
            ports.append(pp)
        port_count = len([p for p in ports if not p.get("synthetic")])
        lif_count = sum(len(p["lifs"]) for p in ports)
        total_ports += port_count
        total_lifs += lif_count
        out_nodes.append({"node": nm, "ports": ports,
                          "port_count": port_count, "lif_count": lif_count})

    return {
        "available": True,
        "nodes": out_nodes,
        "lifs": list(all_lifs.values()),
        "vservers": sorted(vservers),
        "types": sorted(types),
        "orphan_lifs": list(orphans.values()),
        "vserver_routes": vserver_routes,
        "counts": {
            "nodes": len(out_nodes), "ports": total_ports, "lifs": total_lifs,
            "vservers": len(vservers),
            "routes": sum(len(e["routes"]) for e in vserver_routes.values()),
            "active_routes": sum(len(e["active"]) for e in vserver_routes.values()),
        },
    }


def build_cluster_topologies() -> dict:
    """Network topology merged per cluster across all of its loaded cases."""
    with get_db() as db:
        rows = db.execute("SELECT id, path, cluster, cluster_uuid FROM cases").fetchall()

    groups: dict[str, dict] = {}
    for row in rows:
        cuuid = _clean(_row_get(row, "cluster_uuid"))
        cname = _clean(_row_get(row, "cluster"))
        key = cuuid or ("name:" + (cname or _row_get(row, "id") or "?"))
        g = groups.setdefault(key, {"cluster_uuid": cuuid, "cluster_name": cname, "roots": []})
        g["cluster_uuid"] = g["cluster_uuid"] or cuuid
        g["cluster_name"] = g["cluster_name"] or cname
        root = _row_get(row, "path")
        if root and os.path.isdir(root):
            g["roots"].append(root)

    out = []
    for g in groups.values():
        merged = _merge_topologies(g["roots"])
        out.append({
            "cluster_uuid": g["cluster_uuid"],
            "cluster_name": g["cluster_name"] or "(unknown cluster)",
            **merged,
        })
    out.sort(key=lambda x: (x["cluster_name"] or "").lower())
    return {"clusters": out, "count": len(out)}
