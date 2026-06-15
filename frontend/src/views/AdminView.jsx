import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

export default function AdminView({ plugins }) {
  const [sub, setSub] = useState("feedback");
  return (
    <div>
      <h2 className="content-title">Admin (gated)</h2>
      <p className="content-subtitle">Mapping overrides, retention, feedback inbox.</p>
      <div className="tabs">
        {["feedback", "mappings", "password", "plugins"].map((s) => (
          <button key={s} className={`tab ${sub === s ? "active" : ""}`} onClick={() => setSub(s)}>{s}</button>
        ))}
      </div>
      {sub === "feedback" && <FeedbackInbox />}
      {sub === "mappings" && <Mappings plugins={plugins} />}
      {sub === "password" && <ChangePassword />}
      {sub === "plugins" && <PluginsPanel plugins={plugins} />}
    </div>
  );
}

function FeedbackInbox() {
  const [items, setItems] = useState(null);
  const [status, setStatus] = useState("");
  const load = () => api.listFeedback({ status: status || undefined }).then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { load(); }, [status]);
  const upd = async (fid, s) => { await api.updateFeedback(fid, s); load(); };
  const del = async (fid) => { await api.deleteFeedback(fid); load(); };
  return (
    <div>
      <div className="toolbar">
        <span className="muted">Status filter:</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">all</option><option>open</option><option>read</option><option>done</option><option>wontfix</option>
        </select>
        <button className="btn" onClick={load}>Refresh</button>
      </div>
      {!items ? <div className="info-text">Loading…</div> : items.length === 0 ? <div className="empty-state">No feedback</div> : (
        <table className="file-table"><thead><tr><th>Category</th><th>Message</th><th>Submitter</th><th>Status</th><th></th></tr></thead>
          <tbody>{items.map((f) => (
            <tr key={f.id}><td>{f.category}</td><td>{f.message}</td><td className="muted">{f.submitter || "—"}</td>
              <td><select value={f.status} onChange={(e) => upd(f.id, e.target.value)}>
                <option>open</option><option>read</option><option>done</option><option>wontfix</option></select></td>
              <td><button className="icon-btn danger" onClick={() => del(f.id)}>Delete</button></td></tr>
          ))}</tbody></table>
      )}
    </div>
  );
}

function Mappings({ plugins }) {
  const [items, setItems] = useState(null);
  const [form, setForm] = useState({ match_type: "filename", match_value: "", target_vertical: "", target_component: "", scope: "global", note: "" });
  const load = () => api.mappings().then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, []);
  const comps = (plugins || []).flatMap((v) => v.components.map((c) => ({ ...c, vertical: v.vertical })));
  const create = async () => {
    if (!form.match_value || !form.target_component) return;
    const comp = comps.find((c) => c.component === form.target_component);
    await api.createMapping({ ...form, target_vertical: comp ? comp.vertical : form.target_vertical });
    setForm({ ...form, match_value: "", note: "" }); load();
  };
  const del = async (mid) => { await api.deleteMapping(mid); load(); };
  return (
    <div>
      <div className="card">
        <div className="toolbar">
          <select value={form.match_type} onChange={(e) => setForm({ ...form, match_type: e.target.value })}>
            <option value="filename">filename</option><option value="path">path</option><option value="regex">regex</option>
          </select>
          <input placeholder="match value" value={form.match_value} onChange={(e) => setForm({ ...form, match_value: e.target.value })} />
          <select value={form.target_component} onChange={(e) => setForm({ ...form, target_component: e.target.value })}>
            <option value="">target component…</option>
            {comps.map((c) => <option key={c.component} value={c.component}>{c.vertical} / {c.display_name}</option>)}
          </select>
          <input placeholder="note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <button className="btn primary" onClick={create}>Add mapping</button>
        </div>
      </div>
      {!items ? <div className="info-text">Loading…</div> : items.length === 0 ? <div className="empty-state">No mappings</div> : (
        <table className="file-table"><thead><tr><th>Match</th><th>Target</th><th>Scope</th><th>Note</th><th></th></tr></thead>
          <tbody>{items.map((m) => (
            <tr key={m.id}><td className="mono">{m.match_type}: {m.match_value}</td>
              <td>{m.target_vertical} / {m.target_component}</td><td>{m.scope}</td><td className="muted">{m.note || "—"}</td>
              <td><button className="icon-btn danger" onClick={() => del(m.id)}>Delete</button></td></tr>
          ))}</tbody></table>
      )}
    </div>
  );
}

function ChangePassword() {
  const [oldp, setOld] = useState(""); const [n1, setN1] = useState(""); const [n2, setN2] = useState("");
  const [msg, setMsg] = useState(null); const [err, setErr] = useState(null);
  const submit = async () => {
    setErr(null); setMsg(null);
    if (n1.length < 8) return setErr("New password must be at least 8 characters.");
    if (n1 !== n2) return setErr("New passwords do not match.");
    try { await api.changePassword(oldp, n1); setMsg("Password changed."); setOld(""); setN1(""); setN2(""); }
    catch (e) { setErr(String(e.message || e)); }
  };
  return (
    <div className="card" style={{ maxWidth: 380 }}>
      <div className="field-stack"><label>current password</label><input type="password" value={oldp} onChange={(e) => setOld(e.target.value)} /></div>
      <div className="field-stack"><label>new password</label><input type="password" value={n1} onChange={(e) => setN1(e.target.value)} /></div>
      <div className="field-stack"><label>confirm new password</label><input type="password" value={n2} onChange={(e) => setN2(e.target.value)} /></div>
      {err && <div className="error-text">{err}</div>}
      {msg && <div className="info-text">{msg}</div>}
      <button className="btn primary" onClick={submit}>Change password</button>
    </div>
  );
}

function PluginsPanel({ plugins }) {
  const [msg, setMsg] = useState(null);
  const reload = async () => { const r = await api.reloadPlugins(); setMsg(`Reloaded ${r.verticals} verticals.`); };
  return (
    <div>
      <div className="toolbar"><button className="btn" onClick={reload}>Reload plugins</button>{msg && <span className="info-text">{msg}</span>}</div>
      {(plugins || []).map((v) => (
        <div className="card" key={v.vertical}>
          <b>{v.display_name}</b>
          <div className="muted" style={{ fontSize: 12 }}>
            {v.components.map((c) => `${c.display_name} (${c.patterns})`).join(" · ")}
          </div>
        </div>
      ))}
    </div>
  );
}
