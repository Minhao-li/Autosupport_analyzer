# Autosupport_analyzer

A reconstruction of the NetApp ASUP / log-analyzer web app. Upload ONTAP log
packages (ASUP / `.zip` / `.tgz` / `.7z`), auto-classify files into a
vertical/component taxonomy, parse events, grep, search, view file snapshots,
inspect network topology, and push folders to ActiveIQ.

> Reconstructed from a running deployment's API contract (OpenAPI) + UI. The
> backend log-parsing intelligence is a best-effort reconstruction, not the
> original engine.

## Stack
- **Backend** — FastAPI + SQLite (`backend/`), serves the API and the built SPA.
- **Frontend** — React + Vite (`frontend/`), builds into `backend/static/`.

## Run (development)

Terminal 1 — backend (port 8011 matches the frontend dev proxy):
```powershell
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8011 --reload
```

Terminal 2 — frontend (proxies `/api` to :8011; edit `vite.config.js`):
```powershell
cd frontend
npm install
npm run dev
```
Open http://localhost:5173

## Run (production / single server)
```powershell
cd frontend; npm install; npm run build   # outputs to ../backend/static
cd ../backend
python -m uvicorn app.main:app --host 0.0.0.0 --port 8011
```
Open http://localhost:8011 — the backend serves both the API and the SPA.

## First use
1. First visit prompts **admin setup** (admin user is `minhao`); set a password.
2. Load log packages from the header or the dropzone. You can load **multiple at
   once** — drop several archives and/or several node folders together (e.g. all
   nodes of one cluster); each becomes its own case and they upload concurrently.
3. Pick a component in the sidebar to list files, parse events, or grep.
4. Use Global search, Snapshots, Network Topology and ASUP Upload pages.
   - **ASUP Download** fetches AutoSupports straight from the ASUP-viewer gateway:
     authenticate (same ActiveIQ token as ASUP Upload — the capture steps are shown
     on the page), search by serial/case number with an optional time range (ASUP
     ids are time-based) or paste ASUP id(s) directly, then download &amp; load them
     into the analyzer as cases. The search/list and download base URLs are
     configurable on the page (or via `SLA_AIQ_SEARCH_URL` / `SLA_AIQ_DOWNLOAD_URL`).
5. Open **Cluster Topology** to see loaded AutoSupports auto-grouped by cluster
   and HA pair, with each cluster's nodes and their basic info.
6. On any event-log view (EMS log, parsed Events), click **📊 Statistics** to get
   breakdowns by severity, event type, source, node, vserver, LIF, volume,
   aggregate, status and a per-day time distribution.
7. Open an **IFSTAT** counter dump (e.g. `IFSTAT-A.txt`) and switch to the
   **Stats** view for per-interface RX/TX error & discard statistics, link
   state, and a problem-only filter (click a row to see the error breakdown).

## API
Full OpenAPI is served at `/docs` and `/openapi.json` (48 endpoints).

## Data
Cases extract under `backend/data/cases/`; metadata/feedback/mappings/admin live
in `backend/data/sla.db`. Override the location with the `SLA_DATA_DIR` env var.

## Notes / not implemented faithfully
- **Stingray** case import returns "not configured" (no Stingray backend here).
- **ASUP upload** validates a stored token and simulates the upload.
- File→component classification uses substring/regex heuristics keyed on NetApp
  log naming; tune patterns in `backend/app/plugins.py`.
