import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { fmtBytes, ExpandToggle, caseLabel, asupTypeClass } from "../lib/helpers.jsx";

const AIQ_URL = "https://aiq.netapp.com/asup-upload";

export default function AsupView({ caseId, cases = [], isAdmin, onPickCase }) {
  const [token, setToken] = useState(null);
  const [tokenInput, setTokenInput] = useState("");
  const [files, setFiles] = useState(null);
  const [sel, setSel] = useState(new Set());
  const category = "technical";
  const [items, setItems] = useState({});   // dir -> { compress, upload, archive, size, reused, error }
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [awaitingCapture, setAwaitingCapture] = useState(false);
  const [checking, setChecking] = useState(false);
  const [uploadUrl, setUploadUrl] = useState("");
  // Cross-case selection: pick AutoSupports by case → cluster → node.
  const [selCases, setSelCases] = useState(new Set());
  const [expanded, setExpanded] = useState(new Set());
  const [caseStatus, setCaseStatus] = useState({}); // case id -> {phase, ok, fail, detail, error}

  const refreshToken = () => api.asupToken().then(setToken).catch(() => {});
  useEffect(() => { refreshToken(); }, []);
  useEffect(() => { api.asupUploadUrl().then((r) => setUploadUrl(r.url)).catch(() => {}); }, []);
  const saveUploadUrl = async () => {
    setErr(null); setMsg(null);
    try { const r = await api.setAsupUploadUrl(uploadUrl); setUploadUrl(r.url); setMsg("Upload URL saved."); }
    catch (e) { setErr(String(e.message || e)); }
  };
  useEffect(() => {
    setFiles(null); setSel(new Set()); setItems({}); setMsg(null); setErr(null);
    if (caseId) api.autosupportFiles(caseId).then((r) => setFiles(r.files)).catch(() => setFiles([]));
  }, [caseId]);

  // derive autosupport collection directories (relative dir path -> {label, count})
  const collections = useMemo(() => {
    const map = new Map();
    for (const f of files || []) {
      const m = f.path.match(/^(.*autosupport\/[^/]+)/i);
      if (!m) continue;
      const dir = m[1];
      if (!map.has(dir)) map.set(dir, { dir, label: dir.split("/").pop(), count: 0 });
      map.get(dir).count++;
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [files]);

  const toggle = (d) => setSel((s) => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; });
  const allSelected = collections.length > 0 && collections.every((c) => sel.has(c.dir));
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(collections.map((c) => c.dir)));
  const setItem = (dir, patch) => setItems((m) => ({ ...m, [dir]: { ...(m[dir] || {}), ...patch } }));

  // ----- cross-case AutoSupport tree (case # → cluster → node → autosupport) -----
  const asTree = useMemo(() => {
    const root = [];
    const find = (arr, key, label, kind) => {
      let n = arr.find((x) => x.key === key);
      if (!n) { n = { key, label, kind, children: [], cases: [] }; arr.push(n); }
      return n;
    };
    for (const c of cases) {
      const cn = c.case_number || "(no case #)";
      const cl = c.cluster || "(no cluster)";
      const nd = c.node || "(no node)";
      const n1 = find(root, `c:${cn}`, cn, "case");
      const n2 = find(n1.children, `c:${cn}|cl:${cl}`, cl, "cluster");
      const n3 = find(n2.children, `c:${cn}|cl:${cl}|n:${nd}`, nd, "node");
      n3.cases.push(c);
    }
    return root;
  }, [cases]);

  const nodeCaseIds = (node) => {
    const out = [];
    const walk = (n) => { (n.cases || []).forEach((c) => out.push(c.id)); (n.children || []).forEach(walk); };
    walk(node);
    return out;
  };
  const allTreeKeys = useMemo(() => {
    const acc = []; const walk = (n) => { acc.push(n.key); (n.children || []).forEach(walk); };
    asTree.forEach(walk); return acc;
  }, [asTree]);
  const toggleExp = (k) => setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const treeAllOpen = allTreeKeys.length > 0 && allTreeKeys.every((k) => expanded.has(k));
  const toggleCase = (id) => setSelCases((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const setNodeSel = (ids, on) => setSelCases((s) => {
    const n = new Set(s); ids.forEach((id) => (on ? n.add(id) : n.delete(id))); return n;
  });
  const selAllCases = () => setSelCases(new Set(cases.map((c) => c.id)));
  const clearCases = () => setSelCases(new Set());

  // Fetch & cache the autosupport collection dirs of a given case.
  const collCache = React.useRef({});
  const caseCollections = async (id) => {
    if (collCache.current[id]) return collCache.current[id];
    const r = await api.autosupportFiles(id).catch(() => ({ files: [] }));
    const map = new Map();
    for (const f of r.files || []) {
      const m = f.path.match(/^(.*autosupport\/[^/]+)/i);
      const dir = m ? m[1] : f.path.replace(/\/[^/]*$/, "");
      if (!map.has(dir)) map.set(dir, dir);
    }
    const dirs = [...map.values()];
    collCache.current[id] = dirs;
    return dirs;
  };

  // Compress & upload every selected AutoSupport (across cases).
  const runSelectedCases = async () => {
    const ids = cases.map((c) => c.id).filter((id) => selCases.has(id));
    if (!ids.length) return;
    setRunning(true); setErr(null); setMsg(null);
    const init = {}; ids.forEach((id) => { init[id] = { phase: "queued", ok: 0, fail: 0 }; });
    setCaseStatus(init);
    let totalOk = 0, totalFail = 0;
    for (const id of ids) {
      const c = cases.find((x) => x.id === id);
      setCaseStatus((m) => ({ ...m, [id]: { ...(m[id] || {}), phase: "collecting" } }));
      let dirs = [];
      try { dirs = await caseCollections(id); } catch (e) { /* ignore */ }
      if (!dirs.length) {
        setCaseStatus((m) => ({ ...m, [id]: { phase: "error", error: "No autosupport collection found" } }));
        totalFail++; continue;
      }
      let ok = 0, fail = 0;
      for (let i = 0; i < dirs.length; i++) {
        setCaseStatus((m) => ({ ...m, [id]: { ...(m[id] || {}), phase: `compress ${i + 1}/${dirs.length}`, ok, fail } }));
        try {
          const pkg = await api.asupPackage(id, { paths: [dirs[i]] });
          setCaseStatus((m) => ({ ...m, [id]: { ...(m[id] || {}), phase: `upload ${i + 1}/${dirs.length}`, ok, fail } }));
          const r = await api.asupUploadAiq(id, { archive: pkg.archive, category });
          if (r.uploaded) { ok++; } else { fail++; }
        } catch (e) { fail++; }
      }
      totalOk += ok; totalFail += fail;
      setCaseStatus((m) => ({ ...m, [id]: { phase: "done", ok, fail, node: c && c.node } }));
    }
    setRunning(false);
    setMsg(`Done — ${totalOk} uploaded${totalFail ? `, ${totalFail} failed` : ""} across ${ids.length} AutoSupport(s).`);
  };

  const authenticate = () => {
    window.open(AIQ_URL, "_blank", "noopener");
    setErr(null);
    setAwaitingCapture(true);
    setMsg("Opened ActiveIQ in a new tab. Sign in there — the AIQ Token Capture extension will grab your token automatically. Then come back and click \"Refresh\" to load it (or paste it manually below).");
  };
  const checkCaptured = async () => {
    setChecking(true); setErr(null); setMsg(null);
    try {
      const t = await api.asupToken();
      setToken(t);
      if (t?.loaded) {
        setAwaitingCapture(false);
        setMsg("✓ Token captured successfully — you can now build a package and upload to ActiveIQ.");
      } else {
        setMsg("No token captured yet. Sign in to ActiveIQ with the extension installed, then click Refresh again — or paste the token manually below.");
      }
    } catch (e) { setErr(String(e.message || e)); }
    setChecking(false);
  };
  const setTok = async () => {
    setErr(null); setMsg(null);
    try { await api.setAsupToken(tokenInput, null); setTokenInput(""); await refreshToken(); setAwaitingCapture(false); setMsg("✓ Token captured successfully — you can now build a package and upload to ActiveIQ."); }
    catch (e) { setErr(String(e.message || e)); }
  };
  const clearTok = async () => { try { await api.clearAsupToken(); await refreshToken(); } catch (e) { setErr(String(e.message || e)); } };

  const runAll = async () => {
    const dirs = collections.filter((c) => sel.has(c.dir));
    if (!dirs.length) return;
    setRunning(true); setErr(null); setMsg(null);
    const init = {};
    dirs.forEach((c) => { init[c.dir] = { compress: "pending", upload: "pending" }; });
    setItems(init);
    let ok = 0, failed = 0;
    for (const c of dirs) {
      // 1. Compress (reuses an existing same-named archive for this source)
      setItem(c.dir, { compress: "running" });
      let pkg;
      try {
        pkg = await api.asupPackage(caseId, { paths: [c.dir] });
        setItem(c.dir, { compress: pkg.reused ? "reused" : "done", archive: pkg.archive, size: pkg.size });
      } catch (e) {
        setItem(c.dir, { compress: "error", error: String(e.message || e) });
        failed++;
        continue;
      }
      // 2. Upload to ActiveIQ
      setItem(c.dir, { upload: "running" });
      try {
        const r = await api.asupUploadAiq(caseId, { archive: pkg.archive, category });
        if (r.uploaded) { setItem(c.dir, { upload: "done" }); ok++; }
        else { setItem(c.dir, { upload: "error", error: r.detail || "Upload not completed" }); failed++; }
      } catch (e) {
        setItem(c.dir, { upload: "error", error: String(e.message || e) }); failed++;
      }
    }
    setRunning(false);
    setMsg(`Done — ${ok} uploaded${failed ? `, ${failed} failed` : ""} of ${dirs.length} AutoSupport(s).`);
  };

  const compressLabel = (it) => ({
    running: "⏳ compressing…",
    done: "✓ compressed",
    reused: "↺ reused",
    error: "✗ compress failed",
    pending: "· queued",
  }[it.compress] || "");
  const uploadLabel = (it) => ({
    running: "⏳ uploading…",
    done: "✓ uploaded",
    error: "✗ upload failed",
  }[it.upload] || "");
  const selList = collections.filter((c) => sel.has(c.dir));
  const finished = selList.filter((c) => {
    const it = items[c.dir] || {};
    return it.upload === "done" || it.upload === "error" || it.compress === "error";
  }).length;
  const progressText = `${finished} / ${selList.length}`;

  return (
    <div>
      <h2 className="content-title">ASUP Upload</h2>
      <p className="content-subtitle">Authenticate with ActiveIQ, select AutoSupport collections, then compress &amp; upload each — with per-file progress.</p>

      {/* 1. Authentication */}
      <div className="card">
        <b>1 · Authentication</b>
        <div className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          Token: {token ? (token.loaded ? "✓ loaded" : "not loaded") : "…"}
        </div>
        {(
          <>
            <div className="toolbar">
              <button className="btn primary" onClick={authenticate}>Authenticate via ActiveIQ ↗</button>
              <a className="btn" href="/api/asup/extension.zip" download="AIQ_Token_Capture_extention.zip">Download AIQ_Token_Capture_extention</a>
            </div>
            <div className="info-text" style={{ fontSize: 12 }}>
              <b>How to install &amp; use the extension:</b>
              <ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                <li>Click <b>Download AIQ_Token_Capture_extention</b> and unzip <span className="mono">AIQ_Token_Capture_extention.zip</span> to a folder.</li>
                <li>Open <span className="mono">chrome://extensions/</span> (or <span className="mono">edge://extensions/</span>) and turn on <b>Developer mode</b> (top-right).</li>
                <li>Click <b>Load unpacked</b> and select the unzipped folder.</li>
                <li>Click <b>Authenticate via ActiveIQ ↗</b> above and sign in to ActiveIQ.</li>
                <li>The extension captures the token automatically and sends it back here — click <b>↻ Refresh</b> to confirm it loaded. (You can still paste a token manually below if needed.)</li>
              </ol>
            </div>
            {awaitingCapture && !token?.loaded && (
              <div className="info-text" style={{ fontSize: 12, border: "1px solid var(--border, #444)", borderRadius: 6, padding: "8px 10px", margin: "8px 0" }}>
                <b>Waiting for the extension to capture your token…</b>
                <div style={{ margin: "4px 0 8px" }}>
                  Sign in on the ActiveIQ tab. The <b>AIQ Token Capture</b> extension grabs the token automatically.
                  Once you've signed in, click <b>Refresh</b> to load it here.
                </div>
                <button className="btn primary" onClick={checkCaptured} disabled={checking}>
                  {checking ? "Checking…" : "↻ Refresh token"}
                </button>
              </div>
            )}
            <div className="toolbar">
              <input placeholder="paste token here (eyJ…)" value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)} style={{ flex: 1, minWidth: 260 }} />
              <button className="btn primary" onClick={setTok} disabled={!tokenInput}>Set token</button>
              <button className="btn" onClick={checkCaptured} disabled={checking}>{checking ? "…" : "↻ Refresh"}</button>
              <button className="btn" onClick={clearTok}>Clear</button>
            </div>
            {token?.loaded && (
              <div className="info-text" style={{ fontSize: 12, color: "#22c55e", fontWeight: 600 }}>
                ✓ Token captured — ActiveIQ authentication is ready.
              </div>
            )}
            <div className="info-text" style={{ fontSize: 12 }}>
              The ActiveIQ page opens in a new tab. For security, browsers don't allow this app to read another
              site's token automatically — copy it from ActiveIQ (or use the extension) and paste it above.
            </div>
          </>
        )}
      </div>

      {/* 2. Select AutoSupports (across cases) & upload */}
      <div className="card">
        <b>2 · Select AutoSupport(s) & upload</b>
        {cases.length === 0 ? <div className="empty-state">No cases loaded.</div> : (
          <div style={{ marginTop: 8 }}>
            <div className="toolbar" style={{ marginBottom: 6 }}>
              <span className="muted" style={{ fontSize: 12, flex: 1 }}>
                Select by case → cluster → node → AutoSupport. {selCases.size} selected.
              </span>
              <button className="link-btn" onClick={selAllCases}>Select all</button>
              <button className="link-btn" onClick={clearCases}>Clear</button>
              <ExpandToggle expanded={treeAllOpen}
                onExpandAll={() => setExpanded(new Set(allTreeKeys))}
                onCollapseAll={() => setExpanded(new Set())} />
            </div>
            <div className="case-tree">
              {asTree.map((n) => (
                <AsupSelectNode key={n.key} node={n} depth={0} expanded={expanded} toggleExp={toggleExp}
                  selCases={selCases} toggleCase={toggleCase} setNodeSel={setNodeSel}
                  nodeCaseIds={nodeCaseIds} caseStatus={caseStatus} running={running}
                  caseId={caseId} onPickCase={onPickCase} />
              ))}
            </div>

            <div className="toolbar" style={{ marginTop: 10 }}>
              <button className="btn primary" onClick={runSelectedCases}
                disabled={!token?.loaded || !selCases.size || running}>
                {running ? "Working…" : `Compress & Upload (${selCases.size})`}
              </button>
            </div>
            {!token?.loaded && <div className="info-text" style={{ fontSize: 12 }}>Authenticate with ActiveIQ above to enable upload.</div>}
            <div className="info-text" style={{ fontSize: 12 }}>
              Each selected AutoSupport is compressed into its own .7z (files at the archive root) and uploaded
              individually. An already-built archive for the same source is reused (compression skipped).
            </div>

            <div style={{ marginTop: 10 }}>
              <label className="info-text" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                ActiveIQ upload base URL (the .7z filename is appended automatically):
              </label>
              <div className="toolbar">
                <input value={uploadUrl} onChange={(e) => setUploadUrl(e.target.value)}
                  placeholder="https://apigtwyapps.netapp.com/aiq/api/raw-asup-uploader/manual_asup_upload"
                  style={{ flex: 1, minWidth: 320 }} disabled={running} />
                <button className="btn" onClick={saveUploadUrl} disabled={running}>Save URL</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {msg && <div className="info-text">{msg}</div>}
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}

const _ICON = { case: "🗂", cluster: "🧩", node: "🖥" };

// One node of the selectable AutoSupport tree. A group checkbox selects/clears
// all AutoSupports beneath it (with an indeterminate state for partial); leaves
// are individual AutoSupports.
function AsupSelectNode({ node, depth, expanded, toggleExp, selCases, toggleCase, setNodeSel,
                         nodeCaseIds, caseStatus, running, caseId, onPickCase }) {
  const open = expanded.has(node.key);
  const ids = nodeCaseIds(node);
  const selCount = ids.filter((id) => selCases.has(id)).length;
  const all = ids.length > 0 && selCount === ids.length;
  const some = selCount > 0 && !all;
  return (
    <div>
      <div className="case-tree-row" style={{ paddingLeft: depth * 18 + 8 }}>
        <input type="checkbox" checked={all} disabled={running}
          ref={(el) => { if (el) el.indeterminate = some; }}
          onClick={(e) => e.stopPropagation()}
          onChange={() => setNodeSel(ids, !all)} />
        <span className="tree-chev-wrap" onClick={() => toggleExp(node.key)} style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
          <span className={`tree-chev ${open ? "open" : ""}`}>▶</span>
          <span className="case-tree-label">{_ICON[node.kind]} {node.label}</span>
        </span>
        <span className="muted case-tree-count">{selCount}/{ids.length}</span>
      </div>
      {open && (node.children || []).map((ch) => (
        <AsupSelectNode key={ch.key} node={ch} depth={depth + 1} expanded={expanded} toggleExp={toggleExp}
          selCases={selCases} toggleCase={toggleCase} setNodeSel={setNodeSel} nodeCaseIds={nodeCaseIds}
          caseStatus={caseStatus} running={running} caseId={caseId} onPickCase={onPickCase} />
      ))}
      {open && (node.cases || []).map((c) => {
        const st = caseStatus[c.id];
        return (
          <label key={c.id} className={`case-tree-row leaf ${c.id === caseId ? "active" : ""}`}
            style={{ paddingLeft: (depth + 1) * 18 + 8, cursor: running ? "default" : "pointer" }}>
            <input type="checkbox" checked={selCases.has(c.id)} disabled={running}
              onChange={() => toggleCase(c.id)} />
            {c.asup_type && <span className={`chip asup-type ${asupTypeClass(c.asup_type)}`} style={{ minWidth: 70 }}>{c.asup_type}</span>}
            <span className="case-tree-label mono">🕑 {c.generated_on || c.loaded_at || "(unknown time)"}</span>
            {st && st.phase && (
              <span className={`chip ${st.phase === "done" ? "" : "muted"}`} style={{ fontSize: 10.5 }}>
                {st.phase === "done" ? `✓ ${st.ok || 0}${st.fail ? ` ✗${st.fail}` : ""}` :
                  st.phase === "error" ? `✗ ${st.error || "failed"}` : `⏳ ${st.phase}`}
              </span>
            )}
            <span className="muted case-tree-count">{fmtBytes(c.size_bytes)}</span>
          </label>
        );
      })}
    </div>
  );
}
