import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { SEVERITIES, Highlight, FilterInput, matchKeywordsAny, SearchHelp, ColumnFilter, colMatches } from "../lib/helpers.jsx";
import SeverityFilter from "./SeverityFilter.jsx";
import StatsModal from "./StatsModal.jsx";

export default function MgwdTable({ caseId, comp, path }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [selSev, setSelSev] = useState(new Set(SEVERITIES));
  const [q, setQ] = useState("");
  const [facet, setFacet] = useState(null); // { key, label, value } exact-match filter
  const [expanded, setExpanded] = useState(null);
  const [sortKey, setSortKey] = useState("idx");
  const [asc, setAsc] = useState(true);
  const [stats, setStats] = useState(false);
  const [colFilters, setColFilters] = useState({});
  const setCol = (field, set) => setColFilters((m) => ({ ...m, [field]: set }));

  useEffect(() => {
    setData(null); setErr(null); setExpanded(null); setFacet(null);
    api.mgwdLog(caseId, path, comp).then((r) => {
      if (!r.ok) setErr(r.error || "Could not parse as a daemon (mlog) log.");
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
      r = r.filter((e) => matchKeywordsAny([e.subsystem, e.message, e.module, e.pid, e.thread, e.job], q));
    }
    r.sort((a, b) => {
      const av = a[sortKey] ?? "", bv = b[sortKey] ?? "";
      return (av > bv ? 1 : av < bv ? -1 : 0) * (asc ? 1 : -1);
    });
    return r;
  }, [data, selSev, q, facet, sortKey, asc, colFilters]);

  const sortBy = (k) => { if (sortKey === k) setAsc(!asc); else { setSortKey(k); setAsc(true); } };

  // Apply a click on a statistics item as a filter on the mgwd log.
  const pickStat = (dim, value) => {
    if (dim.key === "severity") setSelSev(new Set([value]));
    else setFacet({ key: dim.key, label: dim.label, value: String(value) });
    setStats(false);
  };

  if (err) return <div className="error-text">{err}</div>;
  if (!data) return <div className="info-text"><span className="spin" /> Parsing mlog…</div>;

  return (
    <div>
      <div className="card" style={{ marginBottom: 10 }}>
        <b>mlog (daemon log)</b>
        <span className="muted" style={{ fontSize: 12 }}>
          {" "}· {data.total} records{data.truncated ? ` (showing first ${data.row_count})` : ""}
        </span>
      </div>
      <div className="toolbar">
        <FilterInput placeholder="Filter subsystem / message / pid / thread…" value={q}
          onChange={setQ} wrapStyle={{ minWidth: 280 }} style={{ minWidth: 280 }} />
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
        <button className="btn" onClick={() => setStats(true)} title="Show statistics for these mgwd events">📊 Statistics</button>
        <span style={{ flex: 1 }} />
        <span className="muted">{rows.length} / {data.row_count}</span>
      </div>

      {stats && (
        <StatsModal
          title={`mlog${data.truncated ? ` (first ${data.row_count} of ${data.total})` : ""}`}
          events={data.events}
          dims={[
            { key: "severity", label: "Severity" },
            { key: "level", label: "Level" },
            { key: "subsystem", label: "Subsystem" },
            { key: "module", label: "Module" },
            { key: "facility", label: "Facility" },
            { key: "pid", label: "PID" },
            { key: "job", label: "Job / session" },
            { key: "thread", label: "Thread" },
          ]}
          onClose={() => setStats(false)}
          onPick={pickStat}
        />
      )}

      {rows.length === 0 ? <div className="empty-state">No mgwd events match.</div> : (
        <div className="xml-scroll">
          <table className="file-table tbl-horizontal">
            <thead><tr>
              <th onClick={() => sortBy("ts")} className="nowrap">Time</th>
              <th onClick={() => sortBy("severity")}>Sev</th>
              <th onClick={() => sortBy("subsystem")}>
                <span className="th-flex">Subsystem
                  <ColumnFilter label="Subsystem" values={data.events.map((e) => e.subsystem)}
                    selected={colFilters.subsystem} onChange={(s) => setCol("subsystem", s)} /></span>
              </th>
              <th onClick={() => sortBy("pid")}>
                <span className="th-flex">PID
                  <ColumnFilter label="PID" values={data.events.map((e) => e.pid)}
                    selected={colFilters.pid} onChange={(s) => setCol("pid", s)} /></span>
              </th>
              <th>Message</th>
            </tr></thead>
            <tbody>
              {rows.slice(0, 5000).map((e) => (
                <React.Fragment key={e.idx}>
                  <tr onClick={() => setExpanded(expanded === e.idx ? null : e.idx)} style={{ cursor: "pointer" }}>
                    <td className="nowrap mono">{e.time}</td>
                    <td className={`nowrap sev-${e.severity}`}>{e.severity}</td>
                    <td className="nowrap mono">{e.subsystem || "—"}</td>
                    <td className="nowrap muted">{e.pid}</td>
                    <td className="mono"><Highlight text={e.detail} q={q} /></td>
                  </tr>
                  {expanded === e.idx && (
                    <tr><td colSpan={5} style={{ background: "var(--panel-2)" }}>
                      <div style={{ fontSize: 12 }}>
                        <div className="muted">seq {e.seq} · {e.module}:{e.facility} · pid {e.pid} · thread {e.thread}{e.job ? ` · job ${e.job}` : ""} · level {e.level}</div>
                        <div className="mono" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{e.message}</div>
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
