import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { Highlight, xmlPairs, SearchHelp } from "../lib/helpers.jsx";

export default function GrepModal({ caseId, comp, paths, onClose, onOpenFile }) {
  const [pattern, setPattern] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [context, setContext] = useState(0);
  const [pretty, setPretty] = useState(true);
  const [wholeCase, setWholeCase] = useState(false);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async () => {
    if (!pattern) return;
    setBusy(true); setErr(null); setRes(null);
    try {
      const body = { pattern, regex, case_sensitive: caseSensitive, context: Number(context) || 0 };
      let r;
      if (wholeCase) {
        r = await api.caseGrep(caseId, body);              // no paths → entire case
      } else {
        const scoped = { ...body, paths };
        r = comp ? await api.componentGrep(caseId, comp, scoped) : await api.caseGrep(caseId, scoped);
      }
      if (r.error) setErr(r.error); else setRes(r);
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  return (
    <div style={{
      position: "fixed", left: 0, right: 0, bottom: 0, height: "45vh", zIndex: 40,
      background: "var(--panel)", borderTop: "2px solid var(--border-strong)",
      boxShadow: "0 -4px 18px rgba(0,0,0,.35)", display: "flex", flexDirection: "column",
    }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", borderBottom: "1px solid var(--border)" }}>
          <b style={{ flex: 1 }}>Grep results — {paths.length} file(s)</b>
          <span className="muted" style={{ fontSize: 12, marginRight: 6 }}>Click a file to view it on the page · this panel stays open</span>
          <button onClick={onClose} title="Close (Esc)" aria-label="Close"
            style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 18, lineHeight: 1, cursor: "pointer", padding: "2px 6px", borderRadius: 6 }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--panel-2)"; e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--muted)"; }}>
            ✕
          </button>
        </div>

        {/* Controls */}
        <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input autoFocus placeholder={regex ? "Search pattern (regex)…" : "Search pattern…"} value={pattern} style={{ flex: 1, minWidth: 0 }}
              onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
            <button className="btn primary" onClick={run} disabled={busy || !pattern}>{busy ? "Searching…" : "Grep"}</button>
            <SearchHelp regex={regex} align="right" />
          </div>
          <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
            <label className="chip" title="Treat pattern as Python regex (vs substring)"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> regex</label>
            <label className="chip"><input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> Case sensitive</label>
            <label className="chip">Context <input type="number" min="0" max="10" value={context} style={{ width: 50 }} onChange={(e) => setContext(e.target.value)} /></label>
            <label className="chip" title="Render matches from XML files as readable field: value pairs"><input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} /> Pretty XML</label>
            <label className="chip" title="Search every file in the whole case, ignoring the component/selection scope"><input type="checkbox" checked={wholeCase} onChange={(e) => setWholeCase(e.target.checked)} /> Whole case</label>
          </div>
        </div>

        {/* Results (scrollable) */}
        <div style={{ padding: "12px 18px", overflow: "auto", flex: 1, minHeight: 0 }}>
          {err && <div className="error-text">{err}</div>}
          {!res && !err && <div className="info-text">Enter a pattern and press Grep.</div>}
          {res && res.results.length === 0 && <div className="empty-state">No matches for “{pattern}”.</div>}
          {res && res.results.length > 0 && (
            <>
              <div className="info-text" style={{ marginTop: 0 }}>{res.total} hits across {res.results.length} file(s)</div>
              {res.results.map((f, i) => {
                const isXml = /\.xml(\.gz)?$/i.test(f.path);
                return (
                  <div className="card" key={i} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                      <span className="mono" style={{ flex: 1, fontSize: 12, wordBreak: "break-all" }}>
                        {onOpenFile
                          ? <a style={{ cursor: "pointer" }} title="Open this file" onClick={() => onOpenFile(f.path)}>{f.path}</a>
                          : f.path}
                      </span>
                      <span className="chip">{f.hits.length} hit{f.hits.length !== 1 ? "s" : ""}</span>
                    </div>
                    {f.hits.map((h, j) => {
                      const pairs = pretty && isXml ? xmlPairs(h.text) : [];
                      if (pairs.length) {
                        return (
                          <div key={j} style={{ display: "flex", flexWrap: "wrap", gap: "2px 14px", alignItems: "baseline", fontSize: 12, padding: "2px 0", borderTop: j ? "1px dashed var(--border)" : "none" }} title={h.text}>
                            <span className="muted mono" style={{ minWidth: 44 }}>{h.line}:</span>
                            {pairs.map(([k, v], n) => (
                              <span key={n}>
                                <span className="muted">{k}:</span>{" "}
                                <span className="mono"><Highlight text={v} q={regex ? "" : pattern} /></span>
                              </span>
                            ))}
                          </div>
                        );
                      }
                      return (
                        <div key={j} className="mono" style={{ display: "flex", gap: 8, fontSize: 12, padding: "2px 0", whiteSpace: "pre-wrap", wordBreak: "break-word", borderTop: j ? "1px dashed var(--border)" : "none" }}>
                          <span className="muted" style={{ minWidth: 44 }}>{h.line}:</span>
                          <span style={{ flex: 1 }}><Highlight text={h.text} q={regex ? "" : pattern} /></span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </>
          )}
        </div>
    </div>
  );
}
