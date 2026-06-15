import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

// Admin-only sign in. Regular users don't authenticate — they use the tool as
// an anonymous guest. When `onClose` is provided the form renders as a
// dismissible overlay (opened from the header "Admin login" button).
export default function Login({ onAuthed, onClose }) {
  const [status, setStatus] = useState(null);
  const [mode, setMode] = useState("admin"); // admin | setup
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.adminStatus().then((s) => {
      setStatus(s);
      setMode(s.has_password ? "admin" : "setup");
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    setErr(null); setBusy(true);
    try {
      if (mode === "setup") {
        if (password.length < 8) throw new Error("Password must be at least 8 characters.");
        if (password !== confirm) throw new Error("Passwords do not match.");
        await api.adminSetup(password);
      } else {
        await api.adminLogin(status?.username || "minhao", password);
      }
      const me = await api.me();
      onAuthed(me);
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  return (
    <div className={`login-wrap${onClose ? " login-overlay" : ""}`}
      onClick={onClose ? (e) => { if (e.target === e.currentTarget) onClose(); } : undefined}>
      <div className="login-card">
        {onClose && <button className="login-close" aria-label="Close" title="Close" onClick={onClose}>✕</button>}
        <h1 style={{ marginTop: 0 }}>Admin sign in</h1>
        <p className="muted" style={{ fontSize: 13, marginTop: -6 }}>
          Only the administrator needs to sign in. Regular users can browse and search without an account.
        </p>
        {mode === "setup" ? (
          <>
            <p className="muted" style={{ fontSize: 13 }}>First-time setup. Admin user is fixed at <b>{status?.username || "minhao"}</b>.</p>
            <div className="field-stack"><label>Set initial admin password</label>
              <input type="password" autoComplete="new-password" autoFocus value={password}
                onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} /></div>
            <div className="field-stack"><label>confirm password</label>
              <input type="password" value={confirm}
                onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} /></div>
          </>
        ) : (
          <div className="field-stack"><label>Admin password ({status?.username || "minhao"})</label>
            <input type="password" placeholder="password" autoFocus value={password}
              onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} /></div>
        )}
        {err && <div className="error-text" style={{ marginBottom: 8 }}>{err}</div>}
        <button className="btn primary" style={{ width: "100%" }} onClick={submit} disabled={busy}>
          {mode === "setup" ? "Set password & sign in" : "Sign in"}
        </button>
        {onClose && (
          <div style={{ marginTop: 12, textAlign: "center", fontSize: 13 }}>
            <a onClick={onClose} style={{ cursor: "pointer" }}>Continue as guest</a>
          </div>
        )}
      </div>
    </div>
  );
}
