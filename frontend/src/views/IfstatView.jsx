import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";

// Per-interface error / discard statistics from an IFSTAT counter dump.
export default function IfstatView({ caseId, comp, path }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [sortKey, setSortKey] = useState("total_errors");
  const [asc, setAsc] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [expandAll, setExpandAll] = useState(false);

  useEffect(() => {
    setData(null); setErr(null); setExpanded(null);
    api.ifstat(caseId, path, comp).then((r) => {
      if (!r.ok) setErr(r.error || "Could not parse as IFSTAT.");
      else setData(r);
    }).catch((e) => setErr(String(e.message || e)));
  }, [caseId, comp, path]);

  const rows = useMemo(() => {
    if (!data) return [];
    let r = [...data.interfaces];
    if (onlyProblems) r = r.filter((i) => i.has_problem);
    r.sort((a, b) => {
      const av = a[sortKey] ?? "", bv = b[sortKey] ?? "";
      return (av > bv ? 1 : av < bv ? -1 : 0) * (asc ? 1 : -1);
    });
    return r;
  }, [data, onlyProblems, sortKey, asc]);

  const byIpspace = useMemo(() => {
    const m = {};
    for (const i of data?.interfaces || []) {
      const k = i.ipspace || "—";
      if (!m[k]) m[k] = { count: 0, errors: 0, discards: 0 };
      m[k].count++; m[k].errors += i.total_errors; m[k].discards += i.total_discards;
    }
    return Object.entries(m).sort((a, b) => b[1].count - a[1].count);
  }, [data]);

  const sortBy = (k) => { if (sortKey === k) setAsc(!asc); else { setSortKey(k); setAsc(false); } };
  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString());

  if (err) return <div className="error-text">{err}</div>;
  if (!data) return <div className="info-text"><span className="spin" /> Parsing IFSTAT…</div>;

  const t = data.totals;
  const linkDown = data.interfaces.filter((i) => /no carrier|down/i.test(i.media_state || "")).length;

  return (
    <div>
      {/* Summary cards */}
      <div className="stats-summary" style={{ marginBottom: 10 }}>
        <div className="stat-card">
          <div className="stat-card-title">Interfaces</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{t.interfaces}</div>
          <div className="muted" style={{ fontSize: 12 }}>{linkDown} with no carrier / down</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-title">Errors</div>
          <div style={{ fontSize: 22, fontWeight: 700 }} className={t.total_errors ? "sev-ERR" : ""}>{fmt(t.total_errors)}</div>
          <div className="muted" style={{ fontSize: 12 }}>{t.with_errors} interface(s) affected</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-title">Discards</div>
          <div style={{ fontSize: 22, fontWeight: 700 }} className={t.total_discards ? "sev-WARN" : ""}>{fmt(t.total_discards)}</div>
          <div className="muted" style={{ fontSize: 12 }}>{t.with_discards} interface(s) affected</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-title">By IPSpace</div>
          <table className="stat-tbl"><tbody>
            {byIpspace.map(([k, v]) => (
              <tr key={k}>
                <td className="stat-name">{k}</td>
                <td className="stat-num">{v.count}</td>
                <td className="stat-pct" title="errors / discards">
                  {(v.errors || v.discards)
                    ? <span className="sev-ERR">{fmt(v.errors)}e/{fmt(v.discards)}d</span>
                    : <span className="muted">clean</span>}
                </td>
              </tr>
            ))}
          </tbody></table>
        </div>
      </div>

      <div className="toolbar">
        <b style={{ fontSize: 13 }}>Per-interface counters — all non-zero values</b>
        <label className="chip" title="Show only interfaces with non-zero errors or discards">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Only problems
        </label>
        <button className="btn" onClick={() => setExpandAll((v) => !v)}>
          {expandAll ? "Collapse all" : "Expand all non-zero"}
        </button>
        <span style={{ flex: 1 }} />
        <span className="muted">{rows.length} / {data.count}</span>
      </div>

      {rows.length === 0 ? (
        <div className="empty-state">
          {onlyProblems ? "No interfaces with errors or discards — all clean. 🎉" : "No interfaces."}
        </div>
      ) : (
        <div className="xml-scroll">
          <table className="file-table tbl-horizontal">
            <thead><tr>
              <th onClick={() => sortBy("interface")}>Interface</th>
              <th onClick={() => sortBy("ipspace")}>IPSpace</th>
              <th onClick={() => sortBy("media_state")}>Link</th>
              <th onClick={() => sortBy("rx_errors")} className="num">RX err</th>
              <th onClick={() => sortBy("tx_errors")} className="num">TX err</th>
              <th onClick={() => sortBy("rx_discards")} className="num">RX disc</th>
              <th onClick={() => sortBy("tx_discards")} className="num">TX disc</th>
              <th onClick={() => sortBy("link_up_to_downs")} className="num">Up→Downs</th>
              <th onClick={() => sortBy("rx_total_frames")} className="num">RX frames</th>
              <th onClick={() => sortBy("tx_total_frames")} className="num">TX frames</th>
            </tr></thead>
            <tbody>
              {rows.map((i) => {
                const bad = i.has_problem;
                const down = /no carrier|down/i.test(i.media_state || "");
                const nz = i.nonzero || [];
                const open = expandAll || expanded === i.interface;
                // group non-zero counters by section for the expansion
                const bySection = {};
                for (const c of nz) (bySection[c.section] = bySection[c.section] || []).push(c);
                return (
                  <React.Fragment key={i.interface}>
                    <tr onClick={() => setExpanded(expanded === i.interface ? null : i.interface)}
                      style={{ cursor: "pointer" }}
                      className={bad ? "row-warn" : ""}>
                      <td className="mono">{i.interface}<span className="muted"> {open ? "▾" : "▸"}</span></td>
                      <td className="muted">{i.ipspace || "—"}</td>
                      <td className={down ? "sev-WARN nowrap" : "nowrap"}>{i.media_state || "—"}</td>
                      <td className={`num ${i.rx_errors ? "sev-ERR" : "muted"}`}>{fmt(i.rx_errors)}</td>
                      <td className={`num ${i.tx_errors ? "sev-ERR" : "muted"}`}>{fmt(i.tx_errors)}</td>
                      <td className={`num ${i.rx_discards ? "sev-WARN" : "muted"}`}>{fmt(i.rx_discards)}</td>
                      <td className={`num ${i.tx_discards ? "sev-WARN" : "muted"}`}>{fmt(i.tx_discards)}</td>
                      <td className={`num ${i.link_up_to_downs ? "sev-WARN" : "muted"}`}>{fmt(i.link_up_to_downs)}</td>
                      <td className="num muted">{fmt(i.rx_total_frames)}</td>
                      <td className="num muted">{fmt(i.tx_total_frames)}</td>
                    </tr>
                    {open && (
                      <tr><td colSpan={10} style={{ background: "var(--panel-2)" }}>
                        {nz.length === 0 ? (
                          <span className="muted" style={{ fontSize: 12 }}>All counters are zero.</span>
                        ) : (
                          <div className="ifstat-nz">
                            {["RECEIVE", "TRANSMIT", "DEVICE", "LINK INFO"].filter((s) => bySection[s]).map((s) => (
                              <div className="ifstat-nz-sec" key={s}>
                                <div className="ifstat-nz-title">{s} <span className="muted">({bySection[s].length})</span></div>
                                <div className="ifstat-nz-items">
                                  {bySection[s].map((c) => (
                                    <span key={c.key} className={`ifstat-nz-item ${c.kind}`} title={`${s} · ${c.kind}`}>
                                      <span className="muted">{c.key}</span> = <b>{fmt(c.value)}</b>
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
