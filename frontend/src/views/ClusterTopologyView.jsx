import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { fmtBytes, Spinner } from "../lib/helpers.jsx";

export default function ClusterTopologyView({ onOpenCase, onOpenCluster }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = () => {
    setData(null); setErr(null);
    api.clusters().then(setData).catch((e) => setErr(String(e.message || e)));
  };
  useEffect(load, []);

  if (err) return <div className="error-text">{err}</div>;
  if (!data) return <Spinner label="Building cluster topology…" />;

  const clusters = data.clusters || [];

  return (
    <div>
      <h2 className="content-title">Cluster Topology</h2>
      <p className="content-subtitle">
        Loaded AutoSupports are auto-associated by cluster and HA relationship
        — {clusters.length} cluster{clusters.length === 1 ? "" : "s"}.
        <button className="link-btn" style={{ marginLeft: 8 }} onClick={load}>Refresh</button>
      </p>

      {clusters.length === 0 ? (
        <div className="empty-state">No clusters yet. Load an AutoSupport package to populate the topology.</div>
      ) : clusters.map((c) => (
        <ClusterCard key={c.cluster_uuid || c.cluster_name} c={c} onOpenCase={onOpenCase} onOpenCluster={onOpenCluster} />
      ))}
    </div>
  );
}

function ClusterCard({ c, onOpenCase, onOpenCluster }) {
  const pairKey = (n) => c.ha_pairs.find((p) => p.includes(n));
  const byNode = Object.fromEntries(c.nodes.map((n) => [n.node, n]));

  // nodes not in any HA pair (standalone)
  const pairedNodes = new Set(c.ha_pairs.flat());
  const standalone = c.nodes.filter((n) => !pairedNodes.has(n.node));

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="toolbar" style={{ alignItems: "baseline" }}>
        <h3 style={{ margin: 0, flex: 1 }}>{c.cluster_name}</h3>
        {onOpenCluster && c.loaded_count > 0 && (
          <button className="btn primary" title="Open a merged view of all loaded nodes in this cluster"
            onClick={() => onOpenCluster(c.cluster_uuid || c.cluster_name, c.cluster_name)}>
            ▦ Open all nodes
          </button>
        )}
        <span className="chip">{c.loaded_count}/{c.node_count} node(s) loaded</span>
      </div>
      {c.cluster_uuid && <div className="muted mono" style={{ fontSize: 11, marginBottom: 10 }}>cluster-uuid: {c.cluster_uuid}</div>}

      <div className="cluster-topo">
        {c.ha_pairs.map((pair, i) => (
          <div key={i} className="ha-pair">
            <div className="ha-pair-label">HA pair</div>
            <div className="ha-pair-nodes">
              <NodeBox n={byNode[pair[0]] || { node: pair[0], loaded: false }} onOpenCase={onOpenCase} />
              <span className="ha-link" title="Storage failover partners">⇄</span>
              <NodeBox n={byNode[pair[1]] || { node: pair[1], loaded: false }} onOpenCase={onOpenCase} />
            </div>
          </div>
        ))}
        {standalone.map((n) => (
          <div key={n.node} className="ha-pair">
            <div className="ha-pair-label">Standalone</div>
            <div className="ha-pair-nodes">
              <NodeBox n={n} onOpenCase={onOpenCase} />
            </div>
          </div>
        ))}
      </div>

      <table className="file-table" style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Node</th><th>Model</th><th>System ID</th><th>Serial</th>
            <th>OS version</th><th>HA partner</th><th className="nowrap">Size</th><th></th>
          </tr>
        </thead>
        <tbody>
          {c.nodes.map((n) => (
            <tr key={n.node}>
              <td>
                {n.node}{" "}
                {n.loaded
                  ? <span className="chip" title="AutoSupport loaded">loaded</span>
                  : <span className="chip muted" title="Member of this cluster but not loaded">not loaded</span>}
              </td>
              <td className="muted">{n.model || "—"}</td>
              <td className="mono">{n.system_id || "—"}</td>
              <td className="mono">{n.serial || "—"}</td>
              <td className="muted" title={n.os_version || ""}>{n.os_version || "—"}</td>
              <td className="mono">{n.ha_partner || "—"}</td>
              <td className="nowrap muted">{n.loaded ? fmtBytes(n.size_bytes) : "—"}</td>
              <td className="nowrap">
                {n.loaded && <button className="icon-btn" onClick={() => onOpenCase && onOpenCase(n.case_id)}>Open</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NodeBox({ n, onOpenCase }) {
  const clickable = n.loaded && onOpenCase;
  return (
    <div className={`node-box ${n.loaded ? "loaded" : "unloaded"}`}
      onClick={() => clickable && onOpenCase(n.case_id)}
      style={{ cursor: clickable ? "pointer" : "default" }}
      title={clickable ? "Open this node's AutoSupport" : (n.loaded ? "" : "Not loaded")}>
      <div className="node-box-name">{n.node}</div>
      <div className="node-box-meta">{n.model || "—"}</div>
      <div className="node-box-meta mono">{n.system_id || ""}</div>
      <div className={`node-box-state ${n.loaded ? "on" : "off"}`}>{n.loaded ? "loaded" : "not loaded"}</div>
    </div>
  );
}
