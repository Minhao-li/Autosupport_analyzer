import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { fmtBytes, verticalStyle, FilterInput, matchKeywords, SearchHelp, ExpandToggle } from "../lib/helpers.jsx";
import EventsTable from "./EventsTable.jsx";
import GrepModal from "./GrepModal.jsx";
import InlineContent from "./InlineContent.jsx";
import CompareControls from "./Compare.jsx";

export default function AutoSupportView({ caseId }) {
  const [tab, setTab] = useState("files");
  const [files, setFiles] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [grep, setGrep] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [err, setErr] = useState(null);

  useEffect(() => {
    setFiles(null); setSel(new Set()); setParsed(null); setActive(null); setErr(null); setTab("files");
    api.autosupportFiles(caseId).then((r) => setFiles(r.files))
      .catch((e) => setErr(String(e.message || e)));
  }, [caseId]);

  const shown = (files || []).filter((f) => matchKeywords(f.path, filter));
  const toggle = (p) => setSel((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });

  const groupKey = (path) => {
    const m = path.match(/(^|\/)autosupport\/([^/]+)/i);
    return m ? "autosupport/" + m[2] : (path.lastIndexOf("/") === -1 ? "(root)" : path.slice(0, path.lastIndexOf("/")));
  };
  const groups = useMemo(() => {
    const map = new Map();
    for (const f of shown) {
      const k = groupKey(f.path);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(f);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [shown]);
  const toggleGroup = (k) => setExpandedGroups((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const expandAll = () => setExpandedGroups(new Set(groups.map(([k]) => k)));
  const collapseAll = () => setExpandedGroups(new Set());
  const groupLabel = (k) => k.split("/").pop();

  const parseSel = async () => {
    if (!sel.size) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.parsePaths(caseId, { paths: [...sel] });
      setParsed(r); setTab("events");
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  return (
    <div style={verticalStyle("core")}>
      <h2 className="content-title">AutoSupport</h2>
      <p className="content-subtitle">All files under the AutoSupport collection directories ({(files || []).length} files)</p>

      <div className="tabs">
        <button className={`tab ${tab === "files" ? "active" : ""}`} onClick={() => setTab("files")}>Files</button>
        <button className={`tab ${tab === "events" ? "active" : ""}`} onClick={() => setTab("events")}>Events</button>
      </div>

      {err && <div className="error-text">{err}</div>}

      {tab === "files" && (
        <>
          <div className="toolbar">
            <FilterInput placeholder="Filter files by name…" value={filter} onChange={setFilter} wrapStyle={{ minWidth: 220 }} style={{ minWidth: 220 }} />
            <SearchHelp />
            <button className="btn" onClick={parseSel} disabled={busy || !sel.size}>Parse selected ({sel.size})</button>
            <button className="btn" disabled={!sel.size} onClick={() => setGrep([...sel])}>Grep selected ({sel.size})</button>
            <button className="btn" onClick={() => setGrep(shown.map((f) => f.path))}>Grep all</button>
            <CompareControls caseId={caseId} comp={null} paths={[...sel]} />
          </div>

          {!files ? <div className="info-text"><span className="spin" /> Loading…</div> : shown.length === 0 ? (
            <div className="empty-state">No AutoSupport files in this case.</div>
          ) : (
            <div className="split">
              <div className="split-list">
                <div className="list-controls">
                  <ExpandToggle expanded={groups.length > 0 && groups.every(([k]) => expandedGroups.has(k))}
                    onExpandAll={expandAll} onCollapseAll={collapseAll} />
                  <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>{groups.length} dir(s)</span>
                </div>
                {groups.map(([key, gfiles]) => {
                  const gexp = expandedGroups.has(key);
                  return (
                    <div key={key} className="file-group">
                      <div className="file-group-head" onClick={() => toggleGroup(key)} title={key}>
                        <span className={`tree-chev ${gexp ? "open" : ""}`}>▶</span>
                        <span className="file-group-name">{groupLabel(key)}</span>
                        <span className="chip">{gfiles.length}</span>
                      </div>
                      {gexp && gfiles.map((f) => (
                        <div key={f.path} className={`file-row ${active === f.path ? "active" : ""}`}
                          onClick={() => setActive(f.path)} title={f.path}>
                          <input type="checkbox" checked={sel.has(f.path)}
                            onClick={(e) => e.stopPropagation()} onChange={() => toggle(f.path)} />
                          <span className="file-row-name mono">{f.path.split("/").pop()}</span>
                          <span className="muted" style={{ fontSize: 11 }}>{fmtBytes(f.size)}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
              <div className="split-content">
                {active ? <InlineContent caseId={caseId} path={active} key={active} />
                  : <div className="empty-state">Select a file on the left to view it.</div>}
              </div>
            </div>
          )}
        </>
      )}

      {tab === "events" && (
        parsed ? <EventsTable events={parsed.events} total={parsed.total} />
          : <div className="empty-state">No parsed files yet. Select files and Parse.</div>
      )}

      {grep && <GrepModal caseId={caseId} comp={null} paths={grep} onClose={() => setGrep(null)} />}
    </div>
  );
}
