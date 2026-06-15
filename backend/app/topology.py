"""Network topology from ASUP network-interface.xml (LIFs) + network-ports.xml.

Builds a node -> port -> LIF relationship graph (also indexed by vserver and
LIF type/role) for the Network Topology diagram. Falls back to the older
lif-info.xml shape when the table XMLs are absent.
"""
import gzip
import xml.etree.ElementTree as ET

from . import parsing
from .asup_xml import parse_asup_xml


def _files_named(root: str, *endings):
    out = []
    for rel, full in parsing.walk_files(root):
        low = rel.lower()
        if low.endswith(endings):
            out.append(full)
    return out


def _lifs_from_tvif(root: str):
    lifs = []
    for full in _files_named(root, "network-interface.xml", "network-interface.xml.gz"):
        d = parse_asup_xml(full)
        if not d.get("ok"):
            continue
        for r in d.get("rows", []):
            dp = r.get("data_protocol")
            if isinstance(dp, list):
                dp = ", ".join(dp)
            lifs.append({
                "name": r.get("vif"),
                "vserver": r.get("vserver"),
                "type": (r.get("role") or "").lower() or "unknown",
                "data_protocol": dp or None,
                "service_policy": r.get("service_policy"),
                "home_node": r.get("home_node"),
                "home_port": r.get("home_port"),
                "curr_node": r.get("curr_node"),
                "curr_port": r.get("curr_port"),
                "address": r.get("address"),
                "netmask": r.get("netmask"),
                "status": r.get("status_oper"),
                "is_home": r.get("is_home"),
            })
    return lifs


def _ports_from_tport(root: str):
    ports = []
    for full in _files_named(root, "network-ports.xml", "network-ports.xml.gz"):
        d = parse_asup_xml(full)
        if not d.get("ok"):
            continue
        for r in d.get("rows", []):
            ports.append({
                "node": r.get("node"),
                "port": r.get("port"),
                "role": r.get("role"),
                "type": r.get("type"),               # physical / vlan / if_group
                "link": r.get("link"),
                "ifgrp": r.get("ifgrp") or None,
                "ipspace": r.get("ipspace") or "Default",
                "broadcast_domain": r.get("broadcast-domain") or None,
                "mtu": r.get("mtu"),
                "speed": r.get("speed-oper") or r.get("speed-actual"),
            })
    return ports


# ----------------- legacy fallback (lif-info.xml) -----------------
def _text(el, *names):
    for n in names:
        child = el.find(n)
        if child is not None and child.text:
            return child.text.strip()
        if el.get(n):
            return el.get(n)
    return None


def _legacy_lif_info(root: str):
    full = None
    for f in _files_named(root, "lif-info.xml", "lif_info.xml", "lif-info.xml.gz", "lif_info.xml.gz"):
        full = f
        break
    if not full:
        return None, None
    try:
        src = gzip.open(full, "rb") if full.lower().endswith(".gz") else full
        rootel = ET.parse(src).getroot()
    except (ET.ParseError, OSError, EOFError, gzip.BadGzipFile):
        return None, None
    lifs, ports = [], []
    for el in rootel.iter():
        tag = el.tag.lower()
        if "lif" in tag and ("interface" in tag or tag.endswith("lif") or "logical" in tag):
            lifs.append({
                "name": _text(el, "name", "lif-name", "interface-name"),
                "address": _text(el, "address", "ip-address"),
                "vserver": _text(el, "vserver", "vserver-name"),
                "type": (_text(el, "role", "lif-type") or "unknown").lower(),
                "home_node": _text(el, "home-node", "current-node", "node"),
                "home_port": _text(el, "home-port", "current-port", "port"),
                "status": _text(el, "status", "operational-status"),
            })
        elif tag.endswith("port") or "net-port" in tag:
            ports.append({
                "node": _text(el, "node", "node-name"),
                "port": _text(el, "port", "port-name", "name"),
                "role": _text(el, "role", "port-type"),
                "ipspace": _text(el, "ipspace", "ipspace-name") or "Default",
                "broadcast_domain": _text(el, "broadcast-domain", "broadcast_domain"),
            })
    return lifs, ports


def _routes(root: str):
    """Configured per-vserver routes (network-routes.xml)."""
    out = []
    for full in _files_named(root, "network-routes.xml", "network-routes.xml.gz"):
        d = parse_asup_xml(full)
        if not d.get("ok"):
            continue
        for r in d.get("rows", []):
            out.append({
                "vserver": r.get("route_vserver"),
                "destination": r.get("route_destination"),
                "gateway": r.get("route_gateway"),
                "metric": r.get("route_metric"),
            })
    return out


def _active_routes(root: str):
    """Active route table (route-active.xml)."""
    out = []
    for full in _files_named(root, "route-active.xml", "route-active.xml.gz"):
        d = parse_asup_xml(full)
        if not d.get("ok"):
            continue
        for r in d.get("rows", []):
            out.append({
                "node": r.get("node"),
                "vserver": r.get("vserver"),
                "destination": r.get("destination"),
                "interface": r.get("interface"),
                "gateway": r.get("gateway"),
                "metric": r.get("metric"),
                "flags": r.get("flags"),
            })
    return out


def _is_default_dest(dest: str) -> bool:
    return (dest or "").strip() in ("0.0.0.0/0", "0.0.0.0", "::/0", "default")


def get_topology(root: str) -> dict:
    lifs = _lifs_from_tvif(root)
    ports = _ports_from_tport(root)

    if not lifs and not ports:
        l2, p2 = _legacy_lif_info(root)
        if l2 is None:
            return {"available": False, "nodes": [], "lifs": [], "ports": [],
                    "vservers": [], "types": [], "orphan_lifs": [],
                    "routes": [], "active_routes": [], "vserver_routes": {}}
        lifs, ports = l2 or [], p2 or []

    routes = _routes(root)
    active_routes = _active_routes(root)

    # per-vserver route index (+ default gateway)
    vserver_routes = {}
    for r in routes:
        vs = r.get("vserver") or "?"
        e = vserver_routes.setdefault(vs, {"routes": [], "active": [], "default_gateway": None})
        e["routes"].append(r)
        if _is_default_dest(r.get("destination")) and not e["default_gateway"]:
            e["default_gateway"] = r.get("gateway")
    for r in active_routes:
        vs = r.get("vserver") or "?"
        e = vserver_routes.setdefault(vs, {"routes": [], "active": [], "default_gateway": None})
        e["active"].append(r)
        if _is_default_dest(r.get("destination")) and not e["default_gateway"] and r.get("gateway"):
            e["default_gateway"] = r.get("gateway")

    # annotate each LIF with its vserver's default gateway (for the egress arrow)
    for l in lifs:
        e = vserver_routes.get(l.get("vserver"))
        l["default_gateway"] = e["default_gateway"] if e else None

    # index ports by (node, port)
    port_index = {}
    for p in ports:
        port_index[(p.get("node"), p.get("port"))] = dict(p, lifs=[])

    orphan_lifs = []
    for l in lifs:
        key = (l.get("home_node"), l.get("home_port"))
        if key in port_index:
            port_index[key]["lifs"].append(l)
        elif l.get("home_node") and l.get("home_port"):
            port_index[key] = {
                "node": l.get("home_node"), "port": l.get("home_port"),
                "role": None, "type": None, "link": None, "ifgrp": None,
                "ipspace": "Default", "broadcast_domain": None,
                "mtu": None, "speed": None, "synthetic": True, "lifs": [l],
            }
        else:
            orphan_lifs.append(l)

    # group ports by node
    nodes_map = {}
    for p in port_index.values():
        nd = p.get("node") or "(unknown node)"
        nodes_map.setdefault(nd, []).append(p)

    nodes = []
    for nd in sorted(nodes_map):
        node_ports = sorted(nodes_map[nd], key=lambda x: (x.get("port") or ""))
        nodes.append({
            "node": nd,
            "ports": node_ports,
            "port_count": len([p for p in node_ports if not p.get("synthetic")]),
            "lif_count": sum(len(p["lifs"]) for p in node_ports),
        })

    vservers = sorted({l.get("vserver") for l in lifs if l.get("vserver")})
    types = sorted({l.get("type") for l in lifs if l.get("type")})

    return {
        "available": True,
        "nodes": nodes,
        "lifs": lifs,
        "ports": ports,
        "vservers": vservers,
        "types": types,
        "orphan_lifs": orphan_lifs,
        "routes": routes,
        "active_routes": active_routes,
        "vserver_routes": vserver_routes,
        "counts": {"nodes": len(nodes), "ports": len(ports), "lifs": len(lifs),
                   "vservers": len(vservers), "routes": len(routes),
                   "active_routes": len(active_routes)},
    }
