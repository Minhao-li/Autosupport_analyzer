import React, { useEffect, useMemo, useState } from "react";
import { api } from "./lib/api.js";
import { fmtBytes, verticalColor as vColor, caseLabel, ExpandToggle, buildCaseTree, countAsup, collectTreeKeys, collectKeysByKind, asupTypeClass, TREE_ICON as SHARED_TREE_ICON } from "./lib/helpers.jsx";
import Login from "./views/Login.jsx";
import ComponentView from "./views/ComponentView.jsx";
import SearchView from "./views/SearchView.jsx";
import SnapshotView from "./views/SnapshotView.jsx";
import TopologyView from "./views/TopologyView.jsx";
import ClusterTopologyView from "./views/ClusterTopologyView.jsx";
import ClusterView from "./views/ClusterView.jsx";
import AsupView from "./views/AsupView.jsx";
import AsupDownloadView from "./views/AsupDownloadView.jsx";
import AutoSupportView from "./views/AutoSupportView.jsx";
import AdminView from "./views/AdminView.jsx";
import FeedbackModal from "./views/FeedbackModal.jsx";

const APP_VERSION = "0.2.0";

const THEMES = [
  { key: "dark", label: "Dark", desc: "Default dark", bg: "#0f1320", accent: "#00e0ff" },
  { key: "light", label: "Light", desc: "Bright, indigo accent", bg: "#ffffff", accent: "#4f46e5" },
  { key: "solarized", label: "Solarized Dark", desc: "Solarized palette", bg: "#002b36", accent: "#268bd2" },
  { key: "sepia", label: "Sepia", desc: "Warm paper tones", bg: "#f4ecd8", accent: "#b5651d" },
];

const TOP_PAGES = [
  { key: "clusters", label: "Cluster Topology" },
  { key: "search", label: "Global search" },
  { key: "topology", label: "Network Topology" },
  { key: "asup", label: "ASUP Upload" },
  { key: "asupdl", label: "ASUP Download" },
];

export default function App() {
  const [me, setMe] = useState(undefined); // undefined=loading, null=not authed
  const [plugins, setPlugins] = useState([]);
  const [cases, setCases] = useState([]);
  const [caseId, setCaseId] = useState(null);
  const [view, setView] = useState({ kind: "home" });
  const [theme, setTheme] = useState(localStorage.getItem("sla-theme") || "light");
  const [themeOpen, setThemeOpen] = useState(false);
  const [feedback, setFeedback] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [quota, setQuota] = useState(null);
  const [expandedVerticals, setExpandedVerticals] = useState(new Set());
  const [vFilter, setVFilter] = useState("");
  const [fileIndex, setFileIndex] = useState({});
  const [search, setSearch] = useState({ q: "", mode: "content", regex: false, cs: false, res: null, collapsed: new Set() });
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState(null);
  const [showLogin, setShowLogin] = useState(false);
  const [progress, setProgress] = useState(null); // {phase, detail, done, total, label}

  // Poll a background load job until it finishes, reporting progress.
  const pollJob = async (jobId, onTick) => {
    for (;;) {
      const j = await api.jobStatus(jobId);
      if (onTick) onTick(j);
      if (j.status === "done") return j.result;
      if (j.status === "error") throw new Error(j.error || "Load failed");
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  useEffect(() => { api.me().then(setMe).catch(() => setMe(null)); }, []);
  useEffect(() => {
    if (!me) return;
    api.plugins().then(setPlugins).catch(() => {});
    refreshCases();
    api.quota().then(setQuota).catch(() => {});
  }, [me]);

  useEffect(() => {
    setFileIndex({});
    setSearch({ q: "", mode: "content", regex: false, cs: false, res: null, collapsed: new Set() });
    if (caseId) api.componentIndex(caseId).then((r) => setFileIndex(r.index || {})).catch(() => {});
  }, [caseId]);

  // component key -> { name, vertical } for navigating from search results
  const compMeta = useMemo(() => {
    const m = {};
    for (const v of plugins) for (const c of v.components) m[c.component] = { name: c.display_name, vertical: v.vertical };
    return m;
  }, [plugins]);

  const openComponentFile = (path, compKey) => {
    const meta = compMeta[compKey] || {};
    const base = (path || "").split("/").pop();
    setView({ kind: "component", comp: compKey, name: meta.name || compKey, vertical: meta.vertical || "misc", q: base });
  };

  const refreshCases = () => api.cases().then((r) => setCases(r.cases)).catch(() => {});

  const applyTheme = (t) => {
    setTheme(t); setThemeOpen(false);
    localStorage.setItem("sla-theme", t);
    if (t === "dark") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
  };

  // Load many cases at once. Each group becomes its own case (one per dropped
  // folder / archive), uploaded concurrently — the backend isolates each by a
  // unique case id so they don't conflict. Typically used to load several
  // nodes' AutoSupports from the same cluster in one shot.
  const onLoadGroups = async (groups, caseNumber) => {
    if (!groups || !groups.length) return;
    if (!caseNumber || !caseNumber.trim()) { setErr("Case number is required to load a package."); return; }
    setUploading(true); setErr(null);
    const cn = caseNumber.trim();
    const createdCases = [];
    const failed = [];
    // Process sequentially so the progress bar reflects one job at a time.
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const tag = groups.length > 1 ? ` (${i + 1}/${groups.length})` : "";
      try {
        setProgress({ phase: "Uploading…", detail: g.label, label: g.label + tag, done: 0, total: 0 });
        const start = g.type === "archive"
          ? await api.createCase(g.file, cn)
          : await api.createCaseFolder(g.files, cn, "local", g.paths);
        const result = await pollJob(start.job_id, (j) =>
          setProgress({ phase: j.phase, detail: j.detail, done: j.done, total: j.total, label: g.label + tag }));
        if (result && result.multi && Array.isArray(result.cases)) createdCases.push(...result.cases);
        else if (result && result.id) createdCases.push(result);
      } catch (e) {
        failed.push({ label: g.label, reason: e });
      }
    }
    setProgress(null);
    await refreshCases();
    if (createdCases.length) setCaseId(createdCases[createdCases.length - 1].id);
    setView({ kind: createdCases.length > 1 ? "clusters" : "home" });
    if (failed.length) {
      setErr(`Loaded ${createdCases.length} case(s). Failed: ` +
        failed.map((f) => `${f.label} (${String((f.reason && f.reason.message) || f.reason)})`).join("; "));
    }
    setUploading(false);
  };

  const onUpload = (file, caseNumber) =>
    onLoadGroups([{ type: "archive", label: file.name, file }], caseNumber);

  // Load case(s) from selected items on the server-side exports share.
  const onLoadStingray = async (caseNumber, paths) => {
    const cn = (caseNumber || "").trim();
    if (!cn) { setErr("Case number is required to load from server exports."); return; }
    if (!paths || !paths.length) { setErr("Select at least one file or folder to load."); return; }
    setUploading(true); setErr(null);
    setProgress({ phase: "Starting…", detail: "", label: "Server exports", done: 0, total: 0 });
    try {
      const start = await api.stingrayLoad(cn, paths);
      const result = await pollJob(start.job_id, (j) =>
        setProgress({ phase: j.phase, detail: j.detail, done: j.done, total: j.total, label: "Server exports" }));
      await refreshCases();
      const created = (result && result.multi && Array.isArray(result.cases)) ? result.cases : (result && result.id ? [result] : []);
      if (created.length) setCaseId(created[created.length - 1].id);
      setView({ kind: created.length > 1 ? "clusters" : "home" });
    } catch (e) {
      setErr("Load from server failed: " + (e && e.message ? e.message : String(e)));
    }
    setProgress(null);
    setUploading(false);
  };

  const onDelete = async (id) => {
    if (!confirm("Delete this case?")) return;
    try { await api.deleteCase(id); if (caseId === id) setCaseId(null); refreshCases(); }
    catch (e) { setErr(String(e.message || e)); }
  };

  const onDeleteAll = async () => {
    if (!cases.length) return;
    if (!confirm(`Delete ALL ${cases.length} AutoSupport(s)? This cannot be undone.`)) return;
    try { await api.deleteAllCases(); setCaseId(null); await refreshCases(); }
    catch (e) { setErr(String(e.message || e)); }
  };

  const logout = async () => { await api.logout().catch(() => {}); setMe(null); };

  const activeCase = useMemo(() => cases.find((c) => c.id === caseId), [cases, caseId]);
  const pageContext = view.kind === "component" ? `${view.comp}` : view.kind;

  if (me === undefined) return <div className="login-wrap"><span className="spin" /></div>;
  // Regular users don't sign in — they browse as an anonymous "Guest". Only the
  // admin authenticates (via the header "Admin login" button) to unlock the
  // admin-gated actions.
  const account = me || { username: "Guest", is_admin: false };

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 style={{ cursor: "pointer" }} title="Go to home (load a package)"
          onClick={() => { setCaseId(null); setView({ kind: "home" }); }}>Autosupport Analyzer
          <span className="app-version">v{APP_VERSION}</span></h1>
        <CasePicker cases={cases} caseId={caseId}
          onPick={(id) => { setCaseId(id || null); setView({ kind: "home" }); }} />
        <button className="btn" onClick={() => setHistoryOpen(true)}>History</button>
        <label className="btn">
          {uploading ? "Uploading…" : "Upload archive(s)"}
          <input type="file" hidden multiple accept=".zip,.tgz,.tar.gz,.tar,.7z,.tbz,.tbz2,.tar.bz2,.txz,.tar.xz"
            onChange={(e) => {
              const fs = [...e.target.files];
              if (fs.length) {
                const cn = window.prompt(`Case number for ${fs.length} upload(s):`);
                if (cn && cn.trim()) onLoadGroups(fs.map((f) => ({ type: "archive", label: f.name, file: f })), cn);
              }
              e.target.value = "";
            }} />
        </label>
        <div className="spacer" style={{ flex: 1 }} />
        {quota && <span className="muted" style={{ fontSize: 12 }}>{quota.used_gb} / {quota.max_gb} GB</span>}
        <button className="icon-btn" onClick={() => setFeedback(true)}>Feedback</button>
        <div style={{ position: "relative" }}>
          <button className="icon-btn" title="Theme" aria-label="Theme" onClick={() => setThemeOpen((v) => !v)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
              <circle cx="13.5" cy="6.5" r="1.3" fill="currentColor" stroke="none" />
              <circle cx="17" cy="10.5" r="1.3" fill="currentColor" stroke="none" />
              <circle cx="8" cy="7" r="1.3" fill="currentColor" stroke="none" />
              <circle cx="6.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
              <path d="M12 3c-5 0-9 3.6-9 8.2 0 3.8 2.9 6.8 6.6 6.8.9 0 1.7-.7 1.7-1.7 0-.45-.18-.83-.45-1.13-.27-.33-.45-.74-.45-1.2 0-.95.78-1.7 1.74-1.7H14c3.9 0 6-2.4 6-6C20 6 16.4 3 12 3z" />
            </svg>
          </button>
          {themeOpen && (
            <>
              <div onClick={() => setThemeOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 39 }} />
              <div className="theme-menu">
                <div className="theme-head">Theme</div>
                {THEMES.map((t) => (
                  <div key={t.key} className={`theme-option ${theme === t.key ? "active" : ""}`} onClick={() => applyTheme(t.key)}>
                    <span className="theme-swatch" style={{ background: t.bg }}>
                      <span style={{ background: t.accent }} />
                    </span>
                    <span className="theme-labels">
                      <span className="theme-name">{t.label}</span>
                      <span className="theme-desc">{t.desc}</span>
                    </span>
                    {theme === t.key && <span className="theme-check">✓</span>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <span className="muted" style={{ fontSize: 12 }}>{account.username}{account.is_admin ? " (admin)" : ""}</span>
        {account.is_admin
          ? <button className="icon-btn" onClick={logout}>Sign out admin</button>
          : <button className="icon-btn" onClick={() => setShowLogin(true)}>Admin login</button>}
      </header>

      <div className="app-main">
        <aside className="app-sidebar">
          <div className="sidebar-vertical">Top-level pages</div>
          {TOP_PAGES.map((p) => (
            <div key={p.key} className={`sidebar-item ${view.kind === p.key ? "active" : ""}`}
              onClick={() => setView({ kind: p.key })}>{p.label}</div>
          ))}
          {account.is_admin && (
            <div className={`sidebar-item ${view.kind === "admin" ? "active" : ""}`}
              onClick={() => setView({ kind: "admin" })}>Admin (gated)</div>
          )}
          <div className={`sidebar-item ${view.kind === "autosupport" ? "active" : ""}`}
            onClick={() => caseId && setView({ kind: "autosupport" })}
            style={{ opacity: caseId ? 1 : 0.5, cursor: caseId ? "pointer" : "not-allowed" }}>
            AutoSupport
          </div>

          <div className="sidebar-vertical list-controls" style={{ marginTop: 12 }}>
            <span style={{ flex: 1 }}>Verticals</span>
            <ExpandToggle expanded={plugins.length > 0 && plugins.every((v) => expandedVerticals.has(v.vertical))}
              onExpandAll={() => setExpandedVerticals(new Set(plugins.map((v) => v.vertical)))}
              onCollapseAll={() => setExpandedVerticals(new Set())} />
          </div>
          <div style={{ padding: "0 8px 6px" }}>
            <div className="vfilter-wrap">
              <input className="vfilter" placeholder="Filter by component or log file name…"
                value={vFilter} onChange={(e) => setVFilter(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setVFilter("")} />
              {vFilter && (
                <button className="vfilter-clear" title="Clear filter (Esc)"
                  onClick={() => setVFilter("")}>✕</button>
              )}
            </div>
          </div>
          <div className={`sidebar-item ${view.kind === "snapshot" ? "active" : ""}`}
            onClick={() => caseId && setView({ kind: "snapshot" })}
            style={{ opacity: caseId ? 1 : 0.5, cursor: caseId ? "pointer" : "not-allowed" }}>
            Snapshot
          </div>
          {plugins.map((v) => {
            const ql = vFilter.trim().toLowerCase();
            const compHasFile = (ckey) => (fileIndex[ckey] || []).some((n) => n.includes(ql));
            const vMatch = ql && v.display_name.toLowerCase().includes(ql);
            let comps = v.components.filter((c) => c.component !== "autosupport");
            if (ql && !vMatch) {
              comps = comps.filter((c) =>
                c.display_name.toLowerCase().includes(ql) ||
                c.component.toLowerCase().includes(ql) ||
                compHasFile(c.component));
            }
            if (ql && comps.length === 0) return null;
            const isExpanded = ql ? true : expandedVerticals.has(v.vertical);
            const toggle = () => setExpandedVerticals((s) => {
              const n = new Set(s); n.has(v.vertical) ? n.delete(v.vertical) : n.add(v.vertical); return n;
            });
            return (
              <div className="sidebar-group" key={v.vertical}>
                <div className="sidebar-vertical sidebar-vertical-toggle" onClick={toggle}>
                  <span className={`tree-chev ${isExpanded ? "open" : ""}`}>▶</span>
                  <span className="vdot" style={{ background: vColor(v.vertical) }} />
                  <span style={{ flex: 1 }}>{v.display_name}</span>
                  <span className="chip">{comps.length}</span>
                </div>
                {isExpanded && comps.map((c) => {
                  const matchCount = ql ? (fileIndex[c.component] || []).filter((n) => n.includes(ql)).length : 0;
                  return (
                    <div key={c.component}
                      className={`sidebar-item ${view.kind === "component" && view.comp === c.component ? "active" : ""}`}
                      onClick={() => caseId && setView({ kind: "component", comp: c.component, name: c.display_name, vertical: v.vertical, q: ql && matchCount ? vFilter.trim() : "" })}
                      style={{ opacity: caseId ? 1 : 0.5, cursor: caseId ? "pointer" : "not-allowed" }}>
                      <span>{c.display_name}</span>
                      <span className="chip" title={ql && matchCount ? `${matchCount} file(s) match "${vFilter.trim()}"` : "patterns"}>
                        {ql && matchCount ? `${matchCount} match` : c.patterns}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </aside>

        <main className="app-content">
          {err && <div className="error-text" style={{ marginBottom: 8 }}>{err}</div>}

          {view.kind === "home" && (
            activeCase ? <CaseHome c={activeCase} isAdmin={account.is_admin} onDelete={onDelete} onRefresh={refreshCases} />
              : <Dropzone onLoadGroups={onLoadGroups} onLoadStingray={onLoadStingray} uploading={uploading} cases={cases} onPick={setCaseId} onDelete={onDelete} isAdmin={account.is_admin} />
          )}
          {view.kind === "component" && (caseId
            ? <ComponentView caseId={caseId} comp={view.comp} compName={view.name} vertical={view.vertical} initialFilter={view.q || ""} cases={cases} key={caseId + view.comp + (view.q || "")} />
            : <div className="empty-state">Load a case first.</div>)}
          {view.kind === "clusters" && <ClusterTopologyView
            onOpenCase={(id) => { setCaseId(id); setView({ kind: "home" }); }}
            onOpenCluster={(key, name) => setView({ kind: "cluster", clusterKey: key, clusterName: name })}
            key="clusters" />}
          {view.kind === "cluster" && <ClusterView clusterKey={view.clusterKey} clusterName={view.clusterName} key={view.clusterKey} />}
          {view.kind === "search" && (caseId ? <SearchView caseId={caseId} state={search} setState={setSearch} onOpenFile={openComponentFile} key={caseId} /> : <NeedCase />)}
          {view.kind === "snapshot" && (caseId ? <SnapshotView caseId={caseId} key={caseId} /> : <NeedCase />)}
          {view.kind === "topology" && <TopologyView activeCase={activeCase} key="topology" />}
          {view.kind === "asup" && <AsupView caseId={caseId} cases={cases} isAdmin={account.is_admin} onPickCase={setCaseId} key={caseId || "none"} />}
          {view.kind === "asupdl" && <AsupDownloadView pollJob={pollJob}
            onLoaded={(created) => { refreshCases(); if (created && created.length) { setCaseId(created[created.length - 1].id); setView({ kind: created.length > 1 ? "clusters" : "home" }); } }} />}
          {view.kind === "autosupport" && (caseId ? <AutoSupportView caseId={caseId} cases={cases} key={caseId} /> : <NeedCase />)}
          {view.kind === "admin" && account.is_admin && <AdminView plugins={plugins} />}
        </main>
      </div>

      {feedback && <FeedbackModal pageContext={pageContext} onClose={() => setFeedback(false)} />}
      {progress && <LoadProgress {...progress} />}
      {showLogin && !account.is_admin && (
        <Login onAuthed={(m) => { setMe(m); setShowLogin(false); }} onClose={() => setShowLogin(false)} />
      )}
      {historyOpen && (
        <HistoryModal
          cases={cases}
          caseId={caseId}
          isAdmin={account.is_admin}
          onClose={() => setHistoryOpen(false)}
          onPick={(id) => { setCaseId(id); setView({ kind: "home" }); setHistoryOpen(false); }}
          onDelete={onDelete}
          onDeleteAll={onDeleteAll}
        />
      )}
    </div>
  );
}

function NeedCase() { return <div className="empty-state">Load a case first.</div>; }

function LoadProgress({ phase, detail, done, total, label }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : null;
  return (
    <div className="load-overlay">
      <div className="load-card">
        <div className="load-title"><span className="spin" /> Loading {label ? <span className="muted">· {label}</span> : null}</div>
        <div className="load-phase">{phase || "Working…"}</div>
        <div className={`load-bar ${pct === null ? "indet" : ""}`}>
          <div className="load-bar-fill" style={pct === null ? undefined : { width: pct + "%" }} />
        </div>
        <div className="load-meta">
          <span className="load-detail mono">{detail || "\u00a0"}</span>
          {pct !== null && <span className="muted">{done}/{total} · {pct}%</span>}
        </div>
      </div>
    </div>
  );
}

// Group the flat case list into a recursive tree:
//   case number → cluster name → node name → AutoSupport (by time).
const TREE_ICON = SHARED_TREE_ICON;

// Map an AutoSupport type to a colour class (semantic, consistent colours).
function CaseTreeNode({ node, depth, expanded, toggle, caseId, isAdmin, onPick, onDelete }) {
  const open = expanded.has(node.key);
  return (
    <div>
      <div className="case-tree-row" style={{ paddingLeft: depth * 18 + 8 }}
        onClick={() => toggle(node.key)}>
        <span className={`tree-chev ${open ? "open" : ""}`}>▶</span>
        <span className="case-tree-label">{TREE_ICON[node.kind]} {node.label}</span>
        <span className="muted case-tree-count">{countAsup(node)} ASUP</span>
      </div>
      {open && (node.children || []).map((ch) => (
        <CaseTreeNode key={ch.key} node={ch} depth={depth + 1} expanded={expanded}
          toggle={toggle} caseId={caseId} isAdmin={isAdmin} onPick={onPick} onDelete={onDelete} />
      ))}
      {open && (node.cases || []).map((c) => (
        <div key={c.id} className={`case-tree-row leaf ${c.id === caseId ? "active" : ""}`}
          style={{ paddingLeft: (depth + 1) * 18 + 8 }}
          title="Click to open this AutoSupport"
          onClick={() => onPick(c.id)}>
          {c.asup_type
            ? <span className={`chip asup-type ${asupTypeClass(c.asup_type)}`} title="AutoSupport type">{c.asup_type}</span>
            : <span className="chip asup-type at-other" title="AutoSupport type">—</span>}
          <span className="case-tree-label mono">🕑 {c.generated_on || c.loaded_at || "(unknown time)"}</span>
          <span className="case-tree-actions">
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onPick(c.id); }}>Open</button>
            {isAdmin && <button className="icon-btn danger" onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}>Delete</button>}
          </span>
          <span className="muted case-tree-count">{fmtBytes(c.size_bytes)}</span>
        </div>
      ))}
    </div>
  );
}

// Header case picker: a custom dropdown showing the case → cluster → node →
// autosupport tree with expand/collapse. Defaults to the case+cluster+node
// levels visible (autosupports collapsed). Expansion state lives here so it
// persists while the panel is reopened during the session.
function CasePicker({ cases, caseId, onPick }) {
  const [open, setOpen] = useState(false);
  const tree = useMemo(() => buildCaseTree(cases), [cases]);
  const allKeys = useMemo(() => collectTreeKeys(tree), [tree]);
  const defaultKeys = useMemo(() => collectKeysByKind(tree, ["case", "cluster"]), [tree]);
  const defaultSig = defaultKeys.join("|");
  const [expanded, setExpanded] = useState(() => new Set(defaultKeys));
  // Keep newly-loaded case/cluster/node branches visible by default.
  React.useEffect(() => {
    setExpanded((prev) => { const n = new Set(prev); for (const k of defaultKeys) n.add(k); return n; });
  }, [defaultSig]);
  const toggle = (k) => setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const allOpen = allKeys.length > 0 && allKeys.every((k) => expanded.has(k));

  const active = cases.find((c) => c.id === caseId);
  const label = active ? caseLabel(active) : "— select a case —";

  const pick = (id) => { onPick(id); setOpen(false); };

  return (
    <div className="case-picker">
      <button className="case-picker-btn" onClick={() => setOpen((v) => !v)} title="Select a case">
        <span className="case-picker-label">{label}</span>
        <span className={`tree-chev ${open ? "open" : ""}`}>▶</span>
      </button>
      {open && (
        <>
          <div className="case-picker-overlay" onClick={() => setOpen(false)} />
          <div className="case-picker-menu">
            <div className="toolbar" style={{ margin: "2px 4px 6px" }}>
              <span className="muted" style={{ fontSize: 11, flex: 1 }}>{cases.length} AutoSupport(s)</span>
              <ExpandToggle expanded={allOpen}
                onExpandAll={() => setExpanded(new Set(allKeys))}
                onCollapseAll={() => setExpanded(new Set())} />
            </div>
            {cases.length === 0 ? <div className="empty-state">No cases loaded.</div> : (
              <div className="case-tree" style={{ border: "none", maxHeight: "min(64vh,520px)" }}>
                {tree.map((n) => (
                  <CaseTreeNode key={n.key} node={n} depth={0} expanded={expanded} toggle={toggle}
                    caseId={caseId} isAdmin={false} onPick={pick} onDelete={() => {}} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function HistoryModal({ cases, caseId, isAdmin, onClose, onPick, onDelete, onDeleteAll }) {
  const tree = useMemo(() => buildCaseTree(cases), [cases]);
  const allKeys = useMemo(() => collectTreeKeys(tree), [tree]);
  const [expanded, setExpanded] = useState(new Set());
  const toggle = (k) => setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const allOpen = allKeys.length > 0 && allKeys.every((k) => expanded.has(k));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal priority" onClick={(e) => e.stopPropagation()}>
        <div className="toolbar">
          <b style={{ flex: 1 }}>Cases — {cases.length} AutoSupport(s)</b>
          {cases.length > 0 && (
            <ExpandToggle expanded={allOpen}
              onExpandAll={() => setExpanded(new Set(allKeys))}
              onCollapseAll={() => setExpanded(new Set())} />
          )}
          {isAdmin && cases.length > 0 && (
            <button className="icon-btn danger" title="Delete every loaded AutoSupport (admin only)"
              onClick={onDeleteAll}>Delete all</button>
          )}
          <button className="icon-btn" onClick={onClose}>Close</button>
        </div>
        {cases.length === 0 ? <div className="empty-state">No cases loaded yet.</div> : (
          <div className="case-tree">
            {tree.map((n) => (
              <CaseTreeNode key={n.key} node={n} depth={0} expanded={expanded} toggle={toggle}
                caseId={caseId} isAdmin={isAdmin} onPick={onPick} onDelete={onDelete} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CaseHome({ c, isAdmin, onDelete, onRefresh }) {
  const refresh = async () => { await api.refreshMetadata(c.id); onRefresh(); };
  const F = ({ k, v }) => <div><b>{k}</b><div className="mono">{v ?? "—"}</div></div>;
  return (
    <div>
      <h2 className="content-title">{caseLabel(c)}</h2>
      <p className="content-subtitle">{c.cluster ? `${c.cluster} · ` : ""}{c.source} · {c.package_type} · {fmtBytes(c.size_bytes)} · loaded {c.loaded_at}</p>
      <div className="card case-meta">
        <F k="Case number" v={c.case_number} /><F k="System ID" v={c.system_id} /><F k="Serial" v={c.serial} />
        <F k="Model" v={c.model} /><F k="Node" v={c.node} /><F k="HA partner" v={c.ha_partner} />
        <F k="OS version" v={c.os_version} /><F k="ASUP type" v={c.asup_type} /><F k="Generated on" v={c.generated_on} />
      </div>
      <div className="toolbar">
        <button className="btn" onClick={refresh}>Refresh metadata</button>
        <button className="btn" onClick={() => api.reclassify(c.id)}>Reclassify</button>
        {isAdmin && <button className="btn danger" onClick={() => onDelete(c.id)}>Delete case</button>}
      </div>
      <p className="info-text">Select a component on the left to view files and parse.</p>
    </div>
  );
}

const ARCHIVE_RE = /\.(zip|tgz|tar\.gz|tar|7z)$/i;

function walkEntry(entry, out, prefix) {
  return new Promise((resolve, reject) => {
    if (entry.isFile) {
      entry.file((f) => { try { f._rel = prefix + entry.name; } catch (e) {} out.push(f); resolve(); }, reject);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const acc = [];
      const read = () => reader.readEntries((ents) => {
        if (!ents.length) {
          (async () => { for (const e of acc) await walkEntry(e, out, prefix + entry.name + "/"); resolve(); })();
        } else { acc.push(...ents); read(); }
      }, reject);
      read();
    } else resolve();
  });
}

async function gatherFromDrop(dt) {
  const entries = [];
  const items = dt.items;
  if (items && items.length && items[0].webkitGetAsEntry) {
    for (let i = 0; i < items.length; i++) {
      const e = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
      if (e) entries.push(e);
    }
  }
  if (entries.length) {
    const out = [];
    for (const e of entries) await walkEntry(e, out, "");
    return out;
  }
  return [...dt.files];
}

const isAutosupportFile = (f) => /(^|\/)autosupport(\/|$)|x-header-data|\.asup\b/i.test(f._rel || f.webkitRelativePath || f.name || "");

// Split a flat file list (from a drop or input) into independent load groups:
// each top-level archive becomes its own case, and each top-level folder
// becomes its own case (its leading folder name stripped from the paths). Loose
// top-level non-archive files are collected into a single "(files)" case.
function groupDropped(files) {
  const archives = [];
  const folders = new Map(); // top folder name -> { files, paths }
  const loose = { files: [], paths: [] };
  for (const f of (files || [])) {
    if (!f || !f.name) continue;
    const rel = (f._rel || f.webkitRelativePath || f.name).replace(/\\/g, "/");
    const segs = rel.split("/").filter(Boolean);
    if (segs.length <= 1) {
      if (ARCHIVE_RE.test(f.name)) archives.push(f);
      else { loose.files.push(f); loose.paths.push(f.name); }
    } else {
      const top = segs[0];
      if (!folders.has(top)) folders.set(top, { files: [], paths: [] });
      const g = folders.get(top);
      g.files.push(f);
      g.paths.push(segs.slice(1).join("/")); // strip leading folder
    }
  }
  const groups = [];
  for (const f of archives) groups.push({ type: "archive", label: f.name, file: f });
  for (const [top, g] of folders) groups.push({ type: "folder", label: top, files: g.files, paths: g.paths });
  if (loose.files.length) groups.push({ type: "folder", label: "(files)", files: loose.files, paths: loose.paths });
  return groups;
}

function Dropzone({ onLoadGroups, onLoadStingray, uploading, cases, onPick, onDelete, isAdmin }) {
  const [drag, setDrag] = useState(false);
  const [caseNumber, setCaseNumber] = useState("");
  const [hint, setHint] = useState("");
  const folderRef = React.useRef(null);

  React.useEffect(() => {
    if (folderRef.current) {
      folderRef.current.setAttribute("webkitdirectory", "");
      folderRef.current.setAttribute("directory", "");
    }
  }, []);

  const handleFiles = (files) => {
    const real = (files || []).filter((f) => f && f.name);
    if (!real.length) return;
    if (!caseNumber.trim()) { setHint("Enter a Case number before loading."); return; }
    const groups = groupDropped(real);
    if (!groups.length) return;
    const asup = real.filter(isAutosupportFile).length;
    const nFolders = groups.filter((g) => g.type === "folder").length;
    const nArch = groups.filter((g) => g.type === "archive").length;
    setHint(`Loading ${groups.length} case(s) — ${nArch} archive(s), ${nFolders} folder(s)` +
      `${asup ? `, ${asup} autosupport file(s)` : ""}…`);
    onLoadGroups(groups, caseNumber);
  };

  return (
    <div>
      <div className="field-stack" style={{ maxWidth: 360, marginBottom: 12 }}>
        <label>Case number <span style={{ color: "var(--danger, #e83a3a)" }}>*</span></label>
        <input value={caseNumber} onChange={(e) => setCaseNumber(e.target.value)}
          placeholder="e.g. 2009123456" />
      </div>
      <div className={`dropzone ${drag ? "drag" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={async (e) => { e.preventDefault(); setDrag(false); const files = await gatherFromDrop(e.dataTransfer); handleFiles(files); }}
        onClick={() => document.getElementById("dzfile").click()}>
        <div className="dropzone-title">{uploading ? "Uploading…" : "Drop log packages or folders here"}</div>
        <div className="dropzone-sub">
          One or more .7z / .tgz / .tar.gz / .zip archives — <b>or one or more folders</b>.
          Each archive/folder loads as its own case (e.g. different nodes of the same cluster),
          all at once. Autosupport files are auto-detected.
        </div>
        <div className="toolbar" style={{ justifyContent: "center", marginTop: 8 }}>
          <button className="btn" onClick={(e) => { e.stopPropagation(); document.getElementById("dzfile").click(); }}>Browse file(s)…</button>
          <button className="btn" onClick={(e) => { e.stopPropagation(); folderRef.current && folderRef.current.click(); }}>Browse folder…</button>
        </div>
        {hint && <div className="info-text" style={{ marginTop: 8 }}>{hint}</div>}
        <input id="dzfile" type="file" hidden multiple accept=".zip,.tgz,.tar.gz,.tar,.7z,.tbz,.tbz2,.tar.bz2,.txz,.tar.xz"
          onChange={(e) => { handleFiles([...e.target.files]); e.target.value = ""; }} />
        <input ref={folderRef} type="file" hidden multiple
          onChange={(e) => { handleFiles([...e.target.files]); e.target.value = ""; }} />
      </div>
      <p className="info-text" style={{ marginTop: 6 }}>
        Tip: to load several nodes at once, drag multiple node folders (or multiple archives) together.
      </p>
      <StingrayBrowser caseNumber={caseNumber} setCaseNumber={setCaseNumber}
        onLoadStingray={onLoadStingray} uploading={uploading} />
      <h3 style={{ marginTop: 18 }}>Loaded log packages ({cases.length})</h3>
      {cases.length === 0 ? <div className="empty-state">No cases yet.</div> : (
        <LoadedTree cases={cases} isAdmin={isAdmin} onPick={onPick} onDelete={onDelete} />
      )}
    </div>
  );
}

// Loaded cases as a recursive tree: case # → cluster → node → AutoSupport time.
// Defaults to showing down to the cluster level (cases expanded, nodes collapsed);
// click a cluster to reveal its nodes, a node to reveal its AutoSupports, or use
// the one-click expand/collapse-all toggle. Clicking an AutoSupport opens it.
function LoadedTree({ cases, isAdmin, onPick, onDelete }) {
  const tree = useMemo(() => buildCaseTree(cases), [cases]);
  const allKeys = useMemo(() => collectTreeKeys(tree), [tree]);
  const caseKeys = useMemo(() => tree.map((n) => n.key), [tree]);
  const caseKeySig = caseKeys.join("|");
  const [expanded, setExpanded] = useState(() => new Set(caseKeys));
  // Keep clusters visible (case level expanded) as new cases are loaded.
  React.useEffect(() => {
    setExpanded((prev) => { const n = new Set(prev); for (const k of caseKeys) n.add(k); return n; });
  }, [caseKeySig]);
  const toggle = (k) => setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const allOpen = allKeys.length > 0 && allKeys.every((k) => expanded.has(k));

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 6 }}>
        <span className="muted" style={{ fontSize: 12, flex: 1 }}>case → cluster → node → autosupport</span>
        <ExpandToggle expanded={allOpen}
          onExpandAll={() => setExpanded(new Set(allKeys))}
          onCollapseAll={() => setExpanded(new Set())} />
      </div>
      <div className="case-tree">
        {tree.map((n) => (
          <CaseTreeNode key={n.key} node={n} depth={0} expanded={expanded} toggle={toggle}
            caseId={null} isAdmin={isAdmin} onPick={onPick} onDelete={onDelete} />
        ))}
      </div>
    </div>
  );
}

// Browse the server-side exports share (/mnt/stingray) by case number and pick
// files/folders to load as a single case. Drills into directories one level at
// a time; selections are tracked by their path relative to the case root.
function StingrayBrowser({ caseNumber, setCaseNumber, onLoadStingray, uploading }) {
  const [open, setOpen] = useState(false);
  const [rel, setRel] = useState("");          // current directory, relative to case root
  const [entries, setEntries] = useState(null); // null=not loaded yet
  const [selected, setSelected] = useState(new Map()); // rel -> { name, is_dir }
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [resolved, setResolved] = useState("");

  const browse = async (toRel) => {
    const cn = (caseNumber || "").trim();
    if (!cn) { setErr("Enter a Case number first."); return; }
    setLoading(true); setErr("");
    try {
      const r = await api.stingrayBrowse(cn, toRel || "");
      setEntries(r.entries || []);
      setRel(r.rel || "");
      setResolved(r.resolved_dir || "");
      setOpen(true);
    } catch (e) {
      setEntries([]);
      setErr(e && e.message ? e.message : String(e));
    }
    setLoading(false);
  };

  const toggle = (entry) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(entry.rel)) next.delete(entry.rel);
      else next.set(entry.rel, { name: entry.name, is_dir: entry.is_dir });
      return next;
    });
  };

  const crumbs = rel ? rel.split("/") : [];
  const parentRel = crumbs.slice(0, -1).join("/");

  const doLoad = () => {
    const paths = [...selected.keys()];
    onLoadStingray(caseNumber, paths);
    setSelected(new Map());
  };

  return (
    <div style={{ marginTop: 18, border: "1px solid var(--border, #ddd)", borderRadius: 8, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <b>Load from server exports</b>
        <span className="muted mono" style={{ fontSize: 12 }}>/mnt/stingray</span>
      </div>
      <p className="info-text" style={{ marginTop: 4, marginBottom: 10 }}>
        Enter a Case number and open it to pick files/folders directly from the server's
        exports. Archives are extracted automatically; everything loads as one case.
      </p>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
        <div className="field-stack" style={{ flex: "1 1 260px", maxWidth: 360, minWidth: 200 }}>
          <label>Case number</label>
          <input value={caseNumber} onChange={(e) => setCaseNumber(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); browse(""); } }}
            placeholder="e.g. 2009123456" />
        </div>
        <button className="btn primary" style={{ flex: "0 0 auto" }} disabled={loading || uploading || !caseNumber.trim()}
          onClick={() => browse("")}>{loading ? "Opening…" : "Open case"}</button>
      </div>

      {err && <div className="info-text" style={{ color: "var(--danger, #e83a3a)", marginTop: 8 }}>{err}</div>}

      {open && entries !== null && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 13 }}>
            <span className="chip" title={resolved}>📁 {caseNumber}</span>
            <a style={{ cursor: "pointer" }} onClick={() => browse("")}>root</a>
            {crumbs.map((c, i) => (
              <span key={i}>
                {" / "}
                <a style={{ cursor: "pointer" }}
                  onClick={() => browse(crumbs.slice(0, i + 1).join("/"))}>{c}</a>
              </span>
            ))}
          </div>

          <table className="file-table" style={{ marginTop: 8 }}>
            <thead><tr><th style={{ width: 32 }}></th><th>Name</th><th className="nowrap">Size</th><th></th></tr></thead>
            <tbody>
              {rel && (
                <tr>
                  <td></td>
                  <td><a style={{ cursor: "pointer" }} onClick={() => browse(parentRel)}>📁 ..</a></td>
                  <td></td><td></td>
                </tr>
              )}
              {entries.length === 0 && (
                <tr><td></td><td className="muted" colSpan={3}>(empty)</td></tr>
              )}
              {entries.map((e) => (
                <tr key={e.rel}>
                  <td>
                    <input type="checkbox" checked={selected.has(e.rel)}
                      onChange={() => toggle(e)} />
                  </td>
                  <td>
                    {e.is_dir
                      ? <a style={{ cursor: "pointer" }} onClick={() => browse(e.rel)}>📁 {e.name}</a>
                      : <span>{e.is_archive ? "🗜️ " : "📄 "}{e.name}</span>}
                  </td>
                  <td className="nowrap muted">{e.is_dir ? "—" : fmtBytes(e.size)}</td>
                  <td>{e.is_dir && <span className="muted" style={{ fontSize: 12 }}>folder</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="toolbar" style={{ marginTop: 8, alignItems: "center" }}>
            <span className="muted" style={{ fontSize: 13 }}>{selected.size} selected</span>
            <div style={{ flex: 1 }} />
            <button className="btn" disabled={!selected.size || uploading}
              onClick={() => setSelected(new Map())}>Clear</button>
            <button className="btn primary" disabled={!selected.size || uploading}
              onClick={doLoad}>{uploading ? "Loading…" : `Load ${selected.size} selected`}</button>
          </div>
        </div>
      )}
    </div>
  );
}
