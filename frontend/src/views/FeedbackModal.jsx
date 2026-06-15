import React, { useState } from "react";
import { api } from "../lib/api.js";

export default function FeedbackModal({ pageContext, onClose }) {
  const [category, setCategory] = useState("bug");
  const [message, setMessage] = useState("");
  const [submitter, setSubmitter] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!message.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api.submitFeedback({ category, message, submitter: submitter || null, page_context: pageContext || null });
      setSent(true);
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="toolbar"><b style={{ flex: 1 }}>Found a bug or want a feature?</b>
          <button className="icon-btn" onClick={onClose}>Close</button></div>
        {sent ? <div className="empty-state">Thanks for the feedback!</div> : (
          <>
            <div className="field-stack"><label>Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="bug">Bug</option><option value="feature">Feature request</option>
                <option value="ux">UX / Layout</option><option value="other">Other</option>
              </select></div>
            <div className="field-stack"><label>Message</label>
              <textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} /></div>
            <div className="field-stack"><label>Your name (optional)</label>
              <input value={submitter} onChange={(e) => setSubmitter(e.target.value)} placeholder="e.g. minhao" /></div>
            {err && <div className="error-text">{err}</div>}
            <button className="btn primary" onClick={submit} disabled={busy}>{busy ? "Sending…" : "Submit"}</button>
          </>
        )}
      </div>
    </div>
  );
}
