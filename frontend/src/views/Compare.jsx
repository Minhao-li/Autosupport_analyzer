import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { SEVERITIES } from "../lib/helpers.jsx";

const baseName = (p) => p.split("/").pop();
const isXmlPath = (p) => /\.xml(\.gz)?$/i.test(p);
const isEmsPath = (p) => /ems[-_]?log[-_]?file/i.test(p);

function labelFor(p) {
  const m = p.match(/autosupport\/([^/]+)/i);
  if (m) return m[1];
  const parts = p.split("/");
  return parts.length > 1 ? parts[parts.length - 2] : p;
}

function groupByBase(paths) {
  const map = new Map();
  for (const p of paths) {
    const b = baseName(p);
    if (!map.has(b)) map.set(b, []);
    map.get(b).push(p);
  }
  return [...map.entries()].map(([base, files]) => ({ base, files }));
}

export default function CompareControls({ caseId, comp, paths }) {
  const groups = useMemo(() => groupByBase(paths), [paths]);
  const dupGroups = groups.filter((g) => g.files.length >= 2);
  const hasDup = dupGroups.length > 0;
  const target = dupGroups.length ? dupGroups[0].files : paths;

  const [open, setOpen] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [dismissedSig, setDismissedSig] = useState(null);
  const sig = paths.slice().sort().join("|");

  useEffect(() => {
    if (hasDup && sig !== dismissedSig && !open) setShowPrompt(true);
    if (!hasDup) setShowPrompt(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, hasDup]);

  return (
    <>
      <button className="btn" disabled={paths.length < 2} onClick={() => setOpen(true)}>
        Compare ({dupGroups.length ? dupGroups[0].files.length : paths.length})
      </button>

      {showPrompt && (
        <div className="modal-backdrop" onClick={() => { setShowPrompt(false); setDismissedSig(sig); }}>
          <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
            <b>Compare same-named files?</b>
            <p className="muted" style={{ fontSize: 13 }}>
              {dupGroups[0].files.length} selected files are named <b className="mono">{dupGroups[0].base}</b>.
              Load and compare them?
            </p>
            <div className="toolbar">
              <button className="btn primary" onClick={() => { setShowPrompt(false); setOpen(true); }}>Compare</button>
              <button className="btn" onClick={() => { setShowPrompt(false); setDismissedSig(sig); }}>Not now</button>
            </div>
          </div>
        </div>
      )}

      {open && <CompareModal caseId={caseId} comp={comp} paths={target} onClose={() => setOpen(false)} />}
    </>
  );
}

function CompareModal({ caseId, comp, paths, onClose }) {
  const [loaded, setLoaded] = useState(null);
  const [err, setErr] = useState(null);
  const xmlMode = paths.every(isXmlPath);

  useEffect(() => {
    setLoaded(null); setErr(null);
    const load = async (p) => {
      if (xmlMode) return { label: labelFor(p), path: p, data: await api.xmlTable(caseId, p, comp) };
      const data = isEmsPath(p)
        ? await api.emsLog(caseId, p, comp)
        : await api.parsePaths(caseId, { paths: [p] });
      return { label: labelFor(p), path: p, data };
    };
    Promise.all(paths.map(load))
      .then((r) => setLoaded(uniqueLabels(r)))
      .catch((e) => setErr(String(e.message || e)));
  }, [caseId, comp, paths.join("|")]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal priority" style={{ width: "min(1100px,96vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="content-toolbar">
          <b style={{ flex: 1 }}>Compare · {baseName(paths[0])} · {paths.length} files</b>
          <button className="icon-btn" onClick={onClose}>Close</button>
        </div>
        {err && <div className="error-text">{err}</div>}
        {!loaded && !err && <div className="info-text"><span className="spin" /> Loading & comparing…</div>}
        {loaded && (xmlMode ? <TableCompare files={loaded} /> : <EventCompare files={loaded} />)}
      </div>
    </div>
  );
}

function uniqueLabels(arr) {
  const seen = {};
  return arr.map((f) => {
    let l = f.label;
    if (seen[l] != null) { seen[l]++; l = `${l} (${seen[l]})`; } else seen[l] = 0;
    return { ...f, label: l };
  });
}

const asStr = (v) => Array.isArray(v) ? v.join(", ") : (v == null ? "" : String(v));

function TableCompare({ files }) {
  const ok = files.filter((f) => f.data && f.data.ok);
  if (ok.length < 2) return <div className="empty-state">Could not parse these files as tables.</div>;

  // union of columns (tag -> ui_name)
  const tags = [];
  const ui = {};
  for (const f of ok) {
    for (const c of f.data.columns) {
      if (!(c.tag in ui)) { tags.push(c.tag); ui[c.tag] = c.ui_name || c.tag; }
    }
  }
  const cellVal = (f, tag) => {
    const rows = f.data.rows || [];
    if (rows.length === 0) return "";
    if (rows.length === 1) return asStr(rows[0][tag]);
    return `(${rows.length} rows)`;
  };

  const rowCounts = ok.map((f) => f.data.total_rows);
  const countsDiffer = new Set(rowCounts).size > 1;

  return (
    <div>
      <div className="info-text" style={{ marginBottom: 8 }}>
        Differences are highlighted. {ok.length} files · {tags.length} fields.
      </div>
      <div className="xml-scroll" style={{ maxHeight: "70vh" }}>
        <table className="file-table tbl-vertical">
          <thead><tr>
            <th className="vt-field-head">Field</th>
            {ok.map((f) => <th key={f.path} title={f.path}>{f.label}</th>)}
          </tr></thead>
          <tbody>
            <tr className={countsDiffer ? "diff-row" : ""}>
              <td className="vt-field">(row count)</td>
              {ok.map((f, i) => (
                <td key={f.path} className={countsDiffer && rowCounts[i] !== rowCounts[0] ? "diff-cell" : ""}>{rowCounts[i]}</td>
              ))}
            </tr>
            {tags.map((tag) => {
              const vals = ok.map((f) => cellVal(f, tag));
              const differ = new Set(vals).size > 1;
              return (
                <tr key={tag} className={differ ? "diff-row" : ""}>
                  <td className="vt-field" title={tag}>{ui[tag]}</td>
                  {vals.map((v, i) => (
                    <td key={i} className={`mono ${differ && v !== vals[0] ? "diff-cell" : ""}`}>{v || <span className="muted">—</span>}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EventCompare({ files }) {
  // severity counts per file
  const stats = files.map((f) => {
    const events = (f.data && f.data.events) || [];
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    const errKeys = {};
    for (const e of events) {
      counts[e.severity] = (counts[e.severity] || 0) + 1;
      if (e.severity === "ERR" || e.severity === "CRIT") {
        const k = e.event || (e.message || "").slice(0, 60) || "(error)";
        errKeys[k] = (errKeys[k] || 0) + 1;
      }
    }
    return { label: f.label, path: f.path, total: events.length, counts, errKeys };
  });

  const rows = [...SEVERITIES, "Total"];
  const valOf = (st, sev) => sev === "Total" ? st.total : st.counts[sev];

  // top error signatures across files
  const allErr = {};
  for (const st of stats) for (const [k, n] of Object.entries(st.errKeys)) allErr[k] = (allErr[k] || 0) + n;
  const topErr = Object.keys(allErr).sort((a, b) => allErr[b] - allErr[a]).slice(0, 20);

  return (
    <div>
      <div className="info-text" style={{ marginBottom: 8 }}>Severity statistics compared across {files.length} files (differences highlighted).</div>
      <div className="xml-scroll" style={{ maxHeight: "40vh" }}>
        <table className="file-table tbl-vertical">
          <thead><tr>
            <th className="vt-field-head">Severity</th>
            {stats.map((s) => <th key={s.path} title={s.path}>{s.label}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((sev) => {
              const vals = stats.map((s) => valOf(s, sev));
              const differ = new Set(vals).size > 1;
              return (
                <tr key={sev} className={differ ? "diff-row" : ""}>
                  <td className={`vt-field sev-${sev}`}>{sev}</td>
                  {vals.map((v, i) => (
                    <td key={i} className={differ && v !== vals[0] ? "diff-cell" : ""}>{v}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {topErr.length > 0 && (
        <>
          <h4 style={{ margin: "14px 0 6px" }}>Top error / critical events</h4>
          <div className="xml-scroll" style={{ maxHeight: "34vh" }}>
            <table className="file-table tbl-vertical">
              <thead><tr>
                <th className="vt-field-head">Event / message</th>
                {stats.map((s) => <th key={s.path}>{s.label}</th>)}
              </tr></thead>
              <tbody>
                {topErr.map((k) => {
                  const vals = stats.map((s) => s.errKeys[k] || 0);
                  const differ = new Set(vals).size > 1;
                  return (
                    <tr key={k} className={differ ? "diff-row" : ""}>
                      <td className="vt-field mono" title={k}>{k}</td>
                      {vals.map((v, i) => (
                        <td key={i} className={differ && v !== vals[0] ? "diff-cell" : ""}>{v}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
