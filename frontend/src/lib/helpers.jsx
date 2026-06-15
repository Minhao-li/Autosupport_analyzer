import React, { useState } from "react";

// A per-column value filter: a ▾ button on a table header that opens a dropdown
// listing the distinct values in that column (with counts) as checkboxes, so the
// user can filter rows to the chosen values. `values` is the full list of that
// column's cell values across all rows; `selected` is a Set of chosen values
// (empty = no filter); `onChange(newSet)` is called on edits.
export function ColumnFilter({ values, selected, onChange, label }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const counts = React.useMemo(() => {
    const m = new Map();
    for (const v of values) {
      const k = v == null || v === "" ? "(empty)" : String(v);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [values]);
  const active = selected && selected.size > 0;
  const shown = q ? counts.filter(([k]) => k.toLowerCase().includes(q.toLowerCase())) : counts;

  const toggle = (k) => {
    const n = new Set(selected || []);
    n.has(k) ? n.delete(k) : n.add(k);
    onChange(n);
  };

  return (
    <span className="col-filter" onClick={(e) => e.stopPropagation()}>
      <button type="button" className={`col-filter-btn ${active ? "active" : ""}`}
        title={active ? `Filtering ${label} (${selected.size})` : `Filter by ${label}`}
        onClick={() => setOpen((v) => !v)}>▾{active ? <span className="col-filter-dot" /> : null}</button>
      {open && (
        <>
          <div className="col-filter-overlay" onClick={() => setOpen(false)} />
          <div className="col-filter-pop">
            <div className="col-filter-head">
              <input autoFocus placeholder={`Filter ${label}…`} value={q}
                onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="col-filter-actions">
              <button className="link-btn" onClick={() => onChange(new Set(shown.map(([k]) => k)))}>Select shown</button>
              <button className="link-btn" onClick={() => onChange(new Set())}>Clear</button>
            </div>
            <div className="col-filter-list">
              {shown.length === 0 ? <div className="muted" style={{ padding: 6, fontSize: 12 }}>No values</div> :
                shown.map(([k, n]) => (
                  <label key={k} className="col-filter-item">
                    <input type="checkbox" checked={!!selected && selected.has(k)} onChange={() => toggle(k)} />
                    <span className="col-filter-val" title={k}>{k}</span>
                    <span className="muted col-filter-count">{n}</span>
                  </label>
                ))}
            </div>
          </div>
        </>
      )}
    </span>
  );
}

// Does a cell value match a column's selected-value set? (Empty set = match.)
export function colMatches(selected, value) {
  if (!selected || selected.size === 0) return true;
  const k = value == null || value === "" ? "(empty)" : String(value);
  return selected.has(k);
}

export const SEVERITIES = ["CRIT", "ERR", "WARN", "NOTICE", "INFO", "DEBUG"];

const _ENTITIES = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" };
export function decodeXml(s) {
  return String(s == null ? "" : s)
    .replace(/&(lt|gt|amp|quot|apos);/g, (m) => _ENTITIES[m])
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

// Convert an XML-ish line into [tag, value] pairs (leaf <tag>value</tag>
// elements, falling back to attributes). Returns [] when the line isn't XML.
export function xmlPairs(text) {
  const pairs = [];
  const re = /<([\w.:-]+)(?:\s+[^>]*)?>([^<>]*)<\/\1>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const val = decodeXml(m[2]).trim();
    if (val !== "") pairs.push([m[1], val]);
  }
  if (!pairs.length) {
    const ra = /([\w.:-]+)="([^"]*)"/g;
    let a;
    while ((a = ra.exec(text)) !== null) pairs.push([a[1], decodeXml(a[2])]);
  }
  return pairs;
}


export const VERTICAL_COLORS = {
  core: "#6366f1",        // indigo
  storage: "#10b981",     // emerald
  network: "#0ea5e9",     // sky
  protocols: "#8b5cf6",   // violet
  hardware: "#f59e0b",    // amber
  dp: "#f43f5e",          // rose
  performance: "#06b6d4", // cyan
  misc: "#64748b",        // slate
};

function _hexToSoft(hex, a = 0.12) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function verticalColor(vertical) {
  return VERTICAL_COLORS[vertical] || "#6366f1";
}

export function verticalStyle(vertical) {
  const c = verticalColor(vertical);
  return { "--accent": c, "--accent-hover": c, "--accent-soft": _hexToSoft(c) };
}

export function fmtBytes(n) {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// Display label for a loaded case: "<case number> · <node name>".
// Falls back to cluster/id when the node name isn't known yet.
export function caseLabel(c) {
  if (!c) return "";
  const node = c.node || c.cluster || c.id;
  return c.case_number ? `${c.case_number} · ${node}` : node;
}

// Parse a filter/search string into AND-groups of OR-terms. The result is a
// list of groups; ALL groups must match (AND / nested filter), and within a
// group ANY term matches (OR).
//   OR  separator: "|"  or the whole word "or"
//   AND separator: "||" or the whole word "and"
// e.g. `disk|aggr || error` → [["disk","aggr"], ["error"]] meaning
// (disk OR aggr) AND error. An empty/operator-only query yields [].
export function parseQuery(q) {
  const s = String(q == null ? "" : q);
  // AND first ("||" or " and "); leftover single "|" become OR separators.
  const andParts = s.split(/\s*\|\|\s*|\s+and\s+/i);
  const groups = [];
  for (const part of andParts) {
    const terms = part.split(/\s*\|\s*|\s+or\s+/i).map((t) => t.trim()).filter((t) => t !== "");
    if (terms.length) groups.push(terms);
  }
  return groups;
}

// Flat list of every literal term across all groups (used for highlighting).
export function allTerms(q) {
  return parseQuery(q).flat();
}

// True when `text` satisfies the query: every AND-group has at least one of its
// OR-terms present (case-insensitive). An empty query matches everything.
export function matchKeywords(text, q) {
  const groups = parseQuery(q);
  if (!groups.length) return true;
  const t = String(text == null ? "" : text).toLowerCase();
  return groups.every((terms) => terms.some((k) => t.includes(k.toLowerCase())));
}

// Like matchKeywords but across multiple field values: every AND-group must be
// satisfied by SOME field (OR within the group, across all fields).
export function matchKeywordsAny(values, q) {
  const groups = parseQuery(q);
  if (!groups.length) return true;
  const lows = values.map((v) => String(v == null ? "" : v).toLowerCase());
  return groups.every((terms) => {
    const lk = terms.map((k) => k.toLowerCase());
    return lows.some((t) => lk.some((k) => t.includes(k)));
  });
}

export function Highlight({ text, q }) {
  const kws = allTerms(q);
  if (!kws.length || !text) return <>{text}</>;
  const alt = kws.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const parts = String(text).split(new RegExp(`(${alt})`, "ig"));
  const lowset = new Set(kws.map((k) => k.toLowerCase()));
  return <>{parts.map((p, i) => lowset.has(p.toLowerCase())
    ? <mark className="hl" key={i}>{p}</mark> : <span key={i}>{p}</span>)}</>;
}

export function Spinner({ label }) {
  return <span className="info-text"><span className="spin" /> {label || "Loading…"}</span>;
}

// Copy text to the clipboard in BOTH secure (HTTPS/localhost) and insecure
// (plain-HTTP) contexts. navigator.clipboard is undefined over plain HTTP, so we
// fall back to a hidden <textarea> + execCommand("copy"). Never throws; resolves
// to true on success, false otherwise.
export async function copyToClipboard(text) {
  const s = text == null ? "" : String(text);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* fall through to the legacy path below */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, s.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// A prominent "?" help badge that reveals a detailed, animated popover on hover
// or focus, documenting the search/filter operator syntax. Pass `regex` to add
// a regex tip and `content` to wrap raw-text inputs (vs the styled FilterInput).
export function SearchHelp({ regex = false, align = "left" }) {
  return (
    <span className={`search-help search-help-${align}`} tabIndex={0} aria-label="Search syntax help" role="button">
      <span className="search-help-badge">?</span>
      <span className="search-help-pop" role="tooltip">
        <span className="search-help-title">Search syntax</span>
        <span className="search-help-row">
          <code>a|b</code><span className="search-help-sep">or</span><code>a or b</code>
          <span className="search-help-desc">match <b>any</b> — OR</span>
        </span>
        <span className="search-help-row">
          <code>a||b</code><span className="search-help-sep">or</span><code>a and b</code>
          <span className="search-help-desc">match <b>all</b> — AND (filter within results)</span>
        </span>
        <span className="search-help-ex">
          e.g. <code>disk|aggr || error</code><br />
          → (disk <b>or</b> aggr) <b>and</b> error
        </span>
        <span className="search-help-note">
          {regex
            ? <>Enable <b>regex</b> to use full regular expressions instead.</>
            : <>Matching is case-insensitive. All matched terms are highlighted.</>}
        </span>
      </span>
    </span>
  );
}

export function useToggleSet(initial) {
  const [set, setSet] = useState(new Set(initial));
  const toggle = (v) => setSet((s) => {
    const n = new Set(s);
    n.has(v) ? n.delete(v) : n.add(v);
    return n;
  });
  return [set, toggle, setSet];
}

// A single dual-action button that toggles between "Expand all" and "Collapse
// all". Pass `expanded` (true when everything is currently expanded) and the
// two handlers; the button shows the action it will perform and animates its
// chevron when flipping between states.
export function ExpandToggle({ expanded, onExpandAll, onCollapseAll, style }) {
  return (
    <button type="button" style={style}
      className={`link-btn expand-toggle${expanded ? " is-expanded" : ""}`}
      aria-pressed={expanded}
      title={expanded ? "Collapse all" : "Expand all"}
      onClick={() => (expanded ? onCollapseAll() : onExpandAll())}>
      <span className="expand-toggle-icon" aria-hidden="true" />
      {expanded ? "Collapse all" : "Expand all"}
    </button>
  );
}

// Text filter input with a clear (✕) button and Esc-to-clear. Pass the current
// string `value` and an `onChange` that receives the new string. Any extra
// props (placeholder, className, autoFocus…) are forwarded to the <input>;
// `style` applies to the input, `wrapStyle` to the wrapper.
export function FilterInput({ value, onChange, className, style, wrapStyle, onKeyDown, ...rest }) {
  const ref = React.useRef(null);
  const clear = () => { onChange(""); if (ref.current) ref.current.focus(); };
  return (
    <span className="filter-input-wrap" style={wrapStyle}>
      <input ref={ref} className={className} value={value} style={style}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && (value || "") !== "") { e.preventDefault(); clear(); }
          if (onKeyDown) onKeyDown(e);
        }}
        {...rest} />
      {(value || "") !== "" && (
        <button type="button" className="filter-input-clear" tabIndex={-1}
          title="Clear (Esc)" aria-label="Clear" onClick={clear}>✕</button>
      )}
    </span>
  );
}
