# Build the frontend and run the backend on http://localhost:8000
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Push-Location "$root\frontend"
if (-not (Test-Path node_modules)) { npm install }
npm run build
Pop-Location

Push-Location "$root\backend"
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8011
Pop-Location
