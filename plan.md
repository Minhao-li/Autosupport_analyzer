# Autosupport_analyzer — Reconstruction Plan

Reconstructing the NetApp ASUP / log-analyzer app at http://10.216.43.29:8000 into
`C:\Users\minhao\projects\Autosupport_analyzer`.

Source is a black-box deployment. Reconstructed from:
- OpenAPI spec (48 endpoints + schemas) — backend contract is exact.
- Live API responses (plugins taxonomy, case metadata, quota).
- Minified frontend bundle strings + CSS theme variables.

## Stack
- Backend: FastAPI + SQLite (stdlib), uvicorn. Serves API + built frontend.
- Frontend: React + Vite.

## Backend endpoints (status)
- [x] auth: login/logout/me  (user sessions, cookie)
- [x] admin: setup/login/status/change-password
- [x] cases: list/create(upload)/get/delete, by-cluster, reclassify, refresh_metadata
- [x] clusters: topology (group by cluster_uuid + HA pairs + node info)
- [x] cases stingray: create/inventory
- [x] components: files/parse/grep/events/file_content
- [x] case-level: grep/parse_paths/file_content/events_by_paths/search/search content+filenames
- [x] snapshot + snapshot/events
- [x] topology (lif-info.xml parse)
- [x] asup: token (get/set/clear/validate), folders, upload, extension.zip
- [x] feedback: submit/list/update/delete
- [x] mappings: list/create/delete
- [x] plugins: list/reload
- [x] quota, health

## Plugin taxonomy
8 verticals / 28 components (from live /api/plugins). Pattern matching classifies
log files into components.

## Frontend views
- Login / admin gate
- Sidebar verticals+components
- Tabs: Files, Events, Grep, Search (content/filenames), Snapshot, Topology
- Cluster Topology page: cases auto-associated by cluster_uuid + HA pair, per-node info
- ASUP Upload, Feedback modal, Admin panel, Mappings, themes (dark/light/solarized/sepia)

## Notes
Backend log-parsing intelligence is best-effort (real engine not visible).
