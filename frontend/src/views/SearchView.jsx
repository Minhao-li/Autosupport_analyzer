import React, { useEffect, useMemo, useRef } from "react";
import { api } from "../lib/api.js";
import { Highlight, fmtBytes, xmlPairs, SearchHelp, ExpandToggle } from "../lib/helpers.jsx";

// Build a nested directory tree from a list of {path, ...} items, collapsing
// single-child directory chains for compactness.
function buildTree(items) {
  const root = { dirs: new Map(), files: [] };
  for (const it of items) {
    const parts = it.path.split("/");
    const name = parts.pop();
    let node = root;
    for (const p of parts) {
      if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] });
      node = node.dirs.get(p);
    }
    node.files.push({ ...it, name });
  }
  return root;
}

function isXmlPath(p) { return /\.xml(\.gz)?$/i.test(p || ""); }

function HitLine({ hit, path, q, regex }) {
  const pairs = isXmlPath(path) ? xmlPairs(hit.text) : [];
  if (pairs.length) {
    return (
      <div className="mono tree-hit" title={hit.text} style={{ display: "flex", flexWrap: "wrap", gap: "0 12px", alignItems: "baseline" }}>
        <span className="muted">{hit.line}:</span>
        {pairs.map(([k, v], n) => (
          <span key={n}><span className="muted">{k}:</span> <Highlight text={v} q={regex ? "" : q} /></span>
        ))}
      </div>
    );
  }
  return (
    <div className="mono tree-hit">
      <span className="muted">{hit.line}: </span><Highlight text={hit.text} q={regex ? "" : q} />
    </div>
  );
}

function TreeNode({ node, dirPath, depth, collapsed, toggle, onOpen, q, mode }) {
  const dirEntries = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <>
      {dirEntries.map(([name, child]) => {
        let label = name, cur = child, key = (dirPath ? dirPath + "/" : "") + name;
        while (cur.files.length === 0 && cur.dirs.size === 1) {
          const [n2, c2] = [...cur.dirs.entries()][0];
          label += "/" + n2; cur = c2; key += "/" + n2;
        }
        const isCol = collapsed.has(key);
        const count = countFiles(cur);
        return (
          <div key={key} className="tree-block" style={{ marginLeft: depth ? 12 : 0 }}>
            <div className="tree-dir" onClick={() => toggle(key)} title={key}>
              <span className={`tree-chev ${isCol ? "" : "open"}`}>▶</span>
              <span className="tree-dir-name">{label}</span>
              <span className="chip">{count}</span>
            </div>
            {!isCol && (
              <TreeNode node={cur} dirPath={key} depth={depth + 1} collapsed={collapsed}
                toggle={toggle} onOpen={onOpen} q={q} mode={mode} />
            )}
          </div>
        );
      })}
      {node.files.map((f) => (
        <div key={f.path} className="tree-file-block" style={{ marginLeft: (depth + 1) * 12 }}>
          <div className="tree-file" onClick={() => onOpen(f)} title={`Open ${f.path} in its vertical`}>
            <span className="tree-file-name mono">{f.name}</span>
            {mode === "content" && f.hits && <span className="chip">{f.hits.length} hit{f.hits.length > 1 ? "s" : ""}</span>}
            {f.size != null && <span className="muted" style={{ fontSize: 11 }}>{fmtBytes(f.size)}</span>}
            {f.component && <span className="muted" style={{ fontSize: 11 }}>{f.component}</span>}
          </div>
          {mode === "content" && f.hits && (
            <div className="tree-hits">
              {f.hits.slice(0, 50).map((h, j) => (
                <HitLine key={j} hit={h} path={f.path} q={q} regex={f.regex} />
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function countFiles(node) {
  let n = node.files.length;
  for (const c of node.dirs.values()) n += countFiles(c);
  return n;
}
function allDirKeys(node, base) {
  let keys = [];
  for (const [name, child] of node.dirs.entries()) {
    const key = (base ? base + "/" : "") + name;
    keys.push(key);
    keys = keys.concat(allDirKeys(child, key));
  }
  return keys;
}

export default function SearchView({ caseId, state, setState, onOpenFile }) {
  const { q, mode, regex, cs, res, collapsed } = state;
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const timer = useRef(null);
  const upd = (patch) => setState((s) => ({ ...s, ...patch }));

  const run = async (query, m) => {
    if (!query || query.length < 2) { upd({ res: null }); return; }
    setBusy(true); setErr(null);
    try {
      let items, total = 0;
      if (m === "filenames") {
        const r = await api.searchFilenames(caseId, query);
        items = r.results || [];
      } else {
        const r = await api.searchContent(caseId, { q: query, regex, case_sensitive: cs });
        items = (r.results || []).map((x) => ({ ...x, regex }));
        total = r.total;
      }
      upd({ res: { items, total, mode: m }, collapsed: new Set() });
    } catch (e) { setErr(String(e.message || e)); upd({ res: null }); }
    setBusy(false);
  };

  // debounced auto-search on query / mode / options change
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => run(q, mode), 400);
    return () => timer.current && clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, mode, regex, cs, caseId]);

  const tree = useMemo(() => res ? buildTree(res.items) : null, [res]);
  const toggle = (k) => upd({ collapsed: (() => { const n = new Set(collapsed); n.has(k) ? n.delete(k) : n.add(k); return n; })() });
  const expandAll = () => upd({ collapsed: new Set() });
  const collapseAll = () => tree && upd({ collapsed: new Set(allDirKeys(tree, "")) });
  const clear = () => upd({ q: "", res: null, collapsed: new Set() });

  return (
    <div>
      <h2 className="content-title">Global search</h2>
      <p className="content-subtitle">Results stay until you clear them or run a new search · click a file to open it in its vertical.</p>
      <div className="tabs">
        <button className={`tab ${mode === "content" ? "active" : ""}`} onClick={() => upd({ mode: "content" })}>Content</button>
        <button className={`tab ${mode === "filenames" ? "active" : ""}`} onClick={() => upd({ mode: "filenames" })}>File names</button>
      </div>
      <div className="toolbar">
        <input autoFocus placeholder={mode === "filenames" ? "filename keyword…" : (regex ? "search content (regex)…" : "search content…")}
          value={q} onChange={(e) => upd({ q: e.target.value })} style={{ flex: 1, minWidth: 240 }} />
        <SearchHelp regex={mode === "content" && regex} />
        {mode === "content" && <>
          <label className="chip"><input type="checkbox" checked={regex} onChange={(e) => upd({ regex: e.target.checked })} /> regex</label>
          <label className="chip"><input type="checkbox" checked={cs} onChange={(e) => upd({ cs: e.target.checked })} /> Case sensitive</label>
        </>}
        <button className="btn" onClick={clear} disabled={!q && !res}>Clear</button>
        {busy && <span className="info-text"><span className="spin" /> Searching…</span>}
      </div>
      {err && <div className="error-text">{err}</div>}

      {res && (
        <>
          <div className="toolbar">
            <span className="muted">
              {res.items.length} file{res.items.length !== 1 ? "s" : ""}
              {res.mode === "content" ? ` · ${res.total} hits` : ""}
            </span>
            {res.items.length > 0 && <>
              <span style={{ flex: 1 }} />
              <ExpandToggle expanded={collapsed.size === 0}
                onExpandAll={expandAll} onCollapseAll={collapseAll} />
            </>}
          </div>
          {res.items.length === 0 ? <div className="empty-state">No matches.</div> : (
            <div className="tree-wrap">
              <TreeNode node={tree} dirPath="" depth={0} collapsed={collapsed}
                toggle={toggle} onOpen={(f) => onOpenFile(f.path, f.component)} q={q} mode={res.mode} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
