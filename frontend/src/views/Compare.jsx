import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { SEVERITIES, fmtBytes, buildCaseTree, collectTreeKeys, collectKeysByKind, countAsup, TREE_ICON, ExpandToggle, asupTypeClass } from "../lib/helpers.jsx";

const baseName = (p) => p.split("/").pop();
const isXmlPath = (p) => /\.xml(\.gz)?$/i.test(p);
const isEmsPath = (p) => /ems[-_]?log[-_]?file/i.test(p);

function labelFor(p) {
  const m = p.match(/autosupport\/([^/]+)/i);
  if (m) return m[1];
  const parts = p.split("/");
  return parts.length > 1 ? parts[parts.length - 2] : p;
}

// A short label for an AutoSupport case (node · type · time).
function asupLabel(c) {
  if (!c) return "case";
  const node = c.node || c.cluster || c.id.slice(0, 6);
  const t = c.generated_on || c.loaded_at || "";
  return `${node}${c.asup_type ? " · " + c.asup_type : ""}${t ? " · " + t : ""}`;
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

// Find the path of the same-named file inside another case, preferring the
// candidate that shares the longest trailing path with the reference file.
async function findSameNamed(targetCaseId, refPath) {
  const base = baseName(refPath);
  const r = await api.searchFilenames(targetCaseId, base).catch(() => ({ results: [] }));
  const cands = (r.results || []).filter((x) => baseName(x.path).toLowerCase() === base.toLowerCase());
  if (!cands.length) return null;
  const refSegs = refPath.toLowerCase().split("/");
  let best = cands[0], bestScore = -1;
  for (const c of cands) {
    const segs = c.path.toLowerCase().split("/");
    let s = 0;
    while (s < segs.length && s < refSegs.length &&
           segs[segs.length - 1 - s] === refSegs[refSegs.length - 1 - s]) s++;
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best.path;
}

export default function CompareControls({ caseId, comp, paths, cases = [] }) {
  const groups = useMemo(() => groupByBase(paths), [paths]);
  const dupGroups = groups.filter((g) => g.files.length >= 2);
  const hasDup = dupGroups.length > 0;

  const [open, setOpen] = useState(false);          // compare modal
  const [items, setItems] = useState(null);         // [{caseId, comp, path, label}]
  const [showPrompt, setShowPrompt] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);  // cross-autosupport picker
  const [dismissedSig, setDismissedSig] = useState(null);
  const sig = paths.slice().sort().join("|");

  const curCase = cases.find((c) => c.id === caseId);

  useEffect(() => {
    if (hasDup && sig !== dismissedSig && !open) setShowPrompt(true);
    if (!hasDup) setShowPrompt(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, hasDup]);

  // Items for same-named files within the current selection.
  const dupItems = () => dupGroups[0].files.map((p) => ({
    caseId, comp, path: p, label: labelFor(p),
  }));

  const startCompare = () => {
    if (hasDup) { setItems(dupItems()); setOpen(true); return; }
    if (paths.length >= 2) {
      setItems(paths.map((p) => ({ caseId, comp, path: p, label: labelFor(p) }))); setOpen(true); return;
    }
    // Exactly one file and nothing to compare with → pick another AutoSupport.
    setPickOpen(true);
  };

  // Resolve same-named files from the chosen cases and open the comparison.
  const compareAcross = async (targetCaseIds) => {
    const ref = paths[0];
    const out = [{
      caseId, comp, path: ref,
      label: asupLabel(curCase) || labelFor(ref),
    }];
    const misses = [];
    for (const tid of targetCaseIds) {
      const found = await findSameNamed(tid, ref);
      const tc = cases.find((c) => c.id === tid);
      if (found) out.push({ caseId: tid, comp: null, path: found, label: asupLabel(tc) });
      else misses.push(asupLabel(tc));
    }
    setPickOpen(false);
    if (out.length < 2) {
      alert(`No file named "${baseName(ref)}" was found in the selected AutoSupport(s).`);
      return;
    }
    setItems(out);
    setOpen(true);
    if (misses.length) setTimeout(() => {}, 0);
  };

  return (
    <>
      <button className="btn" disabled={paths.length < 1} onClick={startCompare}
        title={paths.length === 1 ? "Compare this file against the same file in another AutoSupport" : "Compare selected files"}>
        Compare {paths.length > 1 ? `(${hasDup ? dupGroups[0].files.length : paths.length})` : "↔"}
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
              <button className="btn primary" onClick={() => { setShowPrompt(false); setItems(dupItems()); setOpen(true); }}>Compare</button>
              <button className="btn" onClick={() => { setShowPrompt(false); setDismissedSig(sig); }}>Not now</button>
            </div>
          </div>
        </div>
      )}

      {pickOpen && (
        <AsupPicker base={baseName(paths[0] || "")} refPath={paths[0]}
          cases={cases.filter((c) => c.id !== caseId)}
          onCancel={() => setPickOpen(false)} onCompare={compareAcross} />
      )}

      {open && items && <CompareModal items={items} onClose={() => { setOpen(false); setItems(null); }} />}
    </>
  );
}

// Dialog to choose one or more other AutoSupports (via the same recursive
// case → cluster → node → autosupport tree as History) whose same-named file
// will be auto-selected and compared against the current file.
function AsupPicker({ base, refPath, cases, onCancel, onCompare }) {
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const tree = useMemo(() => buildCaseTree(cases), [cases]);
  const allKeys = useMemo(() => collectTreeKeys(tree), [tree]);
  const defaultKeys = useMemo(() => collectKeysByKind(tree, ["case", "cluster"]), [tree]);
  const [expanded, setExpanded] = useState(() => new Set(defaultKeys));
  const toggleExp = (k) => setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const allOpen = allKeys.length > 0 && allKeys.every((k) => expanded.has(k));
  const toggleCase = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const go = async () => { setBusy(true); await onCompare([...sel]); setBusy(false); };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal priority" style={{ width: "min(560px,94vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="content-toolbar">
          <b style={{ flex: 1 }}>Compare <span className="mono">{base}</span> with another AutoSupport</b>
          <button className="icon-btn" onClick={onCancel}>Close</button>
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Pick the AutoSupport(s) to compare against (case → cluster → node → autosupport).
          The same-named file (<span className="mono">{base}</span>) is selected automatically.
        </p>
        {cases.length === 0 ? <div className="empty-state">No other AutoSupports are loaded.</div> : (
          <>
            <div className="toolbar" style={{ marginBottom: 6 }}>
              <span className="muted" style={{ fontSize: 12, flex: 1 }}>{sel.size} selected</span>
              <ExpandToggle expanded={allOpen}
                onExpandAll={() => setExpanded(new Set(allKeys))}
                onCollapseAll={() => setExpanded(new Set())} />
            </div>
            <div className="case-tree" style={{ maxHeight: "48vh" }}>
              {tree.map((n) => (
                <PickNode key={n.key} node={n} depth={0} expanded={expanded} toggleExp={toggleExp}
                  sel={sel} toggleCase={toggleCase} />
              ))}
            </div>
            <div className="toolbar" style={{ marginTop: 10 }}>
              <button className="btn primary" disabled={!sel.size || busy} onClick={go}>
                {busy ? "Finding & comparing…" : `Compare (${sel.size})`}
              </button>
              <button className="btn" onClick={onCancel}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// One node of the picker tree; leaves are individual AutoSupports (selectable).
function PickNode({ node, depth, expanded, toggleExp, sel, toggleCase }) {
  const open = expanded.has(node.key);
  return (
    <div>
      <div className="case-tree-row" style={{ paddingLeft: depth * 18 + 8 }} onClick={() => toggleExp(node.key)}>
        <span className={`tree-chev ${open ? "open" : ""}`}>▶</span>
        <span className="case-tree-label">{TREE_ICON[node.kind]} {node.label}</span>
        <span className="muted case-tree-count">{countAsup(node)} ASUP</span>
      </div>
      {open && (node.children || []).map((ch) => (
        <PickNode key={ch.key} node={ch} depth={depth + 1} expanded={expanded} toggleExp={toggleExp}
          sel={sel} toggleCase={toggleCase} />
      ))}
      {open && (node.cases || []).map((c) => (
        <label key={c.id} className="case-tree-row leaf" style={{ paddingLeft: (depth + 1) * 18 + 8, cursor: "pointer" }}>
          <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggleCase(c.id)} />
          {c.asup_type && <span className={`chip asup-type ${asupTypeClass(c.asup_type)}`} style={{ minWidth: 70 }}>{c.asup_type}</span>}
          <span className="case-tree-label mono">🕑 {c.generated_on || c.loaded_at || "(unknown time)"}</span>
          <span className="muted case-tree-count">{fmtBytes(c.size_bytes)}</span>
        </label>
      ))}
    </div>
  );
}

function CompareModal({ items, onClose }) {
  const [loaded, setLoaded] = useState(null);
  const [err, setErr] = useState(null);
  const xmlMode = items.every((it) => isXmlPath(it.path));
  const sig = items.map((it) => it.caseId + ":" + it.path).join("|");

  useEffect(() => {
    setLoaded(null); setErr(null);
    const load = async (it) => {
      if (xmlMode) return { label: it.label, path: it.path, data: await api.xmlTable(it.caseId, it.path, it.comp) };
      const data = isEmsPath(it.path)
        ? await api.emsLog(it.caseId, it.path, it.comp)
        : await api.parsePaths(it.caseId, { paths: [it.path] });
      return { label: it.label, path: it.path, data };
    };
    Promise.all(items.map(load))
      .then((r) => setLoaded(uniqueLabels(r)))
      .catch((e) => setErr(String(e.message || e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal priority" style={{ width: "min(1100px,96vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="content-toolbar">
          <b style={{ flex: 1 }}>Compare · {baseName(items[0].path)} · {items.length} files</b>
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
