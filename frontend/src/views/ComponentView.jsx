import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { fmtBytes, verticalStyle, FilterInput, matchKeywords, SearchHelp, ExpandToggle } from "../lib/helpers.jsx";
import EventsTable from "./EventsTable.jsx";
import GrepModal from "./GrepModal.jsx";
import InlineContent from "./InlineContent.jsx";
import CompareControls from "./Compare.jsx";

export default function ComponentView({ caseId, comp, compName, vertical, initialFilter, cases = [] }) {
  const [tab, setTab] = useState("files");
  const [files, setFiles] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [filter, setFilter] = useState(initialFilter || "");
  const [active, setActive] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [grep, setGrep] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [err, setErr] = useState(null);

  useEffect(() => {
    setFiles(null); setSel(new Set()); setParsed(null); setActive(null); setErr(null); setTab("files");
    api.componentFiles(caseId, comp).then((r) => {
      setFiles(r.files);
      const matches = initialFilter ? (r.files || []).filter((x) => matchKeywords(x.path, initialFilter)) : (r.files || []);
      if (matches.length === 1) setActive(matches[0].path);
    }).catch((e) => setErr(String(e.message || e)));
  }, [caseId, comp]);

  const shown = (files || []).filter((f) => matchKeywords(f.path, filter));
  const toggle = (p) => setSel((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });

  // Group files by directory; additionally collapse rotated trace series
  // (rastrace.0, rastrace.1.gz, sktrace-*, …) that share a basename stem into a
  // single group so they don't flood the list with many rows.
  const traceStem = (name) => {
    const m = name.match(/^((?:ra-?strace|rastrace|sktrace|backtrace|wafltrace|trace[-_]?buffer))/i);
    return m ? m[1].toLowerCase().replace(/[^a-z]/g, "") : null;
  };
  const groupKey = (path) => {
    const i = path.lastIndexOf("/");
    const dir = i === -1 ? "(root)" : path.slice(0, i);
    const name = i === -1 ? path : path.slice(i + 1);
    const stem = traceStem(name) || traceStem(dir.split("/").pop() || "");
    if (stem) return "\u2234trace:" + stem;
    const m = path.match(/(^|\/)autosupport\/([^/]+)/i);
    if (m) return "autosupport/" + m[2];
    return dir;
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
  const toggleGroup = (k) => setExpandedGroups((s) => {
    const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n;
  });
  const expandAll = () => setExpandedGroups(new Set(groups.map(([k]) => k)));
  const collapseAll = () => setExpandedGroups(new Set());
  const groupLabel = (k) => {
    if (k.startsWith("\u2234trace:")) return k.slice("\u2234trace:".length) + " (series)";
    return k.split("/").pop();
  };

  // On a fresh component load, expand all normal file groups by default (so the
  // log list is shown), while keeping any large trace series collapsed.
  useEffect(() => {
    if (!files) return;
    setExpandedGroups(new Set(groups.filter(([k]) => !k.startsWith("\u2234trace:")).map(([k]) => k)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, comp]);

  const parse = async (which) => {
    const paths = which === "all" ? null : [...sel];
    setBusy(true); setErr(null);
    try {
      const r = await api.componentParse(caseId, comp, paths);
      setParsed(r); setTab("events");
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  return (
    <div style={{ ...verticalStyle(vertical), paddingBottom: grep ? "47vh" : undefined }}>
      <h2 className="content-title">{compName}</h2>
      <p className="content-subtitle">{(files || []).length} file(s) in this component</p>

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
            <button className="btn" onClick={() => parse("all")} disabled={busy}
              title="Build an event timeline (timestamp · severity · message) from every file in this component">Parse all</button>
            <button className="btn" onClick={() => parse("sel")} disabled={busy || !sel.size}
              title="Build the event timeline from only the checked files">Parse selected ({sel.size})</button>
            <button className="btn" disabled={!sel.size} onClick={() => setGrep([...sel])}
              title="Full-text search (substring/regex) across the checked files">Grep selected ({sel.size})</button>
            <button className="btn" onClick={() => setGrep((files || []).map((f) => f.path))}
              title="Full-text search across every file in this component (ignores the name filter above)">Grep all</button>
            <CompareControls caseId={caseId} comp={comp} paths={[...sel]} cases={cases} />
          </div>

          {!files ? <div className="info-text">Loading…</div> : shown.length === 0 ? (
            <div className="empty-state">No files in this component.</div>
          ) : (
            <div className="split">
              <div className="split-list">
                <div className="list-controls">
                  <ExpandToggle expanded={!!filter || (groups.length > 0 && groups.every(([k]) => expandedGroups.has(k)))}
                    onExpandAll={expandAll} onCollapseAll={collapseAll} />
                  <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>{groups.length} dir(s)</span>
                </div>
                {groups.map(([key, gfiles]) => {
                  const gexp = !!filter || expandedGroups.has(key);
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
                {active ? <InlineContent caseId={caseId} comp={comp} path={active} key={active} />
                  : <div className="empty-state">Select a file on the left to view it.</div>}
              </div>
            </div>
          )}
        </>
      )}

      {tab === "events" && (
        parsed ? <EventsTable events={parsed.events} total={parsed.total}
          onOpenFile={(p) => { setActive(p); setTab("files"); }} />
          : <div className="empty-state">No parsed files yet. Go to the Files tab and Parse.</div>
      )}

      {grep && <GrepModal caseId={caseId} comp={comp} paths={grep}
        onOpenFile={(p) => { setActive(p); setTab("files"); }}
        onClose={() => setGrep(null)} />}
    </div>
  );
}
