import React, { useMemo, useState } from "react";
import { SEVERITIES, Highlight, FilterInput, matchKeywordsAny, SearchHelp } from "../lib/helpers.jsx";
import SeverityFilter from "./SeverityFilter.jsx";
import StatsModal from "./StatsModal.jsx";

export default function EventsTable({ events, total, onOpenFile }) {
  const [selSev, setSelSev] = useState(new Set(SEVERITIES));
  const [q, setQ] = useState("");
  const [wrap, setWrap] = useState(false);
  const [onlyReal, setOnlyReal] = useState(true);
  const [sortKey, setSortKey] = useState("idx");
  const [asc, setAsc] = useState(true);
  const [stats, setStats] = useState(false);


  // A "real" event is one that carried a timestamp or an explicit severity
  // keyword — this filters out the noise from XML/stat dumps where every line
  // would otherwise become a default INFO event.
  const isReal = (e) => !!e.ts || e.sev_explicit;
  const base = useMemo(() => {
    const all = (events || []).map((e, i) => ({ ...e, idx: i }));
    return onlyReal ? all.filter(isReal) : all;
  }, [events, onlyReal]);

  // severity histogram (over the current base set)
  const counts = useMemo(() => {
    const c = {};
    for (const e of base) c[e.severity] = (c[e.severity] || 0) + 1;
    return c;
  }, [base]);

  // time span
  const span = useMemo(() => {
    const ts = base.map((e) => e.ts).filter(Boolean).sort();
    return ts.length ? { first: ts[0], last: ts[ts.length - 1] } : null;
  }, [base]);

  const rows = useMemo(() => {
    let r = base.filter((e) => selSev.has(e.severity));
    if (q) {
      r = r.filter((e) => matchKeywordsAny([e.message, e.raw], q));
    }
    r = [...r].sort((a, b) => {
      const av = a[sortKey] ?? "", bv = b[sortKey] ?? "";
      return (av > bv ? 1 : av < bv ? -1 : 0) * (asc ? 1 : -1);
    });
    return r;
  }, [base, selSev, q, sortKey, asc]);

  const sortBy = (k) => { if (sortKey === k) setAsc(!asc); else { setSortKey(k); setAsc(true); } };
  const problem = (counts.CRIT || 0) + (counts.ERR || 0) + (counts.WARN || 0);

  return (
    <div>
      {/* Severity summary — at-a-glance health, click a chip to isolate */}
      <div className="toolbar" style={{ flexWrap: "wrap" }}>
        <b style={{ fontSize: 13 }}>
          {base.length} event{base.length !== 1 ? "s" : ""}
          {problem ? <span className="sev-ERR" style={{ marginLeft: 6 }}>· {problem} need attention</span> : null}
        </b>
        <span className="spacer" style={{ flex: 1 }} />
        {span && <span className="muted" style={{ fontSize: 12 }}>{span.first} → {span.last}</span>}
      </div>
      <div className="toolbar" style={{ flexWrap: "wrap" }}>
        <SeverityFilter selected={selSev} onChange={setSelSev} counts={counts} />
        <span className="spacer" style={{ flex: 1 }} />
        <label className="chip" title="Hide lines without a timestamp or severity (noise from XML/stat dumps)">
          <input type="checkbox" checked={onlyReal} onChange={(e) => setOnlyReal(e.target.checked)} /> Only log events
        </label>
      </div>

      <div className="toolbar">
        <FilterInput placeholder="Filter event text…" value={q} onChange={setQ} wrapStyle={{ minWidth: 240 }} style={{ minWidth: 240 }} />
        <SearchHelp />
        <label className="chip"><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap</label>
        <button className="btn" onClick={() => setStats(true)} title="Show statistics for these events">📊 Statistics</button>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="muted">{rows.length} / {total ?? events?.length ?? 0} shown</span>
      </div>

      {stats && (
        <StatsModal
          title={`Events (${base.length})`}
          events={base}
          dims={[
            { key: "severity", label: "Severity" },
            { key: "file", label: "File", get: (e) => (e.file || "").split("/").pop() },
            { key: "subsystem", label: "Subsystem / source", get: (e) => {
              const m = (e.raw || "").match(/\[([^\]\s:]+)/); return m ? m[1] : null;
            } },
          ]}
          onClose={() => setStats(false)}
        />
      )}

      {rows.length === 0 ? (
        <div className="empty-state">
          {onlyReal && (events || []).length > 0
            ? "No timestamped/severity log events here. Untick \u201cOnly log events\u201d to see raw lines."
            : "No events match."}
        </div>
      ) : (
        <table className="events-table">
          <thead><tr>
            <th onClick={() => sortBy("ts")} className="nowrap">Time</th>
            <th onClick={() => sortBy("severity")}>Sev</th>
            <th onClick={() => sortBy("file")}>File</th>
            <th onClick={() => sortBy("message")}>Message</th>
          </tr></thead>
          <tbody>
            {rows.slice(0, 4000).map((e) => (
              <tr key={e.idx}>
                <td className="nowrap mono">{e.ts || "—"}</td>
                <td className={`nowrap sev-${e.severity}`}>{e.severity}</td>
                <td className="nowrap muted" title={e.file}>
                  {onOpenFile && e.file
                    ? <a style={{ cursor: "pointer" }} onClick={() => onOpenFile(e.file)}>{(e.file || "").split("/").pop()}</a>
                    : (e.file || "").split("/").pop()}
                </td>
                <td className="mono" style={{ whiteSpace: wrap ? "pre-wrap" : "nowrap", maxWidth: wrap ? "none" : 900, overflow: "hidden", textOverflow: "ellipsis" }}>
                  <Highlight text={e.message} q={q} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
