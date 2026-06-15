import React, { useEffect, useState } from "react";
import XmlTable from "./XmlTable.jsx";
import { copyToClipboard } from "../lib/helpers.jsx";

export default function FileViewer({ caseId, comp, path, onClose }) {
  const isXml = /\.xml(\.gz)?$/i.test(path || "");
  const [mode, setMode] = useState(isXml ? "table" : "raw");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (mode !== "raw") return;
    setData(null); setErr(null);
    const url = comp
      ? `/api/cases/${caseId}/components/${comp}/file_content?path=${encodeURIComponent(path)}`
      : `/api/cases/${caseId}/file_content?path=${encodeURIComponent(path)}`;
    fetch(url, { credentials: "same-origin" })
      .then((r) => r.json()).then(setData).catch((e) => setErr(String(e)));
  }, [caseId, comp, path, mode]);

  const copy = () => { if (data) copyToClipboard(data.content || ""); };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal priority" onClick={(e) => e.stopPropagation()}>
        <div className="toolbar">
          <b className="mono" style={{ flex: 1, wordBreak: "break-all" }}>{path}</b>
          {isXml && (
            <>
              <button className="icon-btn" onClick={() => setMode("table")} disabled={mode === "table"}>Table</button>
              <button className="icon-btn" onClick={() => setMode("raw")} disabled={mode === "raw"}>Raw</button>
            </>
          )}
          {mode === "raw" && data && !data.binary && <button className="icon-btn" onClick={copy}>Copy</button>}
          <button className="icon-btn" onClick={onClose}>Close</button>
        </div>

        {mode === "table" && isXml && <XmlTable caseId={caseId} comp={comp} path={path} />}

        {mode === "raw" && (
          <>
            {err && <div className="error-text">{err}</div>}
            {!data && !err && <div className="info-text">Loading…</div>}
            {data && data.binary && <div className="empty-state">binary hidden — {data.size} bytes</div>}
            {data && !data.binary && (
              <>
                {data.truncated && <div className="info-text">Truncated to {data.content.length} bytes of {data.size}.</div>}
                <pre className="mono" style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: "70vh", overflow: "auto", background: "var(--panel-2)", padding: 10, borderRadius: 8 }}>{data.content}</pre>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
