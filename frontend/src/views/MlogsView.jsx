import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";

// Mlogs page: surfaces the mroot/etc/log/mlog daemon logs that arrive with a
// loaded AutoSupport, classifies them by log family (rotation-independent base
// name) and shows a severity/time analysis per family.
const SEVS = ["CRIT", "ERR", "WARN", "NOTICE", "INFO", "DEBUG"];

function SevBar({ counts }) {
  const total = SEVS.reduce((a, s) => a + (counts[s] || 0), 0) || 1;
  return (
    <div className="sev-bar" style={{ flexWrap: "nowrap", minWidth: 160 }}>
      {SEVS.map((s) => counts[s] ? (
        <span key={s} className={`sev-${s}`} style={{ fontSize: 11, fontWeight: 700 }}
          title={`${s}: ${counts[s]}`}>{s[0]}{counts[s]}</span>
      ) : null)}
      {total === 1 && !SEVS.some((s) => counts[s]) ? <span className="muted" style={{ fontSize: 11 }}>—</span> : null}
    </div>
  );
}

export default function MlogsView({ caseId, cases = [], onPickCase }) {
  const [data, setData] = useState(null);     // analyze_all result
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [detail, setDetail] = useState({});   // family -> full analysis (samples)

  const activeCase = useMemo(() => cases.find((c) => c.id === caseId), [cases, caseId]);

  const load = async () => {
    if (!caseId) return;
    setLoading(true); setErr(null); setData(null); setExpanded(new Set()); setDetail({});
    try {
      const r = await api.mlogsAnalyze(caseId);
      setData(r);
    } catch (e) { setErr(String(e.message || e)); }
    setLoading(false);
  };
  useEffect(() => { if (caseId) load(); /* eslint-disable-next-line */ }, [caseId]);

  const toggle = async (fam) => {
    setExpanded((s) => { const n = new Set(s); n.has(fam) ? n.delete(fam) : n.add(fam); return n; });
    if (!detail[fam]) {
      try {
        const r = await api.mlogFamilyAnalyze(caseId, fam);
        setDetail((d) => ({ ...d, [fam]: r }));
      } catch (e) { /* ignore */ }
    }
  };

  if (!caseId) {
    return (
      <div>
        <h2 className="content-title">Mlogs</h2>
        <p className="content-subtitle">Daemon logs from <span className="mono">mroot/etc/log/mlog</span>, classified by log family and analyzed.</p>
        <div className="card">
          <b>Pick an AutoSupport to analyze its mlogs</b>
          {cases.length === 0 ? <div className="empty-state">No AutoSupports loaded.</div> : (
            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8 }}>
              {cases.map((c) => (
                <button key={c.id} className="btn" onClick={() => onPickCase && onPickCase(c.id)}>
                  {c.node || c.case_number || c.id}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="content-title">Mlogs — {activeCase ? (activeCase.node || activeCase.case_number || caseId) : caseId}</h2>
      <p className="content-subtitle">Daemon logs from <span className="mono">mroot/etc/log/mlog</span>, classified by log family and analyzed by severity.</p>

      <div className="toolbar" style={{ marginBottom: 10 }}>
        <button className="btn primary" onClick={load} disabled={loading}>{loading ? "Analyzing…" : "↻ Re-analyze"}</button>
        {data && (
          <span className="muted" style={{ fontSize: 12 }}>
            {data.family_count} families · {data.total_lines.toLocaleString()} lines · {data.total_problems.toLocaleString()} problems (CRIT/ERR/WARN)
          </span>
        )}
      </div>

      {err && <div className="error-text">{err}</div>}
      {loading && <div className="info-text">Analyzing mlog files…</div>}

      {data && !loading && (
        data.family_count === 0
          ? <div className="empty-state">No mlog files found in this AutoSupport (no <span className="mono">mroot/etc/log/mlog</span> directory).</div>
          : (
            <>
              {/* overall severity totals */}
              <div className="card" style={{ marginBottom: 10 }}>
                <b>Overall</b>
                <div style={{ display: "flex", gap: 14, marginTop: 6, flexWrap: "wrap" }}>
                  {SEVS.map((s) => (
                    <span key={s} className={`sev-${s}`} style={{ fontWeight: 700 }}>
                      {s}: {(data.totals[s] || 0).toLocaleString()}
                    </span>
                  ))}
                </div>
              </div>

              <table className="file-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ width: 24 }}></th>
                    <th>Log family</th>
                    <th>Files</th>
                    <th>Lines</th>
                    <th>Severity</th>
                    <th>Time range</th>
                  </tr>
                </thead>
                <tbody>
                  {data.families.map((f) => (
                    <React.Fragment key={f.family}>
                      <tr style={{ cursor: "pointer" }} onClick={() => toggle(f.family)}>
                        <td>{expanded.has(f.family) ? "▾" : "▸"}</td>
                        <td className="mono"><b>{f.family}</b>{f.problems > 0 && <span className="sev-ERR" style={{ marginLeft: 6, fontSize: 11 }}>● {f.problems}</span>}</td>
                        <td>{f.file_count}</td>
                        <td>{f.lines.toLocaleString()}</td>
                        <td><SevBar counts={f.counts} /></td>
                        <td style={{ fontSize: 11 }}>{f.first_ts ? `${f.first_ts} → ${f.last_ts}` : "—"}</td>
                      </tr>
                      {expanded.has(f.family) && (
                        <tr>
                          <td></td>
                          <td colSpan={5}>
                            <FamilyDetail fam={f} det={detail[f.family]} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </>
          )
      )}
    </div>
  );
}

function FamilyDetail({ fam, det }) {
  const d = det || fam;
  const samples = (d && d.samples) || [];
  return (
    <div style={{ padding: "6px 0 10px" }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        {fam.file_count} rotation file(s){d && d.truncated ? " · analysis truncated (very large)" : ""}.
        {samples.length ? ` Showing ${samples.length} notable line(s):` : " No CRIT/ERR/WARN lines."}
      </div>
      {samples.length > 0 && (
        <table className="file-table" style={{ width: "100%" }}>
          <thead><tr><th>Sev</th><th>Time</th><th>Message</th><th>File</th></tr></thead>
          <tbody>
            {samples.map((s, i) => (
              <tr key={i}>
                <td className={`sev-${s.severity}`} style={{ fontWeight: 700 }}>{s.severity}</td>
                <td style={{ fontSize: 11, whiteSpace: "nowrap" }}>{s.time || "—"}</td>
                <td style={{ fontSize: 12 }}>{s.message}</td>
                <td className="mono" style={{ fontSize: 10 }}>{(s.file || "").split("/").pop()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
