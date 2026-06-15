import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BASE_DIR.parent
EXTENSION_DIR = PROJECT_ROOT / "extension" / "AIQ_Token_Capture_extention"
EXTENSION_NAME = "AIQ_Token_Capture_extention"
# Root of the server-side exports share (sshfs mount) browsed by case number.
STINGRAY_DIR = Path(os.environ.get("STINGRAY_EXPORTS_DIR", "/mnt/stingray"))
DATA_DIR = Path(os.environ.get("SLA_DATA_DIR", BASE_DIR / "data"))
CASES_DIR = DATA_DIR / "cases"
DB_PATH = DATA_DIR / "sla.db"
STATIC_DIR = BASE_DIR / "static"

ADMIN_USER = "minhao"
QUOTA_MAX_GB = 60
QUOTA_TRIGGER_PCT = 80

for d in (DATA_DIR, CASES_DIR):
    d.mkdir(parents=True, exist_ok=True)
