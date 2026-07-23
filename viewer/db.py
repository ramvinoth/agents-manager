"""viewer.db — Postgres store for accounts, login sessions, and per-user prefs.

Connects with psycopg2 to DATABASE_URL (default: the local `dbname=viewer` over
the unix socket, peer auth). A ThreadedConnectionPool serves the HTTP worker
threads — Postgres forks a backend per connection, so per-op connecting would be
wasteful. The per-request session lookup is cached briefly so auth doesn't hit
the DB on every API call.

The base is single-owner: the first signup claims the instance, after which
signup is closed and it's login-only. The schema is deliberately plain."""
import hashlib
import hmac
import os
import re
import secrets
import threading
import time
from contextlib import contextmanager

import psycopg2
import psycopg2.pool
from psycopg2.extras import Json, RealDictCursor

DATABASE_URL = os.environ.get("DATABASE_URL") or "dbname=viewer"
SESSION_COOKIE = "viewer_session"
SESSION_TTL = 30 * 86400          # 30 days
_PBKDF2_ROUNDS = 200_000
_SESSION_CACHE_TTL = 60           # seconds a session→user lookup is trusted without re-hitting the DB

_pool = None
_pool_lock = threading.Lock()
_session_cache = {}               # token -> (user_or_None, cached_at)


def _get_pool():
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = psycopg2.pool.ThreadedConnectionPool(1, 16, dsn=DATABASE_URL)
    return _pool


@contextmanager
def _db():
    pool = _get_pool()
    conn = pool.getconn()
    try:
        with conn:  # commits on clean exit, rolls back on exception (keeps the conn)
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                yield cur
    finally:
        pool.putconn(conn)


def init_db():
    with _db() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
              id         SERIAL PRIMARY KEY,
              username   TEXT UNIQUE NOT NULL,
              pw_hash    TEXT NOT NULL,
              salt       TEXT NOT NULL,
              created_at DOUBLE PRECISION NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
              token      TEXT PRIMARY KEY,
              user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              created_at DOUBLE PRECISION NOT NULL,
              expires_at DOUBLE PRECISION NOT NULL
            );
            CREATE TABLE IF NOT EXISTS prefs (
              user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
              data    JSONB NOT NULL
            );
            """
        )


def close_pool():
    global _pool
    if _pool is not None:
        try:
            _pool.closeall()
        except Exception:
            pass
        _pool = None


def _hash(password, salt_hex):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), _PBKDF2_ROUNDS).hex()


def user_count():
    with _db() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM users")
        return cur.fetchone()["n"]


def create_user(username, password):
    """Create a user; returns {id, username}. Raises ValueError on bad input or a
    taken username."""
    username = (username or "").strip()
    # A username or an email address.
    if not re.fullmatch(r"[A-Za-z0-9._%+@-]{3,64}", username):
        raise ValueError("Username must be 3–64 chars (letters, digits, . _ % + @ -)")
    if len(password or "") < 8:
        raise ValueError("Password must be at least 8 characters")
    salt = secrets.token_hex(16)
    try:
        with _db() as cur:
            cur.execute(
                "INSERT INTO users(username, pw_hash, salt, created_at) VALUES(%s,%s,%s,%s) RETURNING id",
                (username, _hash(password, salt), salt, time.time()),
            )
            return {"id": cur.fetchone()["id"], "username": username}
    except psycopg2.IntegrityError:
        raise ValueError("That username is taken")


def delete_user(username):
    """Remove a user (sessions + prefs cascade via FK). No-op if absent. Used by
    the test harness to (re)create its throwaway `_ci` account."""
    with _db() as cur:
        cur.execute("DELETE FROM users WHERE username = %s", ((username or "").strip(),))


def verify_user(username, password):
    """{id, username} if the password matches, else None (constant-time compare)."""
    with _db() as cur:
        cur.execute("SELECT * FROM users WHERE username = %s", ((username or "").strip(),))
        row = cur.fetchone()
    if not row:
        return None
    if hmac.compare_digest(_hash(password or "", row["salt"]), row["pw_hash"]):
        return {"id": row["id"], "username": row["username"]}
    return None


def create_session(user_id):
    token, now = secrets.token_urlsafe(32), time.time()
    with _db() as cur:
        cur.execute(
            "INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(%s,%s,%s,%s)",
            (token, user_id, now, now + SESSION_TTL),
        )
    return token


def user_for_session(token):
    """{id, username} for a live session token, else None. Cached ~60s so the
    per-request auth check isn't a DB round-trip every time."""
    if not token:
        return None
    now = time.time()
    hit = _session_cache.get(token)
    if hit and now - hit[1] < _SESSION_CACHE_TTL:
        return hit[0]
    with _db() as cur:
        cur.execute(
            "SELECT u.id, u.username, s.expires_at FROM sessions s "
            "JOIN users u ON u.id = s.user_id WHERE s.token = %s",
            (token,),
        )
        row = cur.fetchone()
        if row and row["expires_at"] < now:
            cur.execute("DELETE FROM sessions WHERE token = %s", (token,))
            row = None
    user = {"id": row["id"], "username": row["username"]} if row else None
    _session_cache[token] = (user, now)
    return user


def delete_session(token):
    if not token:
        return
    _session_cache.pop(token, None)
    with _db() as cur:
        cur.execute("DELETE FROM sessions WHERE token = %s", (token,))


def get_prefs(user_id):
    with _db() as cur:
        cur.execute("SELECT data FROM prefs WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
    return row["data"] if row and isinstance(row["data"], dict) else {}


def set_prefs(user_id, data):
    with _db() as cur:
        cur.execute(
            "INSERT INTO prefs(user_id, data) VALUES(%s, %s) "
            "ON CONFLICT(user_id) DO UPDATE SET data = excluded.data",
            (user_id, Json(data or {})),
        )
