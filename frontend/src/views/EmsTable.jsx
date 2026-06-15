import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { SEVERITIES, Highlight, FilterInput, matchKeywordsAny, SearchHelp, ColumnFilter, colMatches } from "../lib/helpers.jsx";
import SeverityFilter from "./SeverityFilter.jsx";
import StatsModal from "./StatsModal.jsx";

export default function EmsTable({ caseId, comp, path }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [selSev, setSelSev] = useState(new Set(SEVERITIES));
  const [q, setQ] = useState("");
  const [facet, setFacet] = useState(null); // { key, label, value } exact-match filter
  const [expanded, setExpanded] = useState(null);
  const [sortKey, setSortKey] = useState("idx");
  const [asc, setAsc] = useState(true);
  const [stats, setStats] = useState(false);
  const [colFilters, setColFilters] = useState({}); // field -> Set(values)
  const setCol = (field, set) => setColFilters((m) => ({ ...m, [field]: set }));

  useEffect(() => {
    setData(null); setErr(null); setExpanded(null); setFacet(null);
    api.emsLog(caseId, path, comp).then((r) => {
      if (!r.ok) setErr(r.error || "Could not parse as EMS log.");
      else setData(r);
    }).catch((e) => setErr(String(e.message || e)));
  }, [caseId, comp, path]);

  const counts = useMemo(() => {
    const c = {};
    for (const e of data?.events || []) c[e.severity] = (c[e.severity] || 0) + 1;
    return c;
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    let r = data.events.map((e, i) => ({ ...e, idx: i }));
    r = r.filter((e) => selSev.has(e.severity));
    if (facet) r = r.filter((e) => String(e[facet.key] ?? "") === facet.value);
    for (const [field, set] of Object.entries(colFilters)) {
      if (set && set.size) r = r.filter((e) => colMatches(set, e[field]));
    }
    if (q) {
      r = r.filter((e) => matchKeywordsAny([e.event, e.node, e.source, e.message], q));
    }
    r.sort((a, b) => {
      const av = a[sortKey] ?? "", bv = b[sortKey] ?? "";
      return (av > bv ? 1 : av < bv ? -1 : 0) * (asc ? 1 : -1);
    });
    return r;
  }, [data, selSev, q, facet, sortKey, asc, colFilters]);

  // Apply a click on a statistics item as a filter on the EMS log.
  const pickStat = (dim, value) => {
    if (dim.key === "severity") setSelSev(new Set([value]));
    else setFacet({ key: dim.key, label: dim.label, value: String(value) });
    setStats(false);
  };

  const sortBy = (k) => { if (sortKey === k) setAsc(!asc); else { setSortKey(k); setAsc(true); } };

  if (err) return <div className="error-text">{err}</div>;
  if (!data) return <div className="info-text"><span className="spin" /> Parsing EMS log…</div>;

  return (
    <div>
      <div className="card" style={{ marginBottom: 10 }}>
        <b>EMS event log</b>
        <span className="muted" style={{ fontSize: 12 }}>
          {" "}· {data.total} records{data.truncated ? ` (showing first ${data.row_count})` : ""}
        </span>
      </div>
      <div className="toolbar">
        <FilterInput placeholder="Filter event / node / source / params…" value={q}
          onChange={setQ} wrapStyle={{ minWidth: 260 }} style={{ minWidth: 260 }} />
        <SearchHelp />
        <SeverityFilter selected={selSev} onChange={setSelSev} counts={counts} />
        {facet && (
          <span className="chip" title={`Filtering ${facet.label} = ${facet.value}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {facet.label}: {facet.value}
            <button type="button" className="filter-input-clear" tabIndex={-1}
              title="Clear filter" aria-label="Clear filter"
              style={{ position: "static", transform: "none" }}
              onClick={() => setFacet(null)}>✕</button>
          </span>
        )}
        <button className="btn" onClick={() => setStats(true)} title="Show statistics for these EMS events">📊 Statistics</button>
        <span style={{ flex: 1 }} />
        <span className="muted">{rows.length} / {data.row_count}</span>
      </div>

      {stats && (
        <StatsModal
          title={`EMS event log${data.truncated ? ` (first ${data.row_count} of ${data.total})` : ""}`}
          events={data.events}
          dims={[
            { key: "severity", label: "Severity" },
            { key: "event", label: "Event type" },
            { key: "source", label: "Source module" },
            { key: "node", label: "Node" },
            { key: "vserver", label: "Vserver" },
            { key: "lif", label: "LIF / interface" },
            { key: "volume", label: "Volume" },
            { key: "aggregate", label: "Aggregate" },
            { key: "status", label: "Status" },
            { key: "type", label: "Record type" },
          ]}
          onClose={() => setStats(false)}
          onPick={pickStat}
        />
      )}

      {rows.length === 0 ? <div className="empty-state">No EMS events match.</div> : (
        <div className="xml-scroll">
          <table className="file-table tbl-horizontal">
            <thead><tr>
              <th onClick={() => sortBy("ts")} className="nowrap">Time</th>
              <th onClick={() => sortBy("severity")}>Sev</th>
              <th onClick={() => sortBy("node")}>
                <span className="th-flex">Node
                  <ColumnFilter label="Node" values={data.events.map((e) => e.node)}
                    selected={colFilters.node} onChange={(s) => setCol("node", s)} /></span>
              </th>
              <th onClick={() => sortBy("event")}>
                <span className="th-flex">Event
                  <ColumnFilter label="Event" values={data.events.map((e) => e.event)}
                    selected={colFilters.event} onChange={(s) => setCol("event", s)} /></span>
              </th>
              <th onClick={() => sortBy("source")}>
                <span className="th-flex">Source
                  <ColumnFilter label="Source" values={data.events.map((e) => e.source)}
                    selected={colFilters.source} onChange={(s) => setCol("source", s)} /></span>
              </th>
              <th>Parameters</th>
            </tr></thead>
            <tbody>
              {rows.slice(0, 5000).map((e) => (
                <React.Fragment key={e.idx}>
                  <tr onClick={() => setExpanded(expanded === e.idx ? null : e.idx)} style={{ cursor: "pointer" }}>
                    <td className="nowrap mono">{e.time}</td>
                    <td className={`nowrap sev-${e.severity}`}>{e.severity}</td>
                    <td className="nowrap">{e.node}</td>
                    <td className="mono">{e.event}</td>
                    <td className="nowrap muted">{e.source}</td>
                    <td className="mono"><Highlight text={e.message} q={q} /></td>
                  </tr>
                  {expanded === e.idx && (
                    <tr><td colSpan={6} style={{ background: "var(--panel-2)" }}>
                      <div style={{ fontSize: 12 }}>
                        <div className="muted">event: <b>{e.event_full}</b> · seq {e.seq} · id {e.id} · type {e.type} · status {e.status} · p{e.priority}</div>
                        {Object.entries(e.params).map(([k, v]) => (
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
