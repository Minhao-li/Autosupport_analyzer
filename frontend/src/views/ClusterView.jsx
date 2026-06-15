import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { SEVERITIES, Highlight, FilterInput, matchKeywordsAny, SearchHelp, Spinner, fmtBytes } from "../lib/helpers.jsx";
import SeverityFilter from "./SeverityFilter.jsx";

// Cluster-wide view: merges data from every loaded node of one cluster and lets
// the user slice it per node. Tabs aggregate across nodes (EMS, Search) and each
// row is tagged with its source node.
export default function ClusterView({ clusterKey, clusterName }) {
  const [nodes, setNodes] = useState(null);
  const [sel, setSel] = useState(null); // Set of selected node names
  const [tab, setTab] = useState("ems");
  const [err, setErr] = useState(null);

  useEffect(() => {
    setNodes(null); setErr(null); setSel(null);
    api.clusterNodes(clusterKey).then((r) => {
      setNodes(r.nodes || []);
      setSel(new Set((r.nodes || []).map((n) => n.node)));
    }).catch((e) => setErr(String(e.message || e)));
  }, [clusterKey]);

  const toggleNode = (n) => setSel((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const allOn = nodes && sel && sel.size === nodes.length;
  const setAll = (on) => setSel(on ? new Set(nodes.map((n) => n.node)) : new Set());

  if (err) return <div className="error-text">{err}</div>;
  if (!nodes || !sel) return <Spinner label="Loading cluster nodes…" />;

  if (nodes.length === 0) {
    return (
      <div>
        <h2 className="content-title">Cluster · {clusterName || clusterKey}</h2>
        <div className="empty-state">No loaded nodes found for this cluster.</div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="content-title">Cluster · {clusterName || clusterKey}</h2>
      <p className="content-subtitle">
        {nodes.length} node(s) loaded — merged across nodes. Use the node filter to slice per node.
      </p>

      <div className="toolbar" style={{ alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12 }}>Nodes:</span>
        <button className="link-btn" onClick={() => setAll(!allOn)}>{allOn ? "Clear" : "Select all"}</button>
        {nodes.map((n) => (
          <label key={n.node} className={`chip sev-toggle ${sel.has(n.node) ? "" : "off"}`}
            onClick={() => toggleNode(n.node)} style={{ cursor: "pointer" }}
            title={[n.model, n.os_version].filter(Boolean).join(" · ")}>
            <span className="vdot" style={{ background: "var(--accent)" }} /> {n.node}
          </label>
        ))}
        <span className="muted" style={{ fontSize: 11 }}>{sel.size}/{nodes.length} selected</span>
      </div>

      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={tab === "ems" ? "on" : ""} onClick={() => setTab("ems")}>EMS</button>
        <button className={tab === "search" ? "on" : ""} onClick={() => setTab("search")}>Search</button>
      </div>

      {tab === "ems" && <ClusterEms clusterKey={clusterKey} sel={sel} />}
      {tab === "search" && <ClusterSearch clusterKey={clusterKey} sel={sel} />}
    </div>
  );
}

function ClusterEms({ clusterKey, sel }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [selSev, setSelSev] = useState(new Set(SEVERITIES));
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    setData(null); setErr(null);
    api.clusterEms(clusterKey, {}).then(setData).catch((e) => setErr(String(e.message || e)));
  }, [clusterKey]);

  const counts = useMemo(() => {
    const c = {};
    for (const e of data?.events || []) if (sel.has(e.src_node)) c[e.severity] = (c[e.severity] || 0) + 1;
    return c;
  }, [data, sel]);

  const rows = useMemo(() => {
    if (!data) return [];
    let r = data.events.filter((e) => sel.has(e.src_node) && selSev.has(e.severity));
    if (q) r = r.filter((e) => matchKeywordsAny([e.event, e.node, e.src_node, e.source, e.message], q));
    return r;
  }, [data, sel, selSev, q]);

  if (err) return <div className="error-text">{err}</div>;
  if (!data) return <div className="info-text"><span className="spin" /> Merging EMS logs across nodes…</div>;

  return (
    <div>
      <div className="toolbar">
        <FilterInput placeholder="Filter event / node / source / params…" value={q}
          onChange={setQ} wrapStyle={{ minWidth: 260 }} style={{ minWidth: 260 }} />
        <SearchHelp />
        <SeverityFilter selected={selSev} onChange={setSelSev} counts={counts} />
        <span style={{ flex: 1 }} />
        <span className="muted">{rows.length} / {data.row_count} events</span>
      </div>
      {rows.length === 0 ? <div className="empty-state">No EMS events match.</div> : (
        <div className="xml-scroll">
          <table className="file-table tbl-horizontal">
            <thead><tr>
              <th className="nowrap">Node</th>
              <th className="nowrap">Time</th>
              <th>Sev</th>
              <th>Event</th>
              <th>Source</th>
              <th>Parameters</th>
            </tr></thead>
            <tbody>
              {rows.slice(0, 5000).map((e, i) => (
                <React.Fragment key={i}>
                  <tr onClick={() => setExpanded(expanded === i ? null : i)} style={{ cursor: "pointer" }}>
                    <td className="nowrap"><span className="chip">{e.src_node}</span></td>
                    <td className="nowrap mono">{e.time}</td>
                    <td className={`nowrap sev-${e.severity}`}>{e.severity}</td>
                    <td className="mono">{e.event}</td>
                    <td className="nowrap muted">{e.source}</td>
                    <td className="mono"><Highlight text={e.message} q={q} /></td>
                  </tr>
                  {expanded === i && (
                    <tr><td colSpan={6} style={{ background: "var(--panel-2)" }}>
                      <div style={{ fontSize: 12 }}>
                        <div className="muted">event: <b>{e.event_full}</b> · seq {e.seq} · id {e.id} · type {e.type} · status {e.status}</div>
                        {Object.entries(e.params || {}).map(([k, v]) => (
                          <div key={k} className="mono"><span className="muted">{k}</span> = {Array.isArray(v) ? v.join(", ") : v}</div>
                        ))}
                      </div>
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ClusterSearch({ clusterKey, sel }) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState("content"); // content | filenames
  const [regex, setRegex] = useState(false);
  const [cs, setCs] = useState(false);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const run = async () => {
    if (!q || q.length < 2) { setRes(null); return; }
    setBusy(true); setErr(null);
    try {
      const r = mode === "filenames"
        ? await api.clusterSearchFilenames(clusterKey, { q })
        : await api.clusterSearchContent(clusterKey, { q, regex, case_sensitive: cs });
      setRes({ mode, results: r.results || [], total: r.total });
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const shown = useMemo(() => (res ? (res.results || []).filter((x) => sel.has(x.node)) : []), [res, sel]);
  const hitCount = useMemo(() => shown.reduce((a, r) => a + (r.hits ? r.hits.length : 0), 0), [shown]);

  return (
    <div>
      <div className="toolbar">
        <input autoFocus placeholder={mode === "filenames" ? "filename keyword…" : (regex ? "search content (regex)…" : "search content…")}
          value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()}
          style={{ flex: 1, minWidth: 240 }} />
        <SearchHelp regex={mode === "content" && regex} />
        <div className="seg">
          <button className={mode === "content" ? "on" : ""} onClick={() => setMode("content")}>Content</button>
          <button className={mode === "filenames" ? "on" : ""} onClick={() => setMode("filenames")}>File names</button>
        </div>
        {mode === "content" && <>
          <label className="chip"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> regex</label>
          <label className="chip"><input type="checkbox" checked={cs} onChange={(e) => setCs(e.target.checked)} /> Case sensitive</label>
        </>}
        <button className="btn primary" onClick={run} disabled={busy || q.length < 2}>{busy ? "Searching…" : "Search"}</button>
      </div>

      {err && <div className="error-text">{err}</div>}
      {busy && <div className="info-text"><span className="spin" /> Searching across nodes…</div>}

      {res && !busy && (
        <>
          <p className="content-subtitle">
            {shown.length} file{shown.length === 1 ? "" : "s"}
            {res.mode === "content" ? ` · ${hitCount} hit${hitCount === 1 ? "" : "s"}` : ""} across selected nodes.
          </p>
          {shown.length === 0 ? <div className="empty-state">No matches.</div> : (
            <div className="tree-wrap">
              {shown.map((r, i) => (
                <div key={i} style={{ marginBottom: res.mode === "content" ? 10 : 2 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="chip" title="Source node">{r.node}</span>
                    <span className="mono" style={{ fontSize: 12.5, color: "var(--accent)" }}>{r.path}</span>
                    {r.component && <span className="muted" style={{ fontSize: 11 }}>· {r.component}</span>}
                    {res.mode === "filenames" && <span className="muted" style={{ fontSize: 11 }}>· {fmtBytes(r.size)}</span>}
                    {r.hits && <span className="muted" style={{ fontSize: 11 }}>· {r.hits.length} hit(s)</span>}
                  </div>
                  {r.hits && r.hits.map((h, j) => (
                    <div key={j} className="tree-hit">
                      <span className="muted">{h.line}: </span>
                      <Highlight text={h.text} q={regex ? "" : q} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
