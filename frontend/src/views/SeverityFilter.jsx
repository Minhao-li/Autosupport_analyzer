import React, { useState } from "react";
import { SEVERITIES } from "../lib/helpers.jsx";

// Dropdown severity filter: a checkbox per severity + select/deselect all.
// `selected` is a Set of severities to show; `onChange(nextSet)` updates it.
export default function SeverityFilter({ selected, onChange, counts = {} }) {
  const [open, setOpen] = useState(false);
  const all = selected.size === SEVERITIES.length;
  const toggle = (s) => { const n = new Set(selected); n.has(s) ? n.delete(s) : n.add(s); onChange(n); };

  return (
    <div style={{ position: "relative" }}>
      <button className="btn" onClick={() => setOpen((v) => !v)} title="Choose which severities to show">
        Severity ({selected.size}/{SEVERITIES.length}) ▾
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 20 }} />
          <div className="theme-menu" style={{ position: "absolute", zIndex: 21, minWidth: 190, padding: 6 }}>
            <label className="theme-option" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={all}
                ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !all; }}
                onChange={(e) => onChange(e.target.checked ? new Set(SEVERITIES) : new Set())} />
              <b>{all ? "Deselect all" : "Select all"}</b>
            </label>
            <div style={{ borderTop: "1px solid var(--border, #2a3142)", margin: "4px 0" }} />
            {SEVERITIES.map((s) => (
              <label key={s} className="theme-option"
                style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" checked={selected.has(s)} onChange={() => toggle(s)} />
                  <span className={`chip sev-${s}`} style={{ opacity: counts[s] ? 1 : 0.5 }}>{s}</span>
                </span>
                <span className="muted">{counts[s] || 0}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
