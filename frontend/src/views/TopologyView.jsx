import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";

const TYPE_COLORS = {
  data: "#10b981",
  cluster: "#0ea5e9",
  "cluster-mgmt": "#ef4444",
  cluster_mgmt: "#ef4444",
  "node-mgmt": "#f59e0b",
  node_mgmt: "#f59e0b",
  intercluster: "#8b5cf6",
  unknown: "#94a3b8",
};
const typeColor = (t) => TYPE_COLORS[(t || "").toLowerCase()] || "#94a3b8";

export default function TopologyView({ activeCase }) {
  const [all, setAll] = useState(null);   // { clusters: [...] }
  const [sel, setSel] = useState(null);   // selected cluster key
  const [typeOff, setTypeOff] = useState(new Set());
  const [vserver, setVserver] = useState("");

  useEffect(() => {
    setAll(null);
    api.clustersTopology().then(setAll).catch(() => setAll({ clusters: [] }));
  }, []);

  const clusters = all?.clusters || [];
  const keyOf = (c) => c.cluster_uuid || c.cluster_name;

  // Preselect the active case's cluster (or the first one with data).
  useEffect(() => {
    if (!clusters.length) return;
    if (sel && clusters.some((c) => keyOf(c) === sel)) return;
    let pick = null;
    if (activeCase) {
      pick = clusters.find((c) => activeCase.cluster_uuid && c.cluster_uuid === activeCase.cluster_uuid)
        || clusters.find((c) => activeCase.cluster && c.cluster_name === activeCase.cluster);
    }
    pick = pick || clusters.find((c) => c.available) || clusters[0];
    setSel(keyOf(pick)); setTypeOff(new Set()); setVserver("");
  }, [all, activeCase]); // eslint-disable-line

  const data = clusters.find((c) => keyOf(c) === sel) || clusters[0] || null;

  const visible = (l) => !typeOff.has(l.type) && (!vserver || l.vserver === vserver);
  const toggleType = (t) => setTypeOff((s) => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; });

  const lifCountByType = useMemo(() => {
    const c = {};
    for (const l of data?.lifs || []) c[l.type] = (c[l.type] || 0) + 1;
    return c;
  }, [data]);

  if (!all) return <div className="info-text"><span className="spin" /> Loading…</div>;
  if (!clusters.length) return (
    <div>
      <h2 className="content-title">Network Topology</h2>
      <div className="empty-state">No clusters loaded yet. Load AutoSupport packages to view network topology.</div>
    </div>
  );

  const ClusterSelect = () => (
    <div className="toolbar" style={{ marginBottom: 4 }}>
      <span className="muted">Cluster:</span>
      <select value={sel || ""} onChange={(e) => { setSel(e.target.value); setTypeOff(new Set()); setVserver(""); }}>
        {clusters.map((c) => (
          <option key={keyOf(c)} value={keyOf(c)}>
            {c.cluster_name} ({(c.nodes || []).length} node{(c.nodes || []).length === 1 ? "" : "s"})
          </option>
        ))}
      </select>
    </div>
  );

  if (!data || !data.available) return (
    <div>
      <h2 className="content-title">Network Topology</h2>
      <ClusterSelect />
      <div className="empty-state">No network-interface.xml / network-ports.xml in this cluster's loaded cases — topology unavailable.</div>
    </div>
  );

  const c = data.counts || {};
  const vsRoutes = data.vserver_routes || {};
  const vsList = Array.from(new Set([...(data.vservers || []), ...Object.keys(vsRoutes)]))
    .filter((v) => v && v !== "?").sort();
  return (
    <div>
      <h2 className="content-title">Network Topology — {data.cluster_name}</h2>
      <ClusterSelect />
      <p className="content-subtitle">
        {c.nodes} node(s) · {c.ports} port(s) · {c.lifs} LIF(s) · {c.vservers} vserver(s)
        {"  "}— all nodes of the cluster (merged across loaded cases); node → port → LIF (colored by type); the ↳ arrow shows each LIF's egress gateway.
      </p>

      {/* Controls / legend */}
      <div className="toolbar" style={{ flexWrap: "wrap" }}>
        <span className="muted">Type:</span>
        {(data.types || []).map((t) => (
          <span key={t} className="chip" onClick={() => toggleType(t)}
            style={{ cursor: "pointer", opacity: typeOff.has(t) ? 0.4 : 1, borderLeft: `4px solid ${typeColor(t)}` }}
            title={typeOff.has(t) ? `Show ${t}` : `Hide ${t}`}>
            {t} {lifCountByType[t] || 0}
          </span>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="muted">Vserver:</span>
        <select value={vserver} onChange={(e) => setVserver(e.target.value)}>
          <option value="">All</option>
          {(data.vservers || []).map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>

      {/* Vservers & routes — concise; hover a vserver to see its route + active route table */}
      {vsList.length > 0 && (
        <>
          <div className="topo-section-label">Vservers &amp; routes — hover for route / active route table</div>
          <div className="toolbar" style={{ flexWrap: "wrap" }}>
            {vsList.map((vs) => {
              const e = vsRoutes[vs] || { routes: [], active: [], default_gateway: null };
              return (
                <span className="chip vs-chip" key={vs}>
                  {vs}{e.default_gateway ? <span className="muted">&nbsp;· gw {e.default_gateway}</span> : null}
                  <span className="muted">&nbsp;({e.active.length} routes)</span>
                  <div className="route-pop">
                    <div className="route-pop-title">{vs} — configured routes</div>
                    {e.routes.length === 0 ? <div className="muted" style={{ fontSize: 11 }}>none</div> : (
                      <table className="route-tbl"><tbody>
                        {e.routes.map((r, i) => (
                          <tr key={i}><td className="mono">{r.destination}</td><td className="muted">→</td>
                            <td className="mono">{r.gateway}</td><td className="muted">m{r.metric}</td></tr>
                        ))}
                      </tbody></table>
                    )}
                    <div className="route-pop-title" style={{ marginTop: 8 }}>Active route table ({e.active.length})</div>
                    {e.active.length === 0 ? <div className="muted" style={{ fontSize: 11 }}>none</div> : (
                      <div className="route-scroll">
                        <table className="route-tbl">
                          <thead><tr><th>Destination</th><th>Gateway</th><th>Iface</th><th>M</th><th>Flags</th></tr></thead>
                          <tbody>
                            {e.active.slice(0, 100).map((r, i) => (
                              <tr key={i}>
                                <td className="mono">{r.destination}</td>
                                <td className="mono">{r.gateway}</td>
                                <td className="mono">{r.interface}</td>
                                <td className="muted">{r.metric}</td>
                                <td className="muted">{r.flags}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </span>
              );
            })}
          </div>
        </>
      )}

      {data.orphan_lifs?.length > 0 && (
        <div className="card" style={{ borderColor: "var(--sev-warn)", marginBottom: 12 }}>
          <b className="sev-WARN">LIFs without a home port ({data.orphan_lifs.length})</b>
          <div className="muted" style={{ fontSize: 12 }}>{data.orphan_lifs.map((l) => l.name).join(", ")}</div>
        </div>
      )}

      {data.nodes.map((node) => (
        <div className="topo-node" key={node.node}>
          <div className="topo-node-head">
            <span className="topo-node-icon">▤</span>
            <b>{node.node}</b>
            <span className="muted" style={{ fontSize: 12 }}>{node.port_count} ports · {node.lif_count} LIFs</span>
          </div>
          <div className="topo-ports">
            {node.ports.map((p) => {
              const lifs = (p.lifs || []).filter(visible);
              return (
                <div className="topo-port" key={p.port}>
                  <div className="topo-port-head">
                    <span className="topo-port-name mono">{p.port}</span>
                    {p.role && <span className="chip">{p.role}</span>}
                    {p.type && <span className="chip">{p.type}</span>}
                    {p.link && <span className={`chip ${p.link === "up" ? "sev-NOTICE" : "sev-WARN"}`}>{p.link}</span>}
                    {p.speed && <span className="muted" style={{ fontSize: 11 }}>{p.speed} Mb</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                    {p.ipspace}{p.broadcast_domain ? ` · BD ${p.broadcast_domain}` : ""}{p.ifgrp ? ` · ifgrp ${p.ifgrp}` : ""}
                  </div>
                  <div className="topo-port-lifs">
                    {lifs.length === 0 ? <span className="muted" style={{ fontSize: 11 }}>—</span> : lifs.map((l) => (
                      <div className="topo-lif" key={l.name} style={{ borderLeft: `4px solid ${typeColor(l.type)}` }}
                        title={`${l.name}\ntype: ${l.type}\nvserver: ${l.vserver}\naddress: ${l.address || "—"}\nstatus: ${l.status || "—"}`}>
                        <div className="topo-lif-row">
                          <span className="topo-lif-name mono">{l.name}</span>
                          <span className="chip" style={{ background: typeColor(l.type) + "22", borderColor: typeColor(l.type) }}>{l.type}</span>
                        </div>
                        <div className="topo-lif-row muted" style={{ fontSize: 11 }}>
                          <span>{l.vserver || "—"}</span>
                          <span className="mono">{l.address || ""}</span>
                          {l.status && l.status !== "up" && <span className="sev-WARN">{l.status}</span>}
                        </div>
                        {l.default_gateway && l.type !== "cluster" && (
                          <div className="topo-lif-gw mono" title={`Egress via default gateway ${l.default_gateway}`}>
                            ↳ via {l.default_gateway}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
