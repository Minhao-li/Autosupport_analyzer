import sqlite3
import threading
from contextlib import contextmanager
from .config import DB_PATH

_local = threading.local()


def _connect():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


@contextmanager
def get_db():
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _connect()
        _local.conn = conn
    yield conn


def init_db():
    conn = _connect()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS admin (
            username TEXT PRIMARY KEY,
            password_hash TEXT,
            salt TEXT,
            password_set_at TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            username TEXT,
            is_admin INTEGER DEFAULT 0,
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS cases (
            id TEXT PRIMARY KEY,
            source TEXT,
            package_type TEXT,
            loaded_at TEXT,
            size_bytes INTEGER,
            path TEXT,
            header TEXT,
            cluster TEXT,
            node TEXT,
            case_number TEXT,
            system_id TEXT,
            serial TEXT,
            trigger TEXT,
            generated_on TEXT,
            model TEXT,
            os_version TEXT,
            ha_partner TEXT,
            cluster_uuid TEXT
        );
        CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT,
            message TEXT,
            submitter TEXT,
            page_context TEXT,
            status TEXT DEFAULT 'open',
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS mappings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_type TEXT,
            match_value TEXT,
            target_vertical TEXT,
            target_component TEXT,
            target_family TEXT,
            scope TEXT DEFAULT 'global',
            note TEXT,
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        """
    )
    conn.commit()
    _migrate(conn)
    conn.close()


def _migrate(conn):
    """Add columns introduced after the initial schema (idempotent)."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(cases)").fetchall()}
    if "cluster_uuid" not in cols:
        conn.execute("ALTER TABLE cases ADD COLUMN cluster_uuid TEXT")
        conn.commit()
    if "asup_type" not in cols:
        conn.execute("ALTER TABLE cases ADD COLUMN asup_type TEXT")
        conn.commit()
