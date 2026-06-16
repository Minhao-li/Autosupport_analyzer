from __future__ import annotations

import io
import json
import os
import re
import secrets
import shutil
import tempfile
import threading
import zipfile
from datetime import datetime, timezone
from typing import Optional

from fastapi import (Body, Cookie, Depends, FastAPI, File, Form, HTTPException,
                     Query, Request, Response, UploadFile)
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, constr

from . import auth, cases, parsing, plugins, topology, cluster, jobs
from .asup_xml import parse_asup_xml
from .ems_log import parse_ems_log
from .mgwd_log import parse_mgwd_log
from .sktrace_log import parse_sktrace_log
from .ifstat import parse_ifstat
from .config import (ADMIN_USER, CASES_DIR, EXTENSION_DIR, EXTENSION_NAME,
                     QUOTA_MAX_GB, QUOTA_TRIGGER_PCT, STATIC_DIR, STINGRAY_DIR)
from .db import get_db, init_db

app = FastAPI(title="Autosupport Analyzer", version="0.2.0")


@app.on_event("startup")
def _startup():
    init_db()


# ----------------------------- models -----------------------------
class LoginIn(BaseModel):
    username: str
    password: str


class SetupIn(BaseModel):
    password: constr(min_length=8, max_length=200)


class ChangePasswordIn(BaseModel):
    old_password: str
    new_password: constr(min_length=8, max_length=200)


class FeedbackIn(BaseModel):
    category: constr(pattern="^(bug|feature|ux|other)$")
    message: constr(min_length=1, max_length=8000)
    submitter: Optional[str] = None
    page_context: Optional[str] = None


class StatusUpdate(BaseModel):
    status: constr(pattern="^(open|read|done|wontfix)$")


class MappingIn(BaseModel):
    match_type: str
    match_value: str
    target_vertical: str
    target_component: str
    target_family: Optional[str] = None
    scope: str = "global"
    note: Optional[str] = None


class GrepBody(BaseModel):
    paths: list[str] = []
    pattern: str
    regex: bool = False
    case_sensitive: bool = False
    context: int = 0
    max_hits_per_file: int = 200
    max_total_hits: int = 5000


class ParseBody(BaseModel):
    files: Optional[list[str]] = None


class ParsePathsBody(BaseModel):
    paths: list[str]
    ts_from: Optional[datetime] = None
    ts_to: Optional[datetime] = None


class StingrayIn(BaseModel):
    case_num: str
    file_path: Optional[str] = None


class StingrayLoadIn(BaseModel):
    case_number: str
    paths: list[str] = []


class TokenIn(BaseModel):
    token: str
    submitter: Optional[str] = None


class TokenCaptureIn(BaseModel):
    token: str
    key: str
    submitter: Optional[str] = None


class UploadUrlIn(BaseModel):
    url: str = ""


class UploadIn(BaseModel):
    folders: list[str]
    force: bool = False
    parallel: int = 3


class PackageIn(BaseModel):
    paths: list[str]                  # relative dirs/files to include
    name: Optional[str] = None        # desired base name (without extension)
    force: bool = False               # re-compress even if the archive exists


class AiqUploadIn(BaseModel):
    archive: str                      # archive name previously built
    category: str = "browser"         # technical | browser
    submitter: Optional[str] = None


class DownloadConfigIn(BaseModel):
    download_url: Optional[str] = None   # base for asup-download/asup_id
    search_url: Optional[str] = None     # list/search template (may contain {query})


class AsupListIn(BaseModel):
    query: str = ""
    date_from: Optional[str] = None      # YYYY-MM-DD (inclusive)
    date_to: Optional[str] = None        # YYYY-MM-DD (inclusive)
    include_cluster: bool = True         # also list the other nodes in the cluster


class AsupDownloadIn(BaseModel):
    asup_ids: list[str] = []
    case_number: Optional[str] = None


# ----------------------------- helpers -----------------------------
def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _require_case_root(case_id: str) -> str:
    root = cases.case_root(case_id)
    if not root or not os.path.isdir(root):
        raise HTTPException(status_code=404, detail="Case not found")
    return root


def _safe_join(root: str, rel: str) -> str:
    full = os.path.normpath(os.path.join(root, rel))
    if not full.startswith(os.path.normpath(root)):
        raise HTTPException(status_code=400, detail="Invalid path")
    return full


def _filter_events(events, ts_from, ts_to, severities, q, nodes, limit):
    sevset = set(s.upper() for s in severities) if severities else None
    # AND-groups of OR-keywords across message/raw (nested filter support).
    qgroups = None
    if q:
        qgroups = [[t.lower() for t in terms] for terms in parsing.parse_query(q)] or [[q.lower()]]
    out = []
    for ev in events:
        if sevset and ev["severity"] not in sevset:
            continue
        if qgroups:
            ml, rl = ev["message"].lower(), ev["raw"].lower()
            if not all(any(t in ml or t in rl for t in terms) for terms in qgroups):
                continue
        out.append(ev)
        if len(out) >= limit:
            break
    return out


# ----------------------------- health/quota/plugins -----------------------------
@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/quota")
def get_quota():
    total, used, free = shutil.disk_usage(CASES_DIR)
    app_used = cases.dir_size(str(CASES_DIR))
    app_gb = round(app_used / 1e9, 2)
    total_gb = round(total / 1e9)
    pct = round(app_gb / QUOTA_MAX_GB * 100, 1) if QUOTA_MAX_GB else 0
    return {
        "total_gb": total_gb,
        "disk_free_gb": round(free / 1e9, 2),
        "disk_used_gb": round(used / 1e9, 2),
        "app_used_gb": app_gb,
        "app_pct": pct,
        "used_gb": app_gb,
        "max_gb": QUOTA_MAX_GB,
        "trigger_pct": QUOTA_TRIGGER_PCT,
    }


@app.get("/api/plugins")
def list_plugins():
    return plugins.plugins_payload()


@app.post("/api/plugins/reload")
def reload_plugins(_=Depends(auth.require_admin)):
    return {"ok": True, "verticals": len(plugins.TAXONOMY)}


# ----------------------------- user auth -----------------------------
@app.post("/api/auth/login")
def auth_login(body: LoginIn, response: Response):
    token = auth.create_session(body.username or "user", is_admin=False)
    response.set_cookie(auth.SESSION_COOKIE, token, httponly=True, samesite="lax")
    return {"username": body.username or "user", "is_admin": False}


@app.post("/api/auth/logout")
def auth_logout(response: Response, sla_session: Optional[str] = Cookie(default=None)):
    auth.destroy_session(sla_session)
    response.delete_cookie(auth.SESSION_COOKIE)
    return {"ok": True}


@app.get("/api/auth/me")
def auth_me(sla_session: Optional[str] = Cookie(default=None)):
    row = auth.current_session(sla_session)
    if not row:
        return None
    return {"username": row["username"], "is_admin": bool(row["is_admin"])}


# ----------------------------- admin -----------------------------
@app.get("/api/admin/status")
def admin_status():
    row = auth.admin_row()
    return {
        "username": ADMIN_USER,
        "has_password": auth.admin_has_password(),
        "password_set_at": row["password_set_at"] if row else None,
    }


@app.post("/api/admin/setup")
def admin_setup(body: SetupIn, response: Response):
    if auth.admin_has_password():
        raise HTTPException(status_code=400, detail="Admin already set up")
    auth.set_admin_password(body.password)
    token = auth.create_session(ADMIN_USER, is_admin=True)
    response.set_cookie(auth.SESSION_COOKIE, token, httponly=True, samesite="lax")
    return {"ok": True, "username": ADMIN_USER, "is_admin": True}


@app.post("/api/admin/login")
def admin_login(body: LoginIn, response: Response):
    if body.username != ADMIN_USER or not auth.verify_admin(body.password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = auth.create_session(ADMIN_USER, is_admin=True)
    response.set_cookie(auth.SESSION_COOKIE, token, httponly=True, samesite="lax")
    return {"username": ADMIN_USER, "is_admin": True}


@app.post("/api/admin/change-password")
def admin_change_password(body: ChangePasswordIn, _=Depends(auth.require_admin)):
    if not auth.verify_admin(body.old_password):
        raise HTTPException(status_code=400, detail="Old password is incorrect")
    if body.old_password == body.new_password:
        raise HTTPException(status_code=400, detail="New password must differ from the old one.")
    auth.set_admin_password(body.new_password)
    return {"ok": True}


# ----------------------------- cases -----------------------------
@app.get("/api/cases")
def api_list_cases():
    return {"cases": cases.list_cases()}


def _peel_event(jid):
    return lambda count, name: jobs.update(jid, detail=f"layer {count}: {name}")


@app.post("/api/cases")
def api_create_case(source: str = Form("local"), case_number: str = Form(...),
                    file: UploadFile = File(...)):
    if not (case_number or "").strip():
        raise HTTPException(status_code=400, detail="Case number is required")
    cn = case_number.strip()
    fname = os.path.basename(file.filename or "upload")
    # Stage the upload now (this is the network upload), then do the slow
    # extraction/detection on a background thread with progress reporting.
    stage = os.path.join(str(CASES_DIR), "_stage_" + cases.new_case_id())
    os.makedirs(stage, exist_ok=True)
    tmp = os.path.join(stage, fname)
    with open(tmp, "wb") as f:
        shutil.copyfileobj(file.file, f)

    jid = jobs.new_job(label=fname)

    def work():
        try:
            extracted = False
            if cases.is_archive(fname):
                jobs.update(jid, phase="Extracting archive…", detail=fname)
                try:
                    cases.extract_archive(tmp, stage)
                    os.remove(tmp)
                    extracted = True
                except Exception:
                    pass
            jobs.update(jid, phase="Peeling nested archives…", detail="")
            if cases.extract_all_nested(stage, on_event=_peel_event(jid)):
                extracted = True
            if not extracted:
                raise ValueError("Not a supported archive (.7z/.tgz/.tar.gz/.tar.bz2/.tar.xz/.zip)")
            result = _build_cases_from_stage(stage, source, cn, jid=jid)
            jobs.finish(jid, result=result)
        except Exception as e:
            shutil.rmtree(stage, ignore_errors=True)
            jobs.finish(jid, error=str(e))

    threading.Thread(target=work, daemon=True).start()
    return {"job_id": jid}


def _safe_rel_path(rel: str) -> str:
    rel = (rel or "").replace("\\", "/").lstrip("/")
    parts = [p for p in rel.split("/") if p and p not in (".", "..")]
    return "/".join(parts)


@app.post("/api/cases/folder")
def api_create_case_folder(case_number: str = Form(...), source: str = Form("local"),
                           paths: list[str] = Form(...), files: list[UploadFile] = File(...)):
    """Ingest a dropped folder: files are written preserving their relative
    structure, nested compression layers are peeled, and the bundle is auto-split
    into one case per AutoSupport node when it holds a whole cluster."""
    if not (case_number or "").strip():
        raise HTTPException(status_code=400, detail="Case number is required")
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")
    cn = case_number.strip()
    stage = os.path.join(str(CASES_DIR), "_stage_" + cases.new_case_id())
    os.makedirs(stage, exist_ok=True)
    written = 0
    try:
        for up, rel in zip(files, paths):
            safe = _safe_rel_path(rel or up.filename or "")
            if not safe:
                continue
            target = os.path.join(stage, safe)
            if not os.path.abspath(target).startswith(os.path.abspath(stage)):
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as f:
                shutil.copyfileobj(up.file, f)
            written += 1
    except Exception as e:
        shutil.rmtree(stage, ignore_errors=True)
        raise HTTPException(status_code=400, detail=f"Upload failed: {e}")
    if written == 0:
        shutil.rmtree(stage, ignore_errors=True)
        raise HTTPException(status_code=400, detail="No valid files in the dropped folder")

    jid = jobs.new_job(label="Dropped folder")

    def work():
        try:
            jobs.update(jid, phase="Peeling nested archives…", detail="")
            cases.extract_all_nested(stage, on_event=_peel_event(jid))
            result = _build_cases_from_stage(stage, source, cn, jid=jid)
            jobs.finish(jid, result=result)
        except Exception as e:
            shutil.rmtree(stage, ignore_errors=True)
            jobs.finish(jid, error=str(e))

    threading.Thread(target=work, daemon=True).start()
    return {"job_id": jid}


@app.get("/api/clusters")
def api_clusters():
    """Cluster topology: loaded cases grouped by cluster + HA pairs + node info."""
    return cluster.build_clusters()


@app.get("/api/clusters/topology")
def api_clusters_topology():
    """Network topology merged per cluster across all of its loaded cases."""
    return cluster.build_cluster_topologies()


@app.get("/api/cases/by-cluster/{cluster_name}")
def api_cases_by_cluster(cluster_name: str):
    return {"cases": [c for c in cases.list_cases() if (c.get("cluster") or "") == cluster_name]}


# ----------------------------- cluster aggregation -----------------------------
def _build_cases_from_stage(stage: str, source: str, case_number: str, jid: str | None = None):
    """Detect the per-node AutoSupport roots under an already-extracted
    ``stage`` tree and create one case per node (or a single case). Returns a
    single case dict, or ``{"multi": True, "count": N, "cases": [...]}``. The
    ``stage`` directory is consumed (moved or removed)."""
    if jid:
        jobs.update(jid, phase="Detecting AutoSupport nodes…", detail="", done=0, total=0)
    roots = cases.find_node_roots(stage)
    if len(roots) <= 1:
        if jid:
            jobs.update(jid, phase="Loading AutoSupport…", detail="parsing metadata", total=1, done=0)
        case_id = cases.new_case_id()
        dest = os.path.join(str(CASES_DIR), case_id)
        shutil.move(stage, dest)
        row = cases.save_case(case_id, source, dest, case_number=case_number)
        if jid:
            jobs.update(jid, done=1, total=1)
        return cases.case_to_dict(row)
    created = []
    total = len(roots)
    for i, r in enumerate(roots, 1):
        if jid:
            jobs.update(jid, phase="Loading nodes…",
                        detail=f"node {i} of {total}", done=i - 1, total=total)
        cid = cases.new_case_id()
        dest = os.path.join(str(CASES_DIR), cid)
        shutil.move(r, dest)
        row = cases.save_case(cid, source, dest, case_number=case_number)
        created.append(cases.case_to_dict(row))
        if jid:
            jobs.update(jid, done=i, total=total,
                        detail=f"{cases.case_to_dict(row).get('node') or 'node'} ({i}/{total})")
    shutil.rmtree(stage, ignore_errors=True)
    return {"multi": True, "count": len(created), "cases": created}


@app.get("/api/jobs/{job_id}")
def api_job_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


def _cluster_case_roots(cluster_key: str):
    """[(case_id, node, root)] for every loaded case in the cluster, matched by
    cluster_uuid first, then by cluster name."""
    out = []
    for c in cases.list_cases():
        keys = [k for k in (c.get("cluster_uuid"), c.get("cluster")) if k]
        if cluster_key in keys:
            root = cases.case_root(c["id"])
            if root and os.path.isdir(root):
                node = c.get("node") or c.get("case_number") or c["id"][:6]
                out.append((c["id"], node, root))
    out.sort(key=lambda t: (t[1] or "").lower())
    return out


@app.get("/api/clusters/{cluster_key}/nodes")
def api_cluster_nodes(cluster_key: str):
    nodes = []
    seen = set()
    for c in cases.list_cases():
        keys = [k for k in (c.get("cluster_uuid"), c.get("cluster")) if k]
        if cluster_key in keys:
            node = c.get("node") or c.get("case_number") or c["id"][:6]
            if node in seen:
                continue
            seen.add(node)
            nodes.append({
                "case_id": c["id"], "node": node, "model": c.get("model"),
                "os_version": c.get("os_version"), "system_id": c.get("system_id"),
                "serial": c.get("serial"), "case_number": c.get("case_number"),
            })
    nodes.sort(key=lambda n: (n["node"] or "").lower())
    cname = next((c.get("cluster") for c in cases.list_cases()
                  if cluster_key in [k for k in (c.get("cluster_uuid"), c.get("cluster")) if k]), None)
    return {"cluster_key": cluster_key, "cluster_name": cname, "nodes": nodes}


def _wanted_nodes(nodes: Optional[str]):
    return set(n for n in (nodes.split(",") if nodes else []) if n)


@app.get("/api/clusters/{cluster_key}/ems")
def api_cluster_ems(cluster_key: str, nodes: Optional[str] = None,
                    max_records_per_node: int = 20000):
    """Merged EMS event log across every node in the cluster, each event tagged
    with its source node (``src_node``)."""
    want = _wanted_nodes(nodes)
    events = []
    total = 0
    truncated = False
    per_node = {}
    for _cid, node, root in _cluster_case_roots(cluster_key):
        if want and node not in want:
            continue
        node_count = 0
        for rel, full in parsing.walk_files(root):
            base = rel.rsplit("/", 1)[-1].lower()
            if "ems" not in base or not parsing.is_text_file(full):
                continue
            r = parse_ems_log(full, max_records=max_records_per_node)
            if not r.get("ok"):
                continue
            for e in r.get("events", []):
                e["src_node"] = node
                if not e.get("node"):
                    e["node"] = node
                events.append(e)
                node_count += 1
            total += r.get("total", 0)
            if r.get("truncated"):
                truncated = True
        per_node[node] = node_count
    events.sort(key=lambda e: (e.get("ts") or ""))
    return {"ok": True, "events": events, "row_count": len(events),
            "total": total, "truncated": truncated, "per_node": per_node}


@app.get("/api/clusters/{cluster_key}/search/filenames")
def api_cluster_search_filenames(cluster_key: str, q: str, nodes: Optional[str] = None):
    want = _wanted_nodes(nodes)
    results = []
    for _cid, node, root in _cluster_case_roots(cluster_key):
        if want and node not in want:
            continue
        for r in _search_filenames(root, q):
            r["node"] = node
            results.append(r)
    return {"results": results}


@app.get("/api/clusters/{cluster_key}/search/content")
def api_cluster_search_content(cluster_key: str, q: str, nodes: Optional[str] = None,
                               limit_per_file: int = 50, max_total_hits: int = 2000,
                               case_sensitive: bool = False, regex: bool = False):
    want = _wanted_nodes(nodes)
    results = []
    total = 0
    for _cid, node, root in _cluster_case_roots(cluster_key):
        if want and node not in want:
            continue
        res = _search_content(root, q, limit_per_file, max_total_hits, case_sensitive, regex, False)
        for r in res.get("results", []):
            r["node"] = node
            results.append(r)
        total += res.get("total", 0)
    return {"results": results, "total": total}


@app.get("/api/cases/{case_id}")
def api_get_case(case_id: str):
    row = cases.get_case(case_id)
    if not row:
        raise HTTPException(status_code=404, detail="Case not found")
    return cases.case_to_dict(row)


@app.delete("/api/cases")
def api_delete_all_cases(_=Depends(auth.require_admin)):
    """Delete every loaded case. Admin only."""
    deleted = cases.delete_all_cases()
    return {"ok": True, "deleted": deleted}


@app.delete("/api/cases/{case_id}")
def api_delete_case(case_id: str, _=Depends(auth.require_admin)):
    if not cases.delete_case(case_id):
        raise HTTPException(status_code=404, detail="Case not found")
    return {"ok": True}


@app.post("/api/cases/{case_id}/reclassify")
def api_reclassify(case_id: str):
    _require_case_root(case_id)
    return {"ok": True}


@app.post("/api/cases/{case_id}/refresh_metadata")
def api_refresh_metadata(case_id: str):
    root = _require_case_root(case_id)
    row = cases.get_case(case_id)
    cases.save_case(case_id, row["source"], root)
    return cases.case_to_dict(cases.get_case(case_id))


# ------- component file listing / parse / grep / events / content -------
def _component_files(root: str, component: str):
    out = []
    for rel, full in parsing.walk_files(root):
        if plugins.classify_path(rel) == component:
            try:
                size = os.path.getsize(full)
            except OSError:
                size = 0
            out.append({
                "path": rel,
                "full": full,
                "size": size,
                "parseable": parsing.is_text_file(full),
                "component": component,
            })
    return out


@app.get("/api/cases/{case_id}/components/{component}/files")
def api_component_files(case_id: str, component: str):
    root = _require_case_root(case_id)
    files = _component_files(root, component)
    return {"component": component, "vertical": plugins.vertical_of(component),
            "files": [{k: v for k, v in f.items() if k != "full"} for f in files]}


@app.get("/api/cases/{case_id}/autosupport_files")
def api_autosupport_files(case_id: str):
    """All files physically located under any .../autosupport/ directory,
    regardless of component classification (the AutoSupport directory browser)."""
    root = _require_case_root(case_id)
    rx = re.compile(r"(^|/)autosupport/", re.IGNORECASE)
    out = []
    for rel, full in parsing.walk_files(root):
        if rx.search(rel):
            try:
                size = os.path.getsize(full)
            except OSError:
                size = 0
            out.append({
                "path": rel,
                "size": size,
                "parseable": parsing.is_text_file(full),
                "component": plugins.classify_path(rel),
            })
    return {"files": out, "count": len(out)}


@app.get("/api/cases/{case_id}/component_index")
def api_component_index(case_id: str):
    """Map each component to the (lowercased) base names of its files, so the UI
    sidebar filter can match by log file name, not just component name."""
    root = _require_case_root(case_id)
    index: dict[str, list[str]] = {}
    for rel, _full in parsing.walk_files(root):
        comp = plugins.classify_path(rel)
        name = rel.rsplit("/", 1)[-1].lower()
        index.setdefault(comp, []).append(name)
    return {"index": index}


@app.post("/api/cases/{case_id}/components/{component}/parse")
def api_component_parse(case_id: str, component: str, body: ParseBody = Body(default=ParseBody()),
                        ts_from: Optional[datetime] = None, ts_to: Optional[datetime] = None):
    root = _require_case_root(case_id)
    files = body.files if body.files else [f["path"] for f in _component_files(root, component)]
    all_events = []
    parsed_files = []
    for rel in files:
        full = _safe_join(root, rel)
        evs = parsing.parse_file(full)
        for e in evs:
            e["file"] = rel
        all_events.extend(evs)
        parsed_files.append({"path": rel, "count": len(evs)})
    return {"files": parsed_files, "events": all_events[:20000], "total": len(all_events)}


@app.post("/api/cases/{case_id}/components/{component}/grep")
def api_component_grep(case_id: str, component: str, body: GrepBody):
    root = _require_case_root(case_id)
    fulls = [_safe_join(root, p) for p in body.paths] if body.paths else \
            [f["full"] for f in _component_files(root, component)]
    res = parsing.grep_files(fulls, body.pattern, body.regex, body.case_sensitive,
                             body.context, body.max_hits_per_file, body.max_total_hits)
    for r in res.get("results", []):
        r["path"] = os.path.relpath(r["path"], root).replace("\\", "/")
    return res


@app.get("/api/cases/{case_id}/components/{component}/events")
def api_component_events(case_id: str, component: str,
                         ts_from: Optional[datetime] = None, ts_to: Optional[datetime] = None,
                         severities: Optional[str] = None, q: Optional[str] = None,
                         file: Optional[str] = None, nodes: Optional[str] = None,
                         also_cases: Optional[str] = None, limit: int = 5000):
    root = _require_case_root(case_id)
    files = [file] if file else [f["path"] for f in _component_files(root, component)]
    events = []
    for rel in files:
        full = _safe_join(root, rel)
        for e in parsing.parse_file(full):
            e["file"] = rel
            events.append(e)
    sev = severities.split(",") if severities else None
    nd = nodes.split(",") if nodes else None
    return {"events": _filter_events(events, ts_from, ts_to, sev, q, nd, limit),
            "total": len(events)}


@app.get("/api/cases/{case_id}/components/{component}/file_content")
def api_component_file_content(case_id: str, component: str, path: str, max_bytes: int = 1_000_000):
    root = _require_case_root(case_id)
    full = _safe_join(root, path)
    return parsing.read_file_content(full, max_bytes)


# ------- case-level grep / parse_paths / content / events / search -------
@app.post("/api/cases/{case_id}/grep")
def api_case_grep(case_id: str, body: GrepBody):
    root = _require_case_root(case_id)
    if body.paths:
        fulls = [_safe_join(root, p) for p in body.paths]
    else:
        # No paths → grep every file in the case.
        fulls = [full for _rel, full in parsing.walk_files(root)]
    res = parsing.grep_files(fulls, body.pattern, body.regex, body.case_sensitive,
                             body.context, body.max_hits_per_file, body.max_total_hits)
    for r in res.get("results", []):
        r["path"] = os.path.relpath(r["path"], root).replace("\\", "/")
    return res


@app.post("/api/cases/{case_id}/parse_paths")
def api_parse_paths(case_id: str, body: ParsePathsBody):
    root = _require_case_root(case_id)
    events = []
    parsed = []
    for rel in body.paths:
        full = _safe_join(root, rel)
        evs = parsing.parse_file(full)
        for e in evs:
            e["file"] = rel
        events.extend(evs)
        parsed.append({"path": rel, "count": len(evs)})
    return {"files": parsed, "events": events[:20000], "total": len(events)}


@app.get("/api/cases/{case_id}/file_content")
def api_case_file_content(case_id: str, path: str, max_bytes: int = 1_000_000):
    root = _require_case_root(case_id)
    full = _safe_join(root, path)
    return parsing.read_file_content(full, max_bytes)


@app.get("/api/cases/{case_id}/xml_table")
def api_case_xml_table(case_id: str, path: str, max_rows: int = 5000):
    root = _require_case_root(case_id)
    full = _safe_join(root, path)
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="File not found")
    return parse_asup_xml(full, max_rows=max_rows)


@app.get("/api/cases/{case_id}/components/{component}/xml_table")
def api_component_xml_table(case_id: str, component: str, path: str, max_rows: int = 5000):
    root = _require_case_root(case_id)
    full = _safe_join(root, path)
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="File not found")
    return parse_asup_xml(full, max_rows=max_rows)


@app.get("/api/cases/{case_id}/ems_log")
def api_ems_log(case_id: str, path: str, max_records: int = 20000):
    root = _require_case_root(case_id)
    full = _safe_join(root, path)
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="File not found")
    return parse_ems_log(full, max_records=max_records)


@app.get("/api/cases/{case_id}/components/{component}/ems_log")
def api_component_ems_log(case_id: str, component: str, path: str, max_records: int = 20000):
    root = _require_case_root(case_id)
    full = _safe_join(root, path)
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="File not found")
    return parse_ems_log(full, max_records=max_records)


@app.get("/api/cases/{case_id}/mgwd_log")
def api_mgwd_log(case_id: str, path: str, max_records: int = 50000):
    root = _require_case_root(case_id)
    full = _safe_join(root, path)
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="File not found")
    return parse_mgwd_log(full, max_records=max_records)


@app.get("/api/cases/{case_id}/components/{component}/mgwd_log")
def api_component_mgwd_log(case_id: str, component: str, path: str, max_records: int = 50000):
    root = _require_case_root(case_id)
    full = _safe_join(root, path)
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="File not found")
    return parse_mgwd_log(full, max_records=max_records)


@app.get("/api/cases/{case_id}/sktrace_log")
def api_sktrace_log(case_id: str, path: str, max_records: int = 50000):
    root = _require_case_root(case_id)
    full = _safe_join(root, path)
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="File not found")
    return parse_sktrace_log(full, max_records=max_records)


@app.get("/api/cases/{case_id}/components/{component}/sktrace_log")
def api_component_sktrace_log(case_id: str, component: str, path: str, max_records: int = 50000):
    root = _require_case_root(case_id)
    full = _safe_join(root, path)
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="File not found")
    return parse_sktrace_log(full, max_records=max_records)


@app.get("/api/cases/{case_id}/ifstat")
def api_ifstat(case_id: str, path: str):
    root = _require_case_root(case_id)
    full = _safe_join(root, path)
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="File not found")
    return parse_ifstat(full)


@app.get("/api/cases/{case_id}/components/{component}/ifstat")
def api_component_ifstat(case_id: str, component: str, path: str):
    root = _require_case_root(case_id)
    full = _safe_join(root, path)
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="File not found")
    return parse_ifstat(full)


@app.get("/api/cases/{case_id}/events_by_paths")
def api_events_by_paths(case_id: str, paths: str, ts_from: Optional[datetime] = None,
                        ts_to: Optional[datetime] = None, severities: Optional[str] = None,
                        q: Optional[str] = None, nodes: Optional[str] = None, limit: int = 5000):
    root = _require_case_root(case_id)
    events = []
    for rel in paths.split(","):
        rel = rel.strip()
        if not rel:
            continue
        full = _safe_join(root, rel)
        for e in parsing.parse_file(full):
            e["file"] = rel
            events.append(e)
    sev = severities.split(",") if severities else None
    nd = nodes.split(",") if nodes else None
    return {"events": _filter_events(events, ts_from, ts_to, sev, q, nd, limit), "total": len(events)}


@app.get("/api/cases/{case_id}/search")
def api_search(case_id: str, q: str, limit_per_file: int = 50):
    root = _require_case_root(case_id)
    fnames = _search_filenames(root, q)
    content = _search_content(root, q, limit_per_file, 2000, False, False, False)
    return {"filenames": fnames, "content": content}


def _search_filenames(root: str, q: str):
    # AND-groups of OR-keywords: a path must match every group (any term in it).
    groups = [[t.lower() for t in terms] for terms in parsing.parse_query(q)] or [[(q or "").lower()]]
    out = []
    for rel, full in parsing.walk_files(root):
        rl = rel.lower()
        if all(any(t in rl for t in terms) for terms in groups):
            try:
                size = os.path.getsize(full)
            except OSError:
                size = 0
            out.append({"path": rel, "size": size, "component": plugins.classify_path(rel)})
    return out


def _search_content(root, q, limit_per_file, max_total_hits, case_sensitive, regex, include_binary):
    fulls = []
    for rel, full in parsing.walk_files(root):
        if include_binary or parsing.is_text_file(full):
            fulls.append(full)
    res = parsing.grep_files(fulls, q, regex, case_sensitive, 0, limit_per_file, max_total_hits)
    for r in res.get("results", []):
        r["path"] = os.path.relpath(r["path"], root).replace("\\", "/")
        r["component"] = plugins.classify_path(r["path"])
    return res


@app.get("/api/cases/{case_id}/search/filenames")
def api_search_filenames(case_id: str, q: str):
    root = _require_case_root(case_id)
    return {"results": _search_filenames(root, q)}


@app.get("/api/cases/{case_id}/search/content")
def api_search_content(case_id: str, q: str, limit_per_file: int = 50,
                       max_total_hits: int = 2000, case_sensitive: bool = False,
                       regex: bool = False, include_binary: bool = False):
    root = _require_case_root(case_id)
    return _search_content(root, q, limit_per_file, max_total_hits, case_sensitive, regex, include_binary)


# ------- snapshot / topology -------
@app.get("/api/cases/{case_id}/snapshot")
def api_snapshot(case_id: str, prefix: Optional[str] = None):
    root = _require_case_root(case_id)
    tree = {}
    files = []
    for rel, full in parsing.walk_files(root):
        if prefix and not rel.startswith(prefix):
            continue
        try:
            st = os.stat(full)
            size, mtime = st.st_size, datetime.fromtimestamp(st.st_mtime, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        except OSError:
            size, mtime = 0, None
        files.append({"path": rel, "size": size, "mtime": mtime,
                      "parseable": parsing.is_text_file(full)})
    return {"prefix": prefix or "", "count": len(files), "files": files}


@app.get("/api/cases/{case_id}/snapshot/events")
def api_snapshot_events(case_id: str, files: Optional[str] = None, prefix: Optional[str] = None,
                        ts_from: Optional[datetime] = None, ts_to: Optional[datetime] = None,
                        severities: Optional[str] = None, q: Optional[str] = None,
                        nodes: Optional[str] = None, limit: int = 5000):
    root = _require_case_root(case_id)
    rels = []
    if files:
        rels = [f.strip() for f in files.split(",") if f.strip()]
    elif prefix:
        rels = [rel for rel, _ in parsing.walk_files(root) if rel.startswith(prefix)]
    events = []
    for rel in rels:
        full = _safe_join(root, rel)
        for e in parsing.parse_file(full):
            e["file"] = rel
            events.append(e)
    sev = severities.split(",") if severities else None
    nd = nodes.split(",") if nodes else None
    return {"events": _filter_events(events, ts_from, ts_to, sev, q, nd, limit), "total": len(events)}


@app.get("/api/cases/{case_id}/topology")
def api_topology(case_id: str):
    root = _require_case_root(case_id)
    return topology.get_topology(root)


# ------- stingray / server-side exports -------
def _resolve_stingray_case_dir(case_number: str) -> str:
    """Map a case number to its directory under the server exports share.
    Tolerates zero-padding differences (e.g. 42367757 -> 0042367757)."""
    base = STINGRAY_DIR
    if not base.is_dir():
        raise HTTPException(status_code=404,
                            detail=f"Server exports directory not available ({base})")
    cn = (case_number or "").strip()
    if not cn or not re.fullmatch(r"[0-9]+", cn):
        raise HTTPException(status_code=400, detail="Case number must be numeric")
    for cand in (cn, cn.zfill(10)):
        p = base / cand
        if p.is_dir():
            return str(p)
    target = cn.lstrip("0") or "0"
    try:
        for d in os.listdir(base):
            if d.lstrip("0") == target and (base / d).is_dir():
                return str(base / d)
    except OSError:
        pass
    raise HTTPException(status_code=404,
                        detail=f"Case {cn} not found under server exports")


def _stingray_safe_join(case_dir: str, rel: str) -> str:
    rel = _safe_rel_path(rel)
    target = os.path.join(case_dir, rel) if rel else case_dir
    base_real = os.path.realpath(case_dir)
    real = os.path.realpath(target)
    if real != base_real and not real.startswith(base_real + os.sep):
        raise HTTPException(status_code=400, detail="Invalid path")
    return real


@app.get("/api/stingray/browse")
def api_stingray_browse(case_number: str, rel: str = ""):
    """List one directory level of a case under the server exports share so the
    user can pick files/folders to load."""
    case_dir = _resolve_stingray_case_dir(case_number)
    target = _stingray_safe_join(case_dir, rel)
    if not os.path.isdir(target):
        raise HTTPException(status_code=400, detail="Not a directory")
    rel_norm = _safe_rel_path(rel)
    entries = []
    try:
        names = os.listdir(target)
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"Cannot read directory: {e}")
    for name in names:
        if name == ".snapshot":
            continue
        full = os.path.join(target, name)
        is_dir = os.path.isdir(full)
        try:
            size = 0 if is_dir else os.path.getsize(full)
        except OSError:
            size = 0
        entries.append({
            "name": name,
            "is_dir": is_dir,
            "size": size,
            "rel": (rel_norm + "/" + name).lstrip("/") if rel_norm else name,
            "is_archive": cases.is_archive(name),
        })
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    return {"case_number": case_number, "resolved_dir": case_dir,
            "rel": rel_norm, "entries": entries}


@app.post("/api/stingray/load")
def api_stingray_load(body: StingrayLoadIn):
    """Build case(s) from selected files/folders under the server exports share.
    The heavy work (copy + recursive decompression + per-node AutoSupport
    detection) runs on a background thread; the returned ``job_id`` is polled for
    progress."""
    cn = (body.case_number or "").strip()
    if not cn:
        raise HTTPException(status_code=400, detail="Case number is required")
    case_dir = _resolve_stingray_case_dir(cn)
    if not body.paths:
        raise HTTPException(status_code=400, detail="Select at least one file or folder")
    paths = [_stingray_safe_join(case_dir, rel) for rel in body.paths]
    stage = os.path.join(str(CASES_DIR), "_stage_" + cases.new_case_id())
    os.makedirs(stage, exist_ok=True)
    jid = jobs.new_job(label="Server exports load")

    def work():
        try:
            jobs.update(jid, phase="Copying selected items…")
            ingested = 0
            for src in paths:
                if not os.path.exists(src):
                    continue
                jobs.update(jid, detail=os.path.basename(src))
                cases.ingest_server_path(src, stage)
                ingested += 1
            if ingested == 0:
                raise ValueError("No valid items loaded")
            jobs.update(jid, phase="Peeling nested archives…", detail="")
            cases.extract_all_nested(stage, on_event=_peel_event(jid))
            result = _build_cases_from_stage(stage, "stingray", cn, jid=jid)
            jobs.finish(jid, result=result)
        except Exception as e:
            shutil.rmtree(stage, ignore_errors=True)
            jobs.finish(jid, error=str(e))

    threading.Thread(target=work, daemon=True).start()
    return {"job_id": jid}


@app.post("/api/cases/stingray")
def api_create_from_stingray(body: StingrayIn):
    raise HTTPException(status_code=502,
                        detail="Stingray backend is not configured in this deployment")


@app.get("/api/cases/stingray/{case_num}/inventory")
def api_stingray_inventory(case_num: str):
    return {"case_num": case_num, "items": [],
            "note": "Stingray backend is not configured in this deployment"}


# ------- asup -------
DEFAULT_AIQ_UPLOAD_BASE = (
    "https://apigtwyapps.netapp.com/aiq/api/raw-asup-uploader/manual_asup_upload"
)
DEFAULT_AIQ_DOWNLOAD_BASE = (
    "https://apigtwyapps.netapp.com/aiq/api/asup-viewer/v0/asup-download/asup_id"
)
# Template used to fetch the AutoSupport list for a query (serial number).
# {query} is the URL-encoded serial number; {date_from}/{date_to} are the
# YYYY-MM-DD range (defaulted server-side when the user leaves them blank).
# This is the ActiveIQ asup-viewer "asup-list" endpoint, which the upload token
# is authorized for (the smartsolve SPA's smso/v2 API uses a different token).
DEFAULT_AIQ_SEARCH_URL = (
    "https://apigtwyapps.netapp.com/aiq/api/asup-viewer/v0/asup-list/"
    "sys_serial_no/{query}?system_state=all&product_type=all"
    "&start_date={date_from}&end_date={date_to}"
)


def _get_setting(key, default=None):
    with get_db() as db:
        row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def _set_setting(key, value):
    with get_db() as db:
        db.execute("INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)", (key, value))
        db.commit()


@app.get("/api/asup/token")
def asup_token_status():
    loaded = bool(_get_setting("asup_token"))
    return {"client_ip": "127.0.0.1", "active_users": 1, "loaded": loaded}


@app.post("/api/asup/token")
def asup_set_token(body: TokenIn):
    _set_setting("asup_token", body.token)
    if body.submitter:
        _set_setting("asup_submitter", body.submitter)
    return {"ok": True, "loaded": True}


@app.delete("/api/asup/token")
def asup_clear_token():
    with get_db() as db:
        db.execute("DELETE FROM settings WHERE key IN ('asup_token','asup_submitter')")
        db.commit()
    return {"ok": True, "loaded": False}


@app.post("/api/asup/token/validate")
def asup_validate_token():
    token = _get_setting("asup_token")
    return {"valid": bool(token), "loaded": bool(token)}


@app.get("/api/asup/upload-url")
def asup_get_upload_url():
    custom = _get_setting("asup_upload_url")
    url = custom or os.environ.get("SLA_AIQ_UPLOAD_URL") or DEFAULT_AIQ_UPLOAD_BASE
    return {"url": url, "custom": bool(custom), "default": DEFAULT_AIQ_UPLOAD_BASE}


@app.post("/api/asup/upload-url")
def asup_set_upload_url(body: UploadUrlIn):
    url = (body.url or "").strip()
    if not url:
        with get_db() as db:
            db.execute("DELETE FROM settings WHERE key='asup_upload_url'")
            db.commit()
        return {"ok": True, "url": DEFAULT_AIQ_UPLOAD_BASE, "custom": False}
    _set_setting("asup_upload_url", url)
    return {"ok": True, "url": url, "custom": True}


# ------- asup download / load -------
def _download_base() -> str:
    return (_get_setting("asup_download_url") or os.environ.get("SLA_AIQ_DOWNLOAD_URL")
            or DEFAULT_AIQ_DOWNLOAD_BASE).strip().rstrip("/")


def _search_url() -> str:
    return (_get_setting("asup_search_url") or os.environ.get("SLA_AIQ_SEARCH_URL")
            or DEFAULT_AIQ_SEARCH_URL).strip()


@app.get("/api/asup/download/config")
def asup_get_download_config():
    return {
        "download_url": _download_base(),
        "search_url": _search_url(),
        "download_default": DEFAULT_AIQ_DOWNLOAD_BASE,
        "search_default": DEFAULT_AIQ_SEARCH_URL,
    }


@app.post("/api/asup/download/config")
def asup_set_download_config(body: DownloadConfigIn):
    if body.download_url is not None:
        v = body.download_url.strip()
        if v:
            _set_setting("asup_download_url", v)
        else:
            with get_db() as db:
                db.execute("DELETE FROM settings WHERE key='asup_download_url'")
                db.commit()
    if body.search_url is not None:
        v = body.search_url.strip()
        if v:
            _set_setting("asup_search_url", v)
        else:
            with get_db() as db:
                db.execute("DELETE FROM settings WHERE key='asup_search_url'")
                db.commit()
    return {"ok": True, "download_url": _download_base(), "search_url": _search_url()}


_ID_KEYS = ("asup_id", "asupid", "asup", "sequence", "seq_num", "seqno", "seq", "id")
_DATE_KEYS = ("asup_gen_date", "generated_on", "generatedon", "date_generated",
              "gen_date", "generated", "collection_date", "asup_date", "timestamp",
              "created", "created_on", "date", "received", "received_on")


def _looks_like_asup_id(v) -> bool:
    s = str(v).strip()
    return s.isdigit() and 8 <= len(s) <= 20


def _asup_id_datetime(asup_id: str):
    """Best-effort datetime for a time-based ASUP id (epoch s/ms, or YYYYMMDD…)."""
    s = str(asup_id).strip()
    if not s.isdigit():
        return None
    try:
        if len(s) == 13:                       # epoch milliseconds
            return datetime.fromtimestamp(int(s) / 1000, timezone.utc)
        if len(s) == 10:                       # epoch seconds
            return datetime.fromtimestamp(int(s), timezone.utc)
        if len(s) >= 8:                        # leading YYYYMMDD
            return datetime(int(s[0:4]), int(s[4:6]), int(s[6:8]), tzinfo=timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None
    return None


def _parse_date_field(v):
    if v in (None, ""):
        return None
    s = str(v).strip()
    if s.isdigit():
        return _asup_id_datetime(s)
    s = s.replace("Z", "+00:00")
    for fmt in (None, "%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d"):
        try:
            return datetime.fromisoformat(s) if fmt is None else datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


_NODE_KEYS = ("hostname", "host_name", "node", "node_name", "nodename",
              "sys_name", "system_name", "controller")
_TYPE_KEYS = ("asup_type", "asuptype", "type", "asup_subject", "subject",
              "trigger", "trigger_type")
_SYS_KEYS = ("system_id", "systemid", "sys_id", "sysid")
_PARTNER_KEYS = ("partner_system_id", "partnersystemid", "partner_id")
_CLUSTER_KEYS = ("cluster_uuid", "cluster_id", "clusteruuid", "clusterid")
_SERIAL_KEYS = ("sys_serial_no", "serial_number", "serialnumber", "serial", "serial_no")


def _cluster_uuid_from_bizkey(bk) -> str | None:
    # biz_key looks like "C|<cluster_uuid>|<n>|<serial>"
    if isinstance(bk, str) and "|" in bk:
        parts = bk.split("|")
        if len(parts) >= 2 and len(parts[1]) >= 8:
            return parts[1].strip()
    return None


def _extract_asup_entries(data, text: str):
    """Pull AutoSupport records (asup_id, generated_on, node, asup_type, and —
    when present — system_id / partner_system_id / cluster_uuid / serial) out of
    an arbitrary JSON or text body."""
    entries, seen = [], set()

    def add(asup_id, gen, node=None, atype=None, sys_id=None,
            partner=None, cluster=None, serial=None):
        sid = str(asup_id).strip()
        if not _looks_like_asup_id(sid) or sid in seen:
            return
        seen.add(sid)
        dt = _parse_date_field(gen) or _asup_id_datetime(sid)
        entries.append({
            "asup_id": sid,
            "generated_on": gen if gen else (dt.strftime("%Y-%m-%d %H:%M:%S") if dt else None),
            "node": str(node).strip() if node else None,
            "asup_type": str(atype).strip() if atype else None,
            "system_id": str(sys_id).strip() if sys_id else None,
            "partner_system_id": str(partner).strip() if partner else None,
            "cluster_uuid": str(cluster).strip() if cluster else None,
            "serial": str(serial).strip() if serial else None,
            "_dt": dt,
        })

    def visit(obj):
        if isinstance(obj, dict):
            lower = {str(k).lower(): k for k in obj}
            id_val = next((obj[lower[k]] for k in _ID_KEYS
                           if k in lower and _looks_like_asup_id(obj[lower[k]])), None)
            if id_val is not None:
                pick = lambda keys: next((obj[lower[k]] for k in keys if k in lower and obj[lower[k]]), None)
                cluster = pick(_CLUSTER_KEYS) or _cluster_uuid_from_bizkey(obj.get(lower.get("biz_key", "")))
                add(id_val, pick(_DATE_KEYS), pick(_NODE_KEYS), pick(_TYPE_KEYS),
                    pick(_SYS_KEYS), pick(_PARTNER_KEYS), cluster, pick(_SERIAL_KEYS))
            for v in obj.values():
                visit(v)
        elif isinstance(obj, list):
            for v in obj:
                visit(v)

    if data is not None:
        visit(data)
    if not entries and text:
        for m in re.findall(r'asup[_-]?id["\'/:\s]+(\d{8,20})', text, re.I):
            add(m, None)
    return entries


def _http_get(url: str, token: str | None, timeout: int = 60):
    import urllib.request
    headers = {"Accept": "application/json, */*"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, method="GET", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(), resp.headers


@app.post("/api/asup/download/list")
def asup_download_list(body: AsupListIn):
    query = (body.query or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="A search query (serial / case number) is required")
    token = _get_setting("asup_token")
    tmpl = _search_url()
    import urllib.error
    from urllib.parse import quote
    # Date placeholders for endpoints (like asup-list) that take an explicit
    # range in the URL; default to a wide window when the user leaves them blank.
    df = (body.date_from or "2000-01-01").strip()
    dt_ = (body.date_to or datetime.now(timezone.utc).strftime("%Y-%m-%d")).strip()

    def build_serial_url(serial):
        u = tmpl.replace("{query}", quote(serial, safe="")) \
                .replace("{date_from}", quote(df, safe="")) \
                .replace("{date_to}", quote(dt_, safe=""))
        if "{query}" not in tmpl and "query=" not in u and "sys_serial_no" not in u:
            u = u + ("&" if "?" in u else "?") + "query=" + quote(serial, safe="")
        return u

    def fetch_entries(u):
        raw, _ = _http_get(u, token, timeout=60)
        text = raw.decode("utf-8", "replace")
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        return _extract_asup_entries(data, text)

    url = build_serial_url(query)
    serials = [s for s in re.split(r"[\s,;]+", query) if s.strip()]
    if not serials:
        serials = [query]
    entries = []
    seen_ids = set()
    first_err = None
    for s in serials:
        try:
            for e in fetch_entries(build_serial_url(s)):
                if e.get("asup_id") not in seen_ids:
                    seen_ids.add(e.get("asup_id"))
                    entries.append(e)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read(500).decode("utf-8", "replace")
            except Exception:
                pass
            first_err = first_err or f"Search failed: HTTP {e.code} {e.reason} {detail}".strip()
        except Exception as e:
            first_err = first_err or f"Search failed: {e}"
    if not entries and first_err:
        raise HTTPException(status_code=502, detail=first_err)

    nodes = {(e.get("node"), e.get("serial")) for e in entries
             if e.get("node") and e.get("node") not in ("-", "—")}
    cluster_note = None
    # Expand to the other nodes in the same cluster. asup-list is per-node, so we
    # discover sibling nodes by following partner_system_id (HA partner) via the
    # system_id endpoint, staying within the same cluster_uuid. This reliably
    # covers the HA pair(s) reachable from the queried node.
    if body.include_cluster and "/sys_serial_no/" in url:
        base = url.split("/sys_serial_no/")[0]
        qstr = ("?" + url.split("?", 1)[1]) if "?" in url else ""
        seed_cluster = next((e.get("cluster_uuid") for e in entries if e.get("cluster_uuid")), None)
        seen_sys = {e.get("system_id") for e in entries if e.get("system_id")}
        seen_serial = {e.get("serial") for e in entries if e.get("serial")}
        queue = [e.get("partner_system_id") for e in entries if e.get("partner_system_id")]
        queue = [s for s in dict.fromkeys(queue) if s and s not in seen_sys]
        try:
            guard = 0
            while queue and guard < 16:
                guard += 1
                sid = queue.pop(0)
                if sid in seen_sys:
                    continue
                seen_sys.add(sid)
                sib = fetch_entries(f"{base}/system_id/{quote(str(sid), safe='')}{qstr}")
                sib_cluster = next((e.get("cluster_uuid") for e in sib if e.get("cluster_uuid")), None)
                if seed_cluster and sib_cluster and sib_cluster != seed_cluster:
                    continue
                for e in sib:
                    if e.get("asup_id") not in {x.get("asup_id") for x in entries}:
                        entries.append(e)
                    if e.get("node") and e.get("node") not in ("-", "—"):
                        nodes.add((e.get("node"), e.get("serial")))
                    if e.get("serial"):
                        seen_serial.add(e.get("serial"))
                    p = e.get("partner_system_id")
                    if p and p not in seen_sys and p not in queue:
                        queue.append(p)
        except Exception as ex:
            cluster_note = f"Cluster expansion incomplete: {ex}"

    def in_range(e):
        dt = e.get("_dt")
        if dt is None:
            return True
        d = dt.date()
        if body.date_from:
            try:
                if d < datetime.strptime(body.date_from, "%Y-%m-%d").date():
                    return False
            except ValueError:
                pass
        if body.date_to:
            try:
                if d > datetime.strptime(body.date_to, "%Y-%m-%d").date():
                    return False
            except ValueError:
                pass
        return True

    filtered = [e for e in entries if in_range(e)]
    filtered.sort(key=lambda e: ((e.get("node") or ""),
                                 -(e.get("_dt") or datetime.min.replace(tzinfo=timezone.utc)).timestamp()))
    out = [{"asup_id": e["asup_id"], "generated_on": e["generated_on"],
            "node": e.get("node"), "asup_type": e.get("asup_type"),
            "serial": e.get("serial")} for e in filtered]
    node_list = sorted({n for n, _ in nodes if n})
    return {"url": url, "count": len(out), "total": len(entries),
            "nodes": node_list, "node_count": len(node_list),
            "note": cluster_note, "asups": out}


def _archive_ext_for(data: bytes, disposition: str = "") -> str:
    if disposition:
        m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)', disposition, re.I)
        if m and cases.is_archive(m.group(1).strip()):
            low = m.group(1).strip().lower()
            for ext in (".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".7z", ".zip", ".tar"):
                if low.endswith(ext):
                    return ext
    if data[:6] == b"7z\xbc\xaf\x27\x1c":
        return ".7z"
    if data[:2] == b"\x1f\x8b":
        return ".tgz"
    if data[:3] == b"BZh":
        return ".tar.bz2"
    if data[:6] == b"\xfd7zXZ\x00":
        return ".tar.xz"
    if data[:4] == b"PK\x03\x04":
        return ".zip"
    if len(data) > 262 and data[257:262] == b"ustar":
        return ".tar"
    return ".tgz"


@app.post("/api/asup/download/load")
def asup_download_load(body: AsupDownloadIn):
    token = _get_setting("asup_token")
    if not token:
        raise HTTPException(status_code=400, detail="No AIQ token set — authenticate first")
    ids = [str(i).strip() for i in (body.asup_ids or []) if str(i).strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="At least one AutoSupport id is required")
    base = _download_base()
    cn = (body.case_number or ids[0]).strip()

    stage = os.path.join(str(CASES_DIR), "_stage_" + cases.new_case_id())
    os.makedirs(stage, exist_ok=True)
    jid = jobs.new_job(label=f"ASUP download ({len(ids)})")

    def work():
        import urllib.error
        try:
            total = len(ids)
            got = 0
            for i, aid in enumerate(ids, 1):
                jobs.update(jid, phase="Downloading AutoSupport…",
                            detail=f"{aid} ({i}/{total})", done=i - 1, total=total)
                url = f"{base}/{aid}?system_state=all&product_type=all"
                try:
                    data, headers = _http_get(url, token, timeout=600)
                except urllib.error.HTTPError as e:
                    raise ValueError(f"Download of {aid} failed: HTTP {e.code} {e.reason}")
                ext = _archive_ext_for(data, headers.get("Content-Disposition", ""))
                with open(os.path.join(stage, f"asup_{aid}{ext}"), "wb") as f:
                    f.write(data)
                got += 1
            if not got:
                raise ValueError("No AutoSupports were downloaded")
            jobs.update(jid, phase="Peeling archives…", detail="", done=total, total=total)
            cases.extract_all_nested(stage, on_event=_peel_event(jid))
            result = _build_cases_from_stage(stage, "download", cn, jid=jid)
            jobs.finish(jid, result=result)
        except Exception as e:
            shutil.rmtree(stage, ignore_errors=True)
            jobs.finish(jid, error=str(e))

    threading.Thread(target=work, daemon=True).start()
    return {"job_id": jid}


def _capture_key() -> str:
    key = _get_setting("asup_capture_key")
    if not key:
        key = secrets.token_urlsafe(24)
        _set_setting("asup_capture_key", key)
    return key


@app.post("/api/asup/token/capture")
def asup_capture_token(body: TokenCaptureIn):
    """Receive a token auto-captured by the browser extension.

    Authenticated by the capture key embedded in the extension at download
    time (download itself requires admin), so no session cookie is needed."""
    expected = _get_setting("asup_capture_key")
    if not expected or not secrets.compare_digest(body.key, expected):
        raise HTTPException(status_code=401, detail="Invalid capture key")
    token = (body.token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="Empty token")
    _set_setting("asup_token", token)
    if body.submitter:
        _set_setting("asup_submitter", body.submitter)
    return {"ok": True, "loaded": True}


@app.get("/api/asup/cases/{case_id}/folders")
def asup_folders(case_id: str):
    root = _require_case_root(case_id)
    folders = set()
    for rel, _ in parsing.walk_files(root):
        top = rel.split("/", 1)[0]
        folders.add(top)
    return {"folders": sorted(folders)}


@app.post("/api/asup/cases/{case_id}/upload")
def asup_upload(case_id: str, body: UploadIn):
    _require_case_root(case_id)
    if not _get_setting("asup_token"):
        raise HTTPException(status_code=400, detail="No ASUP token set")
    return {"ok": True, "uploaded": body.folders, "results":
            [{"folder": f, "status": "uploaded"} for f in body.folders]}


@app.get("/api/asup/extension.zip")
def asup_extension(request: Request):
    """Package the extension from its standalone source directory
    (extension/AIQ_Token_Capture_extention), injecting this server's URL and
    capture key into manifest.json + config.js so it works out of the box."""
    if not EXTENSION_DIR.is_dir():
        raise HTTPException(status_code=500, detail="Extension source directory not found")

    key = _capture_key()
    base = request.base_url
    origin = f"{base.scheme}://{base.netloc}"

    # Load the static manifest and inject this server's origin into host_permissions.
    manifest = json.loads((EXTENSION_DIR / "manifest.json").read_text(encoding="utf-8"))
    hosts = [h for h in manifest.get("host_permissions", []) if "netapp.com" in h]
    manifest["host_permissions"] = hosts + [f"{origin}/*"]
    aiq_urls = hosts

    # Generate config.js with the embedded defaults.
    config_js = (
        f"const DEFAULT_BACKEND = {json.dumps(origin)};\n"
        f"const DEFAULT_KEY = {json.dumps(key)};\n"
        f"const DEFAULT_SERVERS = [];\n"
        f"const AIQ_URLS = {json.dumps(aiq_urls)};\n"
    )

    # Static source files copied verbatim from the directory.
    static_files = ["background.js", "popup.html", "popup.js", "README.txt"]

    root = EXTENSION_NAME  # top-level folder inside the zip
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{root}/manifest.json", json.dumps(manifest, indent=2))
        z.writestr(f"{root}/config.js", config_js)
        for name in static_files:
            z.writestr(f"{root}/{name}", (EXTENSION_DIR / name).read_text(encoding="utf-8"))
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition":
                                      f"attachment; filename={EXTENSION_NAME}.zip"})


def _safe_archive_base(name: str) -> str:
    """Sanitize a base name; ASUP/AIQ requires the first char to be a letter,
    so prepend 'A' when it starts with a digit."""
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", (name or "").strip()) or "asup"
    if base[0].isdigit():
        base = "A" + base
    return base


def _pkg_dir(case_id: str):
    d = os.path.join(str(CASES_DIR), case_id, "_packages")
    os.makedirs(d, exist_ok=True)
    return d


@app.post("/api/asup/cases/{case_id}/package")
def asup_package(case_id: str, body: PackageIn):
    """Compress selected autosupport dirs/files into a .7z whose name never
    starts with a digit (a letter is prepended when needed)."""
    root = _require_case_root(case_id)
    if not body.paths:
        raise HTTPException(status_code=400, detail="No paths selected")
    try:
        import py7zr
    except ImportError:
        raise HTTPException(status_code=500, detail="py7zr is not installed (pip install py7zr)")

    default = body.name
    if not default:
        first = body.paths[0].rstrip("/").split("/")[-1]
        default = first if len(body.paths) == 1 else f"{first}_and_{len(body.paths) - 1}_more"
    base = _safe_archive_base(default)
    name = base + ".7z"
    out = os.path.join(_pkg_dir(case_id), name)

    # Reuse an already-built archive for the same source (same name) unless forced.
    if not body.force and os.path.isfile(out) and os.path.getsize(out) > 0:
        return {"ok": True, "archive": name, "size": os.path.getsize(out), "reused": True,
                "download_url": f"/api/asup/cases/{case_id}/package/download?name={name}"}

    with py7zr.SevenZipFile(out, "w") as z:
        single = len(body.paths) == 1
        for rel in body.paths:
            full = _safe_join(root, rel)
            if not os.path.exists(full):
                continue
            if single and os.path.isdir(full):
                # ActiveIQ's raw ASUP uploader reads X-HEADER-DATA.TXT (and the
                # other ASUP files) from the archive ROOT, so a single collection
                # is packaged with its contents at the top level (no parent dir).
                for dirpath, _dirs, fnames in os.walk(full):
                    for fn in fnames:
                        fpath = os.path.join(dirpath, fn)
                        arc = os.path.relpath(fpath, full).replace(os.sep, "/")
                        z.write(fpath, arcname=arc)
            else:
                arc = rel.rstrip("/").split("/")[-1]
                z.writeall(full, arcname=arc)

    size = os.path.getsize(out)
    return {"ok": True, "archive": name, "size": size, "reused": False,
            "download_url": f"/api/asup/cases/{case_id}/package/download?name={name}"}


@app.get("/api/asup/cases/{case_id}/package/download")
def asup_package_download(case_id: str, name: str):
    safe = os.path.basename(name)
    path = os.path.join(_pkg_dir(case_id), safe)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Archive not found")
    return FileResponse(path, media_type="application/x-7z-compressed", filename=safe)


@app.post("/api/asup/cases/{case_id}/upload_aiq")
def asup_upload_aiq(case_id: str, body: AiqUploadIn):
    """Direct PUT of the built .7z to ActiveIQ's raw ASUP uploader.

    Real endpoint (Kong gateway):
      PUT https://apigtwyapps.netapp.com/aiq/api/raw-asup-uploader/manual_asup_upload/<file>.7z
      Authorization: Bearer <token>; body = raw .7z bytes.
    The base URL is configurable via /api/asup/upload-url (or SLA_AIQ_UPLOAD_URL)."""
    token = _get_setting("asup_token")
    if not token:
        raise HTTPException(status_code=400, detail="No AIQ token set — authenticate first")
    path = os.path.join(_pkg_dir(case_id), os.path.basename(body.archive))
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Archive not found — build the .7z first")

    fname = os.path.basename(path)
    base = (_get_setting("asup_upload_url") or os.environ.get("SLA_AIQ_UPLOAD_URL")
            or DEFAULT_AIQ_UPLOAD_BASE).strip().rstrip("/")
    # Accept a base that already includes a trailing filename.
    if base.lower().endswith(".7z"):
        base = base.rsplit("/", 1)[0]
    target = f"{base}/{fname}"

    import urllib.error
    import urllib.request
    with open(path, "rb") as f:
        data = f.read()
    req = urllib.request.Request(target, data=data, method="PUT", headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/x-7z-compressed",
        "Content-Length": str(len(data)),
    })
    dl = f"/api/asup/cases/{case_id}/package/download?name={fname}"
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return {"ok": True, "uploaded": True, "status": resp.status, "target": target,
                    "response": resp.read(2000).decode("utf-8", "replace")}
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read(2000).decode("utf-8", "replace")
        except Exception:
            pass
        return {"ok": False, "uploaded": False, "target": target,
                "detail": f"Upload failed: HTTP {e.code} {e.reason} {detail}".strip(),
                "download_url": dl}
    except Exception as e:
        return {"ok": False, "uploaded": False, "target": target,
                "detail": f"Upload failed: {e}", "download_url": dl}


# ------- feedback -------
@app.post("/api/feedback")
def submit_feedback(body: FeedbackIn):
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO feedback(category, message, submitter, page_context, status, created_at) "
            "VALUES(?,?,?,?, 'open', ?)",
            (body.category, body.message, body.submitter, body.page_context, _now()),
        )
        db.commit()
        fid = cur.lastrowid
    return {"ok": True, "id": fid}


@app.get("/api/feedback")
def list_feedback(limit: int = 100, status: Optional[str] = None, _=Depends(auth.require_admin)):
    q = "SELECT * FROM feedback"
    args = []
    if status:
        q += " WHERE status=?"
        args.append(status)
    q += " ORDER BY created_at DESC LIMIT ?"
    args.append(limit)
    with get_db() as db:
        rows = db.execute(q, args).fetchall()
    return {"items": [dict(r) for r in rows]}


@app.patch("/api/feedback/{fid}")
def update_feedback(fid: int, body: StatusUpdate, _=Depends(auth.require_admin)):
    with get_db() as db:
        cur = db.execute("UPDATE feedback SET status=? WHERE id=?", (body.status, fid))
        db.commit()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Feedback not found")
    return {"ok": True}


@app.delete("/api/feedback/{fid}")
def delete_feedback(fid: int, _=Depends(auth.require_admin)):
    with get_db() as db:
        cur = db.execute("DELETE FROM feedback WHERE id=?", (fid,))
        db.commit()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Feedback not found")
    return {"ok": True}


# ------- mappings -------
@app.get("/api/mappings")
def list_mappings():
    with get_db() as db:
        rows = db.execute("SELECT * FROM mappings ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]


@app.post("/api/mappings")
def create_mapping(body: MappingIn, _=Depends(auth.require_admin)):
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO mappings(match_type, match_value, target_vertical, target_component, "
            "target_family, scope, note, created_at) VALUES(?,?,?,?,?,?,?,?)",
            (body.match_type, body.match_value, body.target_vertical, body.target_component,
             body.target_family, body.scope, body.note, _now()),
        )
        db.commit()
        mid = cur.lastrowid
    return {"ok": True, "id": mid}


@app.delete("/api/mappings/{mid}")
def delete_mapping(mid: int, _=Depends(auth.require_admin)):
    with get_db() as db:
        cur = db.execute("DELETE FROM mappings WHERE id=?", (mid,))
        db.commit()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Mapping not found")
    return {"ok": True}


# ----------------------------- static SPA -----------------------------
if STATIC_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        # Hashed asset files are content-addressed -> safe to serve as-is.
        target = STATIC_DIR / full_path
        if target.is_file() and full_path != "index.html":
            return FileResponse(target)
        # index.html must never be cached, otherwise browsers keep loading an
        # old SPA that references asset hashes which no longer exist after a
        # rebuild. no-store forces a fresh fetch so new builds are picked up.
        index = STATIC_DIR / "index.html"
        if index.is_file():
            return FileResponse(index, headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
            })
        raise HTTPException(status_code=404, detail="Not found")
