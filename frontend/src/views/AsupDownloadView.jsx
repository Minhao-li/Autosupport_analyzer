import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";

const AIQ_URL = "https://aiq.netapp.com/asup-upload";

// Download AutoSupports from the ASUP-viewer gateway and load them into the
// analyzer. Reuses the same ActiveIQ token captured for ASUP upload.
export default function AsupDownloadView({ pollJob, onLoaded }) {
  // ---- token (shared with ASUP upload) ----
  const [token, setToken] = useState(null);
  const [tokenInput, setTokenInput] = useState("");
  const [awaitingCapture, setAwaitingCapture] = useState(false);
  const [checking, setChecking] = useState(false);

  // ---- config ----
  const [downloadUrl, setDownloadUrl] = useState("");
  const [searchUrl, setSearchUrl] = useState("");

  // ---- search / selection ----
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null); // [{asup_id, generated_on}]
  const [sel, setSel] = useState(new Set());
  const [idsText, setIdsText] = useState("");
  const [caseNumber, setCaseNumber] = useState("");

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const refreshToken = () => api.asupToken().then(setToken).catch(() => {});
  useEffect(() => { refreshToken(); }, []);
  useEffect(() => {
    api.asupDownloadConfig().then((r) => { setDownloadUrl(r.download_url || ""); setSearchUrl(r.search_url || ""); }).catch(() => {});
  }, []);

  // ----- token handlers (mirror the ASUP upload page) -----
  const authenticate = () => {
    window.open(AIQ_URL, "_blank", "noopener");
    setErr(null); setAwaitingCapture(true);
    setMsg("Opened ActiveIQ in a new tab. Sign in there — the AIQ Token Capture extension will grab your token automatically. Then click \"Refresh\" to load it (or paste it manually below).");
  };
  const checkCaptured = async () => {
    setChecking(true); setErr(null); setMsg(null);
    try {
      const t = await api.asupToken();
      setToken(t);
      if (t?.loaded) { setAwaitingCapture(false); setMsg("✓ Token captured successfully — you can now search and download AutoSupports."); }
      else setMsg("No token captured yet. Sign in to ActiveIQ with the extension installed, then click Refresh again — or paste the token manually below.");
    } catch (e) { setErr(String(e.message || e)); }
    setChecking(false);
  };
  const setTok = async () => {
    setErr(null); setMsg(null);
    try { await api.setAsupToken(tokenInput, null); setTokenInput(""); await refreshToken(); setAwaitingCapture(false); setMsg("✓ Token captured successfully — you can now search and download AutoSupports."); }
    catch (e) { setErr(String(e.message || e)); }
  };
  const clearTok = async () => { try { await api.clearAsupToken(); await refreshToken(); } catch (e) { setErr(String(e.message || e)); } };

  const saveConfig = async () => {
    setErr(null); setMsg(null);
    try { const r = await api.setAsupDownloadConfig({ download_url: downloadUrl, search_url: searchUrl }); setDownloadUrl(r.download_url); setSearchUrl(r.search_url); setMsg("Download settings saved."); }
    catch (e) { setErr(String(e.message || e)); }
  };

  // ----- search -----
  const runSearch = async () => {
    setSearching(true); setErr(null); setMsg(null); setResults(null); setSel(new Set());
    try {
      const r = await api.asupDownloadList({ query: query.trim(), date_from: dateFrom || null, date_to: dateTo || null });
      setResults(r.asups || []);
      setSel(new Set((r.asups || []).map((a) => a.asup_id)));
      setMsg(`Found ${r.count} AutoSupport(s)${r.total > r.count ? ` (of ${r.total}, filtered by date)` : ""}.`);
    } catch (e) { setErr(String(e.message || e)); }
    setSearching(false);
  };

  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSel = results && results.length > 0 && results.every((a) => sel.has(a.asup_id));
  const toggleAll = () => setSel(allSel ? new Set() : new Set((results || []).map((a) => a.asup_id)));

  const manualIds = useMemo(
    () => idsText.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean),
    [idsText]);

  // The set of ids to download: manual entry takes precedence if provided.
  const targetIds = manualIds.length ? manualIds : [...sel];

  const loadSelected = async () => {
    if (!targetIds.length) { setErr("Select AutoSupports from the results or enter ASUP id(s) below."); return; }
    setRunning(true); setErr(null); setMsg(null);
    setProgress({ phase: "Starting…", detail: "", done: 0, total: targetIds.length });
    try {
      const start = await api.asupDownloadLoad({ asup_ids: targetIds, case_number: caseNumber.trim() || null });
      const result = await pollJob(start.job_id, (j) => setProgress({ phase: j.phase, detail: j.detail, done: j.done, total: j.total }));
      const created = (result && result.multi && Array.isArray(result.cases)) ? result.cases : (result && result.id ? [result] : []);
      setMsg(`✓ Loaded ${created.length || targetIds.length} AutoSupport case(s).`);
      if (onLoaded) onLoaded(created);
    } catch (e) { setErr("Download/load failed: " + String(e.message || e)); }
    setProgress(null); setRunning(false);
  };

  return (
    <div>
      <h2 className="content-title">ASUP Download</h2>
      <p className="content-subtitle">Authenticate with ActiveIQ, search AutoSupports by serial/case number (or enter ASUP ids), then download &amp; load them into the analyzer.</p>

      {/* 1. Authentication (same token as ASUP Upload) */}
      <div className="card">
        <b>1 · Authentication</b>
        <div className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          Token: {token ? (token.loaded ? "✓ loaded" : "not loaded") : "…"} — this is the same token used for ASUP Upload.
        </div>
        <div className="toolbar">
          <button className="btn primary" onClick={authenticate}>Authenticate via ActiveIQ ↗</button>
          <a className="btn" href="/api/asup/extension.zip" download="AIQ_Token_Capture_extention.zip">Download AIQ_Token_Capture_extention</a>
        </div>
        <div className="info-text" style={{ fontSize: 12 }}>
          <b>How to get the token:</b>
          <ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            <li>Click <b>Download AIQ_Token_Capture_extention</b> and unzip it to a folder.</li>
            <li>Open <span className="mono">chrome://extensions/</span> (or <span className="mono">edge://extensions/</span>), enable <b>Developer mode</b>, click <b>Load unpacked</b> and select the folder.</li>
            <li>Click <b>Authenticate via ActiveIQ ↗</b> above and sign in to ActiveIQ.</li>
            <li>The extension captures the token automatically — click <b>↻ Refresh</b> to confirm it loaded (or paste it manually below).</li>
          </ol>
        </div>
        {awaitingCapture && !token?.loaded && (
          <div className="info-text" style={{ fontSize: 12, border: "1px solid var(--border, #444)", borderRadius: 6, padding: "8px 10px", margin: "8px 0" }}>
            <b>Waiting for the extension to capture your token…</b> Sign in on the ActiveIQ tab, then click Refresh.
            <div style={{ marginTop: 8 }}>
              <button className="btn primary" onClick={checkCaptured} disabled={checking}>{checking ? "Checking…" : "↻ Refresh token"}</button>
            </div>
          </div>
        )}
        <div className="toolbar">
          <input placeholder="paste token here (eyJ…)" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} style={{ flex: 1, minWidth: 260 }} />
          <button className="btn primary" onClick={setTok} disabled={!tokenInput}>Set token</button>
          <button className="btn" onClick={checkCaptured} disabled={checking}>{checking ? "…" : "↻ Refresh"}</button>
          <button className="btn" onClick={clearTok}>Clear</button>
        </div>
        {token?.loaded && <div className="info-text" style={{ fontSize: 12, color: "#22c55e", fontWeight: 600 }}>✓ Token captured — ActiveIQ authentication is ready.</div>}
      </div>

      {/* 2. Search & select */}
      <div className="card">
        <b>2 · Find AutoSupports</b>
        <div className="info-text" style={{ fontSize: 12, marginTop: 4 }}>
          Search by system serial number (e.g. <span className="mono">722042000140</span>). AutoSupport ids are time-based; narrow by date range to pick a subset.
        </div>
        <div className="toolbar" style={{ marginTop: 8, flexWrap: "wrap" }}>
          <input placeholder="system serial number" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <label className="muted" style={{ fontSize: 12 }}>From <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /></label>
          <label className="muted" style={{ fontSize: 12 }}>To <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></label>
          <button className="btn primary" onClick={runSearch} disabled={searching || !query.trim()}>{searching ? "Searching…" : "Search"}</button>
        </div>

        {results && (
          results.length === 0
            ? <div className="empty-state">No AutoSupports found for this query / date range.</div>
            : (
              <table className="file-table" style={{ marginTop: 10, width: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ width: 28 }}><input type="checkbox" checked={allSel} onChange={toggleAll} /></th>
                    <th>AutoSupport ID</th>
                    <th>Generated</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((a) => (
                    <tr key={a.asup_id}>
                      <td><input type="checkbox" checked={sel.has(a.asup_id)} onChange={() => toggle(a.asup_id)} /></td>
                      <td className="mono">{a.asup_id}</td>
                      <td>{a.generated_on || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
        )}

        <div style={{ marginTop: 12 }}>
          <label className="info-text" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
            …or enter AutoSupport id(s) directly (space / comma / newline separated). Overrides the selection above when filled.
          </label>
          <textarea value={idsText} onChange={(e) => setIdsText(e.target.value)} rows={2}
            placeholder="e.g. 1718524800000  1718438400000" style={{ width: "100%", fontFamily: "monospace" }} />
        </div>
      </div>

      {/* 3. Download & load */}
      <div className="card">
        <b>3 · Download &amp; load</b>
        <div className="toolbar" style={{ marginTop: 8, flexWrap: "wrap" }}>
          <input placeholder="case number (optional — defaults to the first ASUP id)" value={caseNumber}
            onChange={(e) => setCaseNumber(e.target.value)} style={{ flex: 1, minWidth: 260 }} disabled={running} />
          <button className="btn primary" onClick={loadSelected} disabled={!token?.loaded || running || !targetIds.length}>
            {running ? "Working…" : `Download & Load (${targetIds.length})`}
          </button>
        </div>
        {!token?.loaded && <div className="info-text" style={{ fontSize: 12 }}>Authenticate with ActiveIQ above to enable downloads.</div>}
        {progress && (
          <div className="info-text" style={{ fontSize: 12, marginTop: 6 }}>
            {progress.phase} {progress.detail ? `· ${progress.detail}` : ""} {progress.total ? `(${progress.done}/${progress.total})` : ""}
          </div>
        )}
      </div>

      {/* Endpoints config */}
      <div className="card">
        <b>Endpoints</b>
        <div style={{ marginTop: 8 }}>
          <label className="info-text" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
            Download base URL (the ASUP id is appended as <span className="mono">/&lt;id&gt;?system_state=all&amp;product_type=all</span>):
          </label>
          <input value={downloadUrl} onChange={(e) => setDownloadUrl(e.target.value)} style={{ width: "100%" }}
            placeholder="https://apigtwyapps.netapp.com/aiq/api/asup-viewer/v0/asup-download/asup_id" disabled={running} />
        </div>
        <div style={{ marginTop: 8 }}>
          <label className="info-text" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
            Search/list URL — the ActiveIQ asup-viewer list endpoint. Placeholders: <span className="mono">{"{query}"}</span> (serial number), <span className="mono">{"{date_from}"}</span>, <span className="mono">{"{date_to}"}</span>:
          </label>
          <input value={searchUrl} onChange={(e) => setSearchUrl(e.target.value)} style={{ width: "100%" }}
            placeholder="https://apigtwyapps.netapp.com/aiq/api/asup-viewer/v0/asup-list/sys_serial_no/{query}?system_state=all&product_type=all&start_date={date_from}&end_date={date_to}" disabled={running} />
        </div>
        <div className="toolbar" style={{ marginTop: 8 }}>
          <button className="btn" onClick={saveConfig} disabled={running}>Save endpoints</button>
        </div>
      </div>

      {msg && <div className="info-text">{msg}</div>}
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}
