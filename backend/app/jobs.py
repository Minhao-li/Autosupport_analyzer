"""In-memory progress registry for long-running load jobs.

A load (recursive decompression + per-node AutoSupport detection + metadata
parsing) can take a while, so the load endpoints run the heavy work on a
background thread and publish progress here. The frontend polls
``GET /api/jobs/{id}`` to drive a progress bar and show the current step.

Single uvicorn worker → a plain dict + lock is sufficient.
"""
from __future__ import annotations

import threading
import time
import uuid

_JOBS: dict[str, dict] = {}
_LOCK = threading.Lock()
_TTL = 1800  # keep finished jobs for 30 min so late polls still succeed


def _prune(now: float) -> None:
    stale = [k for k, v in _JOBS.items()
             if v.get("status") in ("done", "error") and now - v.get("updated", now) > _TTL]
    for k in stale:
        _JOBS.pop(k, None)


def new_job(label: str = "") -> str:
    jid = uuid.uuid4().hex
    now = time.time()
    with _LOCK:
        _prune(now)
        _JOBS[jid] = {
            "id": jid, "status": "running", "phase": "Starting…", "detail": "",
            "done": 0, "total": 0, "label": label, "result": None, "error": None,
            "started": now, "updated": now,
        }
    return jid


def update(jid: str, **fields) -> None:
    with _LOCK:
        job = _JOBS.get(jid)
        if job is not None:
            job.update(fields)
            job["updated"] = time.time()


def finish(jid: str, result=None, error: str | None = None) -> None:
    with _LOCK:
        job = _JOBS.get(jid)
        if job is not None:
            job.update(status="error" if error else "done",
                       phase="Failed" if error else "Done",
                       result=result, error=error, updated=time.time())


def get(jid: str):
    with _LOCK:
        job = _JOBS.get(jid)
        return dict(job) if job is not None else None
