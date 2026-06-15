import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { FilterInput, matchKeywordsAny, SearchHelp, copyToClipboard } from "../lib/helpers.jsx";

function Cell({ value }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="muted">—</span>;
    return <span>{value.map((v, i) => <span key={i} className="chip" style={{ marginRight: 4 }}>{v}</span>)}</span>;
  }
  if (value === "" || value == null) return <span className="muted">—</span>;
  return <span className="mono">{value}</span>;
}

export default function XmlTable({ caseId, comp, path }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState("");
  const [sortCol, setSortCol] = useState(null);
  const [asc, setAsc] = useState(true);
  const [orient, setOrient] = useState(null); // null=auto, 'h'=rows, 'v'=columns
  const [copied, setCopied] = useState(null);
  const [menu, setMenu] = useState(null);   // {x, y, items:[{label,text}]}
  const [toast, setToast] = useState(null);

  const fmtVal = (v) => (Array.isArray(v) ? v.join(", ") : (v == null ? "" : String(v)));
  const openMenu = (e, items) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items }); };
  const doCopy = async (text) => {
    setMenu(null);
    const ok = await copyToClipboard(text);
    setToast(ok ? "✓ Copied" : "⚠ Copy failed");
    setTimeout(() => setToast(null), 1200);
  };

  const copyText = async (t) => {
    const s = Array.isArray(t) ? t.join(", ") : String(t ?? "");
    const ok = await copyToClipboard(s);
    setToast(ok ? "✓ Copied" : "⚠ Copy failed");
    setCopied(ok ? s : null);
    setTimeout(() => { setCopied(null); setToast(null); }, 1000);
  };

  useEffect(() => {
    setData(null); setErr(null); setSortCol(null);
    api.xmlTable(caseId, path, comp).then((r) => {
      if (!r.ok) setErr(r.error || "Could not parse XML as a table.");
      else setData(r);
    }).catch((e) => setErr(String(e.message || e)));
  }, [caseId, comp, path]);

  const rows = useMemo(() => {
    if (!data) return [];
    let r = data.rows.map((row, i) => ({ __i: i, ...row }));
    if (filter) {
      r = r.filter((row) => matchKeywordsAny(
        data.column_tags.map((t) => {
          const v = row[t];
          return Array.isArray(v) ? v.join(" ") : (v ?? "");
        }), filter));
    }
    if (sortCol) {
      r.sort((a, b) => {
        const av = a[sortCol], bv = b[sortCol];
        const as = Array.isArray(av) ? av.join(",") : (av ?? "");
        const bs = Array.isArray(bv) ? bv.join(",") : (bv ?? "");
        const an = parseFloat(as), bn = parseFloat(bs);
        const cmp = (!isNaN(an) && !isNaN(bn)) ? an - bn : String(as).localeCompare(String(bs));
        return cmp * (asc ? 1 : -1);
      });
    }
    return r;
  }, [data, filter, sortCol, asc]);

  const sortBy = (t) => { if (sortCol === t) setAsc(!asc); else { setSortCol(t); setAsc(true); } };

  if (err) return <div className="error-text">{err}</div>;
  if (!data) return <div className="info-text"><span className="spin" /> Parsing XML…</div>;

  const m = data.meta || {};
  const vertical = orient ? orient === "v" : data.row_count <= 1;
  return (
    <div>
      <div className="card" style={{ marginBottom: 10 }}>
        <b>{m.table_desc || m.table_name || data.meta.root}</b>
        <span className="muted" style={{ fontSize: 12 }}>
          {" "}· table <span className="mono">{m.table_name}</span>
          {m.data_scope ? ` · scope ${m.data_scope}` : ""}
          {data.generic ? " · generic XML" : ""}
        </span>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {data.column_tags.length} columns · {data.total_rows} rows
          {data.truncated ? ` (showing first ${data.row_count})` : ""}
          {data.aborted ? " · collection ABORTED" : ""}
          {m.node_sn ? ` · node ${m.node_sn}` : ""}
        </div>
      </div>

      <div className="toolbar">
        <FilterInput placeholder="Filter rows…" value={filter} onChange={setFilter} wrapStyle={{ minWidth: 220 }} style={{ minWidth: 220 }} />
        <SearchHelp />
        <button className="btn primary" onClick={() => setOrient(vertical ? "h" : "v")}
          title="Switch table between horizontal (rows) and vertical (columns)">
          ⇄ Switch orientation
        </button>
        <span className={`chip orient-badge ${vertical ? "orient-v" : "orient-h"}`}>
          {vertical ? "Vertical" : "Horizontal"}
        </span>
        <span className="muted">{rows.length} / {data.row_count} rows</span>
      </div>

      {data.column_tags.length === 0 || rows.length === 0 ? (
        <div className="empty-state">No rows.</div>
      ) : vertical ? (
        <div className="xml-scroll">
          <table className="file-table tbl-vertical">
            {rows.length > 1 && (
              <thead><tr>
                <th className="vt-field-head"></th>
                {rows.map((row, i) => (
                  <th key={row.__i}
                    onContextMenu={(e) => openMenu(e, [
                      { label: `Copy record #${i + 1} (field: value)`, text: data.columns.map((c) => `${c.ui_name || c.tag}: ${fmtVal(row[c.tag])}`).join("\n") },
                      { label: "Copy values only", text: data.columns.map((c) => fmtVal(row[c.tag])).join("\n") },
                    ])}
                    title="Right-click to copy this record (column)">#{i + 1}</th>
                ))}
              </tr></thead>
            )}
            <tbody>
              {data.columns.map((c) => (
                <tr key={c.tag} onContextMenu={(e) => openMenu(e, [
                  { label: "Copy field name", text: c.ui_name || c.tag },
                  { label: "Copy line (field: values)", text: `${c.ui_name || c.tag}: ${rows.map((row) => fmtVal(row[c.tag])).join("\t")}` },
                  { label: "Copy values only", text: rows.map((row) => fmtVal(row[c.tag])).join("\t") },
                ])}>
                  <td className="vt-field vt-copy" title="Click to copy field name · right-click to copy the whole line"
                    onClick={() => copyText(c.ui_name || c.tag)}>
                    {c.ui_name || c.tag}
                    {copied === (c.ui_name || c.tag) && <span className="copied-tag">✓</span>}
                  </td>
                  {rows.map((row, i) => (
                    <td key={row.__i} className="vt-copy" title="Click to copy value · right-click to copy this record (column)"
                      onClick={() => copyText(row[c.tag])}
                      onContextMenu={(e) => { e.stopPropagation(); openMenu(e, [
                        { label: "Copy cell", text: fmtVal(row[c.tag]) },
                        { label: `Copy record #${i + 1} (field: value)`, text: data.columns.map((cc) => `${cc.ui_name || cc.tag}: ${fmtVal(row[cc.tag])}`).join("\n") },
                        { label: "Copy values only", text: data.columns.map((cc) => fmtVal(row[cc.tag])).join("\n") },
                      ]); }}>
                      <Cell value={row[c.tag]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="xml-scroll">
          <table className="file-table tbl-horizontal">
            <thead><tr>
              {data.columns.map((c) => (
                <th key={c.tag} onClick={() => sortBy(c.tag)}
                  onContextMenu={(e) => openMenu(e, [
                    { label: `Copy column "${c.ui_name || c.tag}"`, text: [c.ui_name || c.tag, ...rows.map((row) => fmtVal(row[c.tag]))].join("\n") },
                    { label: "Copy values only", text: rows.map((row) => fmtVal(row[c.tag])).join("\n") },
                  ])}
                  title={`${c.tag}${c.type ? " · " + c.type : ""}${c.is_list ? " (list)" : ""} · click to sort · right-click to copy this column`}>
                  {c.ui_name || c.tag}{sortCol === c.tag ? (asc ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.__i} onContextMenu={(e) => openMenu(e, [
                  { label: "Copy line (labels + values)", text: data.columns.map((c) => `${c.ui_name || c.tag}: ${fmtVal(row[c.tag])}`).join("  |  ") },
                  { label: "Copy values only", text: data.column_tags.map((t) => fmtVal(row[t])).join("\t") },
                ])} title="Right-click to copy the whole line">
                  {data.column_tags.map((t) => (
                    <td key={t} onContextMenu={(e) => { e.stopPropagation(); openMenu(e, [
                      { label: "Copy cell", text: fmtVal(row[t]) },
                      { label: "Copy line (labels + values)", text: data.columns.map((c) => `${c.ui_name || c.tag}: ${fmtVal(row[c.tag])}`).join("  |  ") },
                      { label: "Copy values only", text: data.column_tags.map((tt) => fmtVal(row[tt])).join("\t") },
                    ]); }}>
                      <Cell value={row[t]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {menu && (
        <>
          <div onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
            style={{ position: "fixed", inset: 0, zIndex: 50 }} />
          <div className="theme-menu" style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 51, minWidth: 200 }}>
            {menu.items.map((it, i) => (
              <div key={i} className="theme-option" onClick={() => doCopy(it.text)}>{it.label}</div>
            ))}
          </div>
        </>
      )}
      {toast && (
        <div style={{ position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)",
          background: "var(--panel-2, #1a2030)", color: "var(--text, #e6ecf3)", padding: "6px 14px",
          borderRadius: 6, zIndex: 60, fontSize: 13, boxShadow: "0 2px 10px rgba(0,0,0,.35)" }}>
          {toast}
        </div>
      )}
    </div>
  );
}
