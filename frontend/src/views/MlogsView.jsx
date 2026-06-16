import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { fmtBytes } from "../lib/helpers.jsx";

// Mlogs page: surfaces the daemon logs (mroot/etc/log/mlog, or the flattened
// daemon logs inside an AutoSupport) that arrive with a loaded AutoSupport,
// classifies them by log family, lists the organized files (clickable) and
// shows a humanized per-file viewer with severity colouring.
const SEVS = ["CRIT", "ERR", "WARN", "NOTICE", "INFO", "DEBUG"];

function SevBar({ counts }) {
  return (
    <div className="sev-bar" style={{ flexWrap: "nowrap", minWidth: 160 }}>
      {SEVS.map((s) => counts[s] ? (
        <span key={s} className={`sev-${s}`} style={{ fontSize: 11, fontWeight: 700 }}
          title={`${s}: ${counts[s]}`}>{s[0]}{counts[s]}</span>
      ) : null)}
      {!SEVS.some((s) => counts[s]) ? <span className="muted" style={{ fontSize: 11 }}>—</span> : null}
    </div>
  );
}

export default function MlogsView({ caseId, cases = [], onPickCase, pollJob }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [viewer, setViewer] = useState(null); // { path }
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState(null);

  const activeCase = useMemo(() => cases.find((c) => c.id === caseId), [cases, caseId]);

  const load = async () => {
    if (!caseId) return;
    setLoading(true); setErr(null); setData(null); setExpanded(new Set());
    try {
      const r = await api.mlogsAnalyze(caseId);
      setData(r);
      setExpanded(new Set(r.families.filter((f) => f.problems > 0).slice(0, 3).map((f) => f.family)));
    } catch (e) { setErr(String(e.message || e)); }
    setLoading(false);
  };
  useEffect(() => { if (caseId) load(); /* eslint-disable-next-line */ }, [caseId]);

  const toggle = (fam) => setExpanded((s) => { const n = new Set(s); n.has(fam) ? n.delete(fam) : n.add(fam); return n; });

  // Load mlog files from a SEPARATE bundle (.tgz/.zip/.7z) into this case.
  const onLoadArchive = async (file) => {
    if (!file || !caseId) return;
    setImporting(true); setErr(null); setImportMsg(`Uploading ${file.name}…`);
    try {
      const start = await api.mlogsLoad(caseId, file);
      let res = { imported: 0 };
      if (start.job_id && pollJob) {
        res = await pollJob(start.job_id, (j) => setImportMsg(`${j.phase || "Importing…"} ${j.detail || ""}`));
      }
      setImportMsg(`✓ Imported ${res.imported || 0} mlog file(s) from ${file.name}.`);
      await load();
    } catch (e) { setErr(String(e.message || e)); setImportMsg(null); }
    setImporting(false);
  };
  const onLoadFolder = async (fileList) => {
    const files = [...fileList].filter((f) => /(^|\/)mlog\//i.test(f.webkitRelativePath || f.name));
    if (!files.length) { setErr("The selected folder has no mlog/ directory."); return; }
    setImporting(true); setErr(null); setImportMsg(`Uploading ${files.length} mlog file(s)…`);
    try {
      const r = await api.mlogsLoadFolder(caseId, files, files.map((f) => f.webkitRelativePath || f.name));
      setImportMsg(`✓ Imported ${r.imported} mlog file(s).`);
      await load();
    } catch (e) { setErr(String(e.message || e)); setImportMsg(null); }
    setImporting(false);
  };
  const onClear = async () => {
    if (!confirm("Remove imported mlog files for this AutoSupport?")) return;
    try { await api.mlogsClear(caseId); setImportMsg(null); await load(); }
    catch (e) { setErr(String(e.message || e)); }
  };

  if (!caseId) {
    return (
      <div>
        <h2 className="content-title">Mlogs</h2>
        <p className="content-subtitle">Daemon logs (<span className="mono">mgwd</span>, <span className="mono">messages</span>, <span className="mono">secd</span>, <span className="mono">sktrace</span>, …) from a loaded AutoSupport, classified by log family.</p>
        <div className="card">
          <b>Pick an AutoSupport</b>
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
      <p className="content-subtitle">mlog files (<span className="mono">mroot/etc/log/mlog</span>) are loaded automatically when an AutoSupport bundle that contains them is loaded, classified by log family below. You can also add more from a separate bundle.</p>

      <div className="card" style={{ marginBottom: 10 }}>
        <b>Add mlog files (optional)</b>
        <div className="info-text" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          If this AutoSupport was loaded without its mlog folder, upload a node log bundle (<span className="mono">.tgz</span> / <span className="mono">.zip</span> / <span className="mono">.7z</span> containing <span className="mono">mroot/etc/log/mlog/</span>) or pick that folder. Only the mlog subtree is imported.
        </div>
        <div className="toolbar" style={{ flexWrap: "wrap" }}>
          <label className="btn primary">
            {importing ? "Working…" : "Upload mlog bundle"}
            <input type="file" hidden accept=".tgz,.tar.gz,.tar,.7z,.zip,.tbz,.tbz2,.tar.bz2,.txz,.tar.xz"
              disabled={importing}
              onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) onLoadArchive(f); }} />
          </label>
          <label className="btn">
            Pick mlog folder
            <input type="file" hidden webkitdirectory="" directory="" disabled={importing}
              onChange={(e) => { const fs = e.target.files; e.target.value = ""; if (fs && fs.length) onLoadFolder(fs); }} />
          </label>
          {data && data.family_count > 0 && <button className="btn" onClick={onClear} disabled={importing}>Clear imported mlogs</button>}
        </div>
        {importMsg && <div className="info-text" style={{ fontSize: 12, marginTop: 6 }}>{importMsg}</div>}
      </div>

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
          ? <div className="empty-state">No mlog files loaded yet. Upload a log bundle (with <span className="mono">mroot/etc/log/mlog/</span>) above.</div>
          : (
            <>
              <div className="card" style={{ marginBottom: 10 }}>
                <b>Overall severity</b>
                <div style={{ display: "flex", gap: 14, marginTop: 6, flexWrap: "wrap" }}>
                  {SEVS.map((s) => (
                    <span key={s} className={`sev-${s}`} style={{ fontWeight: 700 }}>
                      {s}: {(data.totals[s] || 0).toLocaleString()}
                    </span>
                  ))}
                </div>
              </div>

              <div className="case-tree">
                {data.families.map((f) => (
                  <div key={f.family} className="card" style={{ padding: "8px 12px", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => toggle(f.family)}>
                      <span className={`tree-chev ${expanded.has(f.family) ? "open" : ""}`}>▶</span>
                      <b className="mono" style={{ minWidth: 150 }}>{f.family}</b>
                      {f.problems > 0 && <span className="sev-ERR" style={{ fontSize: 12, fontWeight: 700 }}>● {f.problems} problems</span>}
                      <span className="muted" style={{ fontSize: 12 }}>{f.file_count} file(s) · {f.lines.toLocaleString()} lines · {fmtBytes(f.size)}</span>
                      <div style={{ flex: 1 }} />
                      <SevBar counts={f.counts} />
                    </div>
                    {expanded.has(f.family) && (
                      <div style={{ marginTop: 8, paddingLeft: 26 }}>
                        {f.first_ts && <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>🕑 {f.first_ts} → {f.last_ts}</div>}
                        <table className="file-table" style={{ width: "100%" }}>
                          <thead><tr><th>File</th><th style={{ width: 110 }}>Size</th><th style={{ width: 60 }}></th></tr></thead>
                          <tbody>
                            {f.files.map((file) => (
                              <tr key={file.path} style={{ cursor: "pointer" }}
                                onClick={() => setViewer({ path: file.path })}>
                                <td className="mono" style={{ fontSize: 12 }}>📄 {file.path.split("/").pop()}
                                  <span className="muted" style={{ marginLeft: 8, fontSize: 10 }}>{file.path}</span></td>
                                <td>{fmtBytes(file.size)}</td>
                                <td><button className="icon-btn" onClick={(e) => { e.stopPropagation(); setViewer({ path: file.path }); }}>Open</button></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )
      )}

      {viewer && <MlogFileViewer caseId={caseId} path={viewer.path} onClose={() => setViewer(null)} />}
    </div>
  );
}

// Humanized single-file log viewer: time | severity (colored) | module | message,
// with a severity filter and a text search.
function MlogFileViewer({ caseId, path, onClose }) {
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [offSev, setOffSev] = useState(new Set());
  const [q, setQ] = useState("");

  useEffect(() => {
    setLoading(true); setErr(null); setRes(null);
    api.mlogFile(caseId, path, 8000)
      .then(setRes).catch((e) => setErr(String(e.message || e)))
      .finally(() => setLoading(false));
  }, [caseId, path]);

  const rows = res && res.rows ? res.rows : [];
  const counts = useMemo(() => {
    const c = {}; for (const r of rows) c[r.severity] = (c[r.severity] || 0) + 1; return c;
  }, [rows]);
  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows.filter((r) => !offSev.has(r.severity) &&
      (!ql || (r.message || "").toLowerCase().includes(ql) || (r.module || "").toLowerCase().includes(ql)));
  }, [rows, offSev, q]);

  const toggleSev = (s) => setOffSev((o) => { const n = new Set(o); n.has(s) ? n.delete(s) : n.add(s); return n; });
  const name = path.split("/").pop();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal priority" onClick={(e) => e.stopPropagation()} style={{ width: "min(1100px, 95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div className="toolbar">
          <b style={{ flex: 1 }} className="mono">📄 {name}</b>
          {res && <span className="muted" style={{ fontSize: 12 }}>{res.format} · {res.row_count.toLocaleString()} / {res.total.toLocaleString()} lines{res.truncated ? " (truncated)" : ""}</span>}
          <button className="icon-btn" onClick={onClose}>Close</button>
        </div>
        <div className="toolbar" style={{ flexWrap: "wrap" }}>
          {SEVS.map((s) => (
            <span key={s} className={`sev-toggle sev-${s} ${offSev.has(s) ? "off" : ""}`}
              style={{ fontSize: 12, fontWeight: 700 }} onClick={() => toggleSev(s)}>
              {s} {counts[s] ? `(${counts[s]})` : ""}
            </span>
          ))}
          <input placeholder="filter text…" value={q} onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1, minWidth: 160 }} />
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          {loading && <div className="info-text">Loading…</div>}
          {err && <div className="error-text">{err}</div>}
          {res && (
            res.format === "binary"
              ? <div className="empty-state">Not a readable text log.</div>
              : (
                <table className="file-table mlog-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ width: 160 }}>Time</th>
                      <th style={{ width: 70 }}>Severity</th>
                      <th style={{ width: 160 }}>Module</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r, i) => (
                      <tr key={i}>
                        <td style={{ fontSize: 11, whiteSpace: "nowrap" }} className="mono">{r.time || "—"}</td>
                        <td className={`sev-${r.severity}`} style={{ fontWeight: 700, fontSize: 11 }}>{r.severity}</td>
                        <td className="mono" style={{ fontSize: 11 }}>{r.module || "—"}</td>
                        <td style={{ fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
          )}
          {res && !loading && filtered.length === 0 && <div className="empty-state">No lines match the current filter.</div>}
        </div>
      </div>
    </div>
  );
}
