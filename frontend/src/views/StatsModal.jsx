import React, { useMemo } from "react";
import { SEVERITIES } from "../lib/helpers.jsx";

// Reusable statistics panel for any list of event objects.
// props:
//   title    - heading
//   events   - array of event objects
//   dims     - [{ key, label, get?(e) }] dimensions to break down by
//   onClose  - close handler
//   onPick   - optional (dim, value) => void; when provided, severity chips and
//              per-dimension rows become clickable to filter the source list.
// Severity (field "severity") and time (field "ts" epoch, or "time" string)
// are summarised automatically when present.
export default function StatsModal({ title, events, dims, onClose, onPick }) {
  const evs = events || [];

  const sevCounts = useMemo(() => {
    const c = {};
    let any = false;
    for (const e of evs) { if (e.severity) { c[e.severity] = (c[e.severity] || 0) + 1; any = true; } }
    return any ? c : null;
  }, [evs]);

  const dimStats = useMemo(() => dims.map((d) => {
    const get = d.get || ((e) => e[d.key]);
    const map = new Map();
    let withVal = 0;
    for (const e of evs) {
      let v = get(e);
      if (v == null || v === "") continue;
      v = String(v);
      map.set(v, (map.get(v) || 0) + 1);
      withVal += 1;
    }
    const items = [...map.entries()].sort((a, b) => b[1] - a[1]);
    return { ...d, items, distinct: map.size, withVal };
  }), [evs, dims]);

  const time = useMemo(() => {
    const dates = [];
    for (const e of evs) {
      let dt = null;
      const t = e.ts;
      if (t != null && /^\d{9,}$/.test(String(t))) dt = new Date(Number(t) * 1000);
      else if (e.time) { const p = Date.parse(e.time); if (!isNaN(p)) dt = new Date(p); }
      else if (t) { const p = Date.parse(t); if (!isNaN(p)) dt = new Date(p); }
      if (dt && !isNaN(dt)) dates.push(dt);
    }
    if (!dates.length) return null;
    dates.sort((a, b) => a - b);
    const dayKey = (d) => d.toISOString().slice(0, 10);
    const buckets = new Map();
    for (const d of dates) buckets.set(dayKey(d), (buckets.get(dayKey(d)) || 0) + 1);
    return {
      first: dates[0], last: dates[dates.length - 1], n: dates.length,
      buckets: [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    };
  }, [evs]);

  const problem = sevCounts ? (sevCounts.CRIT || 0) + (sevCounts.ERR || 0) + (sevCounts.WARN || 0) : 0;
  const maxBucket = time ? Math.max(...time.buckets.map((b) => b[1])) : 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal priority stats-modal" onClick={(e) => e.stopPropagation()}>
        <div className="toolbar">
          <b style={{ flex: 1 }}>{title} — statistics</b>
          <span className="muted">{evs.length} event(s)</span>
          <button className="icon-btn" onClick={onClose}>Close</button>
        </div>

        {evs.length === 0 ? <div className="empty-state">No events to summarise.</div> : (
          <div className="stats-body">
            {/* Severity + time summary */}
            <div className="stats-summary">
              {sevCounts && (
                <div className="stat-card">
                  <div className="stat-card-title">Severity{problem ? <span className="sev-ERR"> · {problem} need attention</span> : null}</div>
                  <div className="sev-bar">
                    {SEVERITIES.filter((s) => sevCounts[s]).map((s) => (
                      onPick
                        ? <button key={s} className={`chip sev-${s}`} title={`Filter by severity ${s}`}
                            style={{ cursor: "pointer", border: "none" }}
                            onClick={() => onPick({ key: "severity", label: "Severity" }, s)}>{s} {sevCounts[s]}</button>
                        : <span key={s} className={`chip sev-${s}`} title={`${s}: ${sevCounts[s]}`}>{s} {sevCounts[s]}</span>
                    ))}
                  </div>
                </div>
              )}
              {time && (
                <div className="stat-card">
                  <div className="stat-card-title">Time span · {time.n} dated event(s)</div>
                  <div className="muted mono" style={{ fontSize: 11, marginBottom: 6 }}>
                    {time.first.toISOString().replace("T", " ").slice(0, 19)} → {time.last.toISOString().replace("T", " ").slice(0, 19)}
                  </div>
                  <div className="time-hist">
                    {time.buckets.map(([day, n]) => (
                      <div key={day} className="time-col" title={`${day}: ${n}`}>
                        <div className="time-bar" style={{ height: `${Math.max(3, (n / maxBucket) * 46)}px` }} />
                        <div className="time-lbl">{day.slice(5)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Per-dimension breakdowns */}
            <div className="stats-grid">
              {dimStats.map((d) => {
                const max = d.items.length ? d.items[0][1] : 0;
                return (
                  <div className="stat-card" key={d.key}>
                    <div className="stat-card-title">
                      {d.label} <span className="muted">· {d.distinct} distinct</span>
                    </div>
                    {d.items.length === 0 ? (
                      <div className="muted" style={{ fontSize: 12 }}>—</div>
                    ) : (
                      <table className="stat-tbl">
                        <tbody>
                          {d.items.slice(0, 15).map(([val, n]) => (
                            <tr key={val} className={onPick ? "stat-row-pick" : ""}
                              style={onPick ? { cursor: "pointer" } : undefined}
                              title={onPick ? `Filter ${d.label} = ${val}` : undefined}
                              onClick={onPick ? () => onPick(d, val) : undefined}>
                              <td className="stat-name mono" title={val}>{val}</td>
                              <td className="stat-num">{n}</td>
                              <td className="stat-pct muted">{((n / d.withVal) * 100).toFixed(0)}%</td>
                              <td className="stat-barcell">
                                <span className="stat-bar" style={{ width: `${(n / max) * 100}%` }} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {d.items.length > 15 && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>+{d.items.length - 15} more…</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
