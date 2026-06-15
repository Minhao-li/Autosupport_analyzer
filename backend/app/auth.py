from __future__ import annotations

import hashlib
import os
import secrets
from datetime import datetime, timezone

from fastapi import Cookie, HTTPException
from .config import ADMIN_USER
from .db import get_db

SESSION_COOKIE = "sla_session"


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def hash_password(password: str, salt: str | None = None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000)
    return h.hex(), salt


def admin_row():
    with get_db() as db:
        return db.execute("SELECT * FROM admin WHERE username=?", (ADMIN_USER,)).fetchone()


def admin_has_password() -> bool:
    row = admin_row()
    return bool(row and row["password_hash"])


def set_admin_password(password: str):
    ph, salt = hash_password(password)
    with get_db() as db:
        if admin_row():
            db.execute(
                "UPDATE admin SET password_hash=?, salt=?, password_set_at=? WHERE username=?",
                (ph, salt, _now(), ADMIN_USER),
            )
        else:
            db.execute(
                "INSERT INTO admin(username, password_hash, salt, password_set_at) VALUES(?,?,?,?)",
                (ADMIN_USER, ph, salt, _now()),
            )
        db.commit()


def verify_admin(password: str) -> bool:
    row = admin_row()
    if not row or not row["password_hash"]:
        return False
    ph, _ = hash_password(password, row["salt"])
    return secrets.compare_digest(ph, row["password_hash"])


def create_session(username: str, is_admin: bool) -> str:
    token = secrets.token_urlsafe(32)
    with get_db() as db:
        db.execute(
            "INSERT INTO sessions(token, username, is_admin, created_at) VALUES(?,?,?,?)",
            (token, username, 1 if is_admin else 0, _now()),
        )
        db.commit()
    return token


def destroy_session(token: str | None):
    if not token:
        return
    with get_db() as db:
        db.execute("DELETE FROM sessions WHERE token=?", (token,))
        db.commit()


def current_session(token: str | None):
    if not token:
        return None
    with get_db() as db:
        row = db.execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
    return row


def get_session(sla_session: str | None = Cookie(default=None)):
    return current_session(sla_session)


def require_admin(sla_session: str | None = Cookie(default=None)):
    row = current_session(sla_session)
    if not row or not row["is_admin"]:
        raise HTTPException(status_code=401, detail="Admin authentication required")
    return row
