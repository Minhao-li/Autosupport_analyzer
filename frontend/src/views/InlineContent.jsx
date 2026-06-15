import React, { useEffect, useState } from "react";
import XmlTable from "./XmlTable.jsx";
import EmsTable from "./EmsTable.jsx";
import MgwdTable from "./MgwdTable.jsx";
import SktraceTable from "./SktraceTable.jsx";
import IfstatView from "./IfstatView.jsx";
import { copyToClipboard } from "../lib/helpers.jsx";

export default function InlineContent({ caseId, comp, path }) {
  const isXml = /\.xml(\.gz)?$/i.test(path || "");
  const isEmsName = /ems[-_]?log[-_]?file/i.test(path || "");
  const isMlogName = /(^|\/)(mgwd|secd|vifmgr|bcomd|notifyd|spmgwd)(\.|$|_)/i.test(path || "");
  const isSktraceName = /(^|\/)sktrace(\.gz)?$/i.test(path || "");
  const isIfstatName = /ifstat/i.test(path || "");
  const [mode, setMode] = useState(isXml ? "table" : isEmsName ? "ems" : isMlogName ? "mlog" : isSktraceName ? "sktrace" : isIfstatName ? "ifstat" : "raw");
  const [full, setFull] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [emsDetected, setEmsDetected] = useState(false);
  const [mlogDetected, setMlogDetected] = useState(false);
  const [sktraceDetected, setSktraceDetected] = useState(false);
  const [ifstatDetected, setIfstatDetected] = useState(false);

  useEffect(() => {
    setMode(isXml ? "table" : isEmsName ? "ems" : isMlogName ? "mlog" : isSktraceName ? "sktrace" : isIfstatName ? "ifstat" : "raw");
    setEmsDetected(false); setMlogDetected(false); setSktraceDetected(false); setIfstatDetected(false);
  }, [path, isXml, isEmsName, isMlogName, isSktraceName, isIfstatName]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (mode !== "raw") return;
    setData(null); setErr(null);
    const url = comp
      ? `/api/cases/${caseId}/components/${comp}/file_content?path=${encodeURIComponent(path)}`
      : `/api/cases/${caseId}/file_content?path=${encodeURIComponent(path)}`;
    fetch(url, { credentials: "same-origin" })
      .then((r) => r.json()).then((d) => {
        setData(d);
        if (!isXml && !isEmsName && d && !d.binary && (d.content || "").trimStart().startsWith("<LR "))
          setEmsDetected(true);
        if (!isXml && d && !d.binary &&
            /^[0-9a-f]{8}\.[0-9a-f]+ [0-9a-f]{8} [A-Z][a-z]{2} [A-Z][a-z]{2} /m.test((d.content || "").slice(0, 4000)))
          setMlogDetected(true);
        if (!isXml && !isSktraceName && d && !d.binary &&
            /^\d{4}-\d{2}-\d{2}T[0-9:]+Z \d+ +\[\d+:\d+\] /m.test((d.content || "").slice(0, 4000)))
          setSktraceDetected(true);
        if (!isXml && !isIfstatName && d && !d.binary &&
            /-- interface /.test((d.content || "").slice(0, 4000)) &&
            /(RECEIVE|TRANSMIT)/.test((d.content || "").slice(0, 4000)))
          setIfstatDetected(true);
      }).catch((e) => setErr(String(e)));
  }, [caseId, comp, path, mode, isXml, isEmsName, isMlogName, isSktraceName, isIfstatName]);

  const copy = () => { if (data) copyToClipboard(data.content || ""); };
  const showEmsToggle = isEmsName || emsDetected;
  const showMlogToggle = (isMlogName || mlogDetected) && !emsDetected;
  const showSktraceToggle = isSktraceName || sktraceDetected;
  const showIfstatToggle = isIfstatName || ifstatDetected;

  const body = (
    <>
      <div className="content-toolbar">
        <span className="file-pill mono">{path}</span>
        <span style={{ flex: 1 }} />
        {isXml && (
          <div className="seg">
            <button className={mode === "table" ? "on" : ""} onClick={() => setMode("table")}>Table</button>
            <button className={mode === "raw" ? "on" : ""} onClick={() => setMode("raw")}>Raw</button>
          </div>
        )}
        {showEmsToggle && (
          <div className="seg">
            <button className={mode === "ems" ? "on" : ""} onClick={() => setMode("ems")}>EMS</button>
            <button className={mode === "raw" ? "on" : ""} onClick={() => setMode("raw")}>Raw</button>
          </div>
        )}
        {showMlogToggle && (
          <div className="seg">
            <button className={mode === "mlog" ? "on" : ""} onClick={() => setMode("mlog")}>mlog</button>
            <button className={mode === "raw" ? "on" : ""} onClick={() => setMode("raw")}>Raw</button>
          </div>
        )}
        {showSktraceToggle && (
          <div className="seg">
            <button className={mode === "sktrace" ? "on" : ""} onClick={() => setMode("sktrace")}>sktrace</button>
            <button className={mode === "raw" ? "on" : ""} onClick={() => setMode("raw")}>Raw</button>
          </div>
        )}
        {showIfstatToggle && (
          <div className="seg">
            <button className={mode === "ifstat" ? "on" : ""} onClick={() => setMode("ifstat")}>Stats</button>
            <button className={mode === "raw" ? "on" : ""} onClick={() => setMode("raw")}>Raw</button>
          </div>
        )}
        {mode === "raw" && data && !data.binary && <button className="icon-btn" onClick={copy}>Copy</button>}
        <button className="icon-btn" title={full ? "Exit fullscreen (Esc)" : "Maximize"} onClick={() => setFull(!full)}>
          {full ? "⤡ Minimize" : "⤢ Maximize"}
        </button>
      </div>

      {mode === "table" && isXml && <XmlTable caseId={caseId} comp={comp} path={path} />}
      {mode === "ems" && <EmsTable caseId={caseId} comp={comp} path={path} />}
      {mode === "mlog" && <MgwdTable caseId={caseId} comp={comp} path={path} />}
      {mode === "sktrace" && <SktraceTable caseId={caseId} comp={comp} path={path} />}
      {mode === "ifstat" && <IfstatView caseId={caseId} comp={comp} path={path} />}

      {mode === "raw" && (
        <>
          {err && <div className="error-text">{err}</div>}
          {!data && !err && <div className="info-text"><span className="spin" /> Loading…</div>}
          {data && data.binary && <div className="empty-state">binary hidden — {data.size} bytes</div>}
          {data && !data.binary && (
            <>
              {emsDetected && (
                <div className="info-text" style={{ marginBottom: 8 }}>
                  Looks like an EMS log. <a style={{ cursor: "pointer" }} onClick={() => setMode("ems")}>Show as EMS table →</a>
                </div>
              )}
              {mlogDetected && !emsDetected && (
                <div className="info-text" style={{ marginBottom: 8 }}>
                  Looks like a daemon (mlog) log. <a style={{ cursor: "pointer" }} onClick={() => setMode("mlog")}>Show as mlog table →</a>
                </div>
              )}
              {sktraceDetected && (
                <div className="info-text" style={{ marginBottom: 8 }}>
                  Looks like an sktrace log. <a style={{ cursor: "pointer" }} onClick={() => setMode("sktrace")}>Show as sktrace table →</a>
                </div>
              )}
              {ifstatDetected && (
                <div className="info-text" style={{ marginBottom: 8 }}>
                  Looks like an IFSTAT counter dump. <a style={{ cursor: "pointer" }} onClick={() => setMode("ifstat")}>Show interface error/discard stats →</a>
                </div>
              )}
              {data.truncated && <div className="info-text">Truncated to {data.content.length} bytes of {data.size}.</div>}
              <pre className="mono raw-pre">{data.content}</pre>
            </>
          )}
        </>
      )}
    </>
  );

  if (full) return <div className="fullscreen-panel">{body}</div>;
  return <div>{body}</div>;
}
