"""Users, sign-in sessions and per-user preferences."""
import hashlib
import hmac
import re
import secrets
import threading
import time

import psycopg2
from psycopg2.extras import Json

from orchestrator.shared import postgres


SESSION_COOKIE = "viewer_session"
SESSION_TTL = 30 * 86400          # 30 days
_PBKDF2_ROUNDS = 200_000
_SESSION_CACHE_TTL = 60           # seconds a session→user lookup is trusted without re-hitting the DB
_session_cache = {}               # token -> (user_or_None, cached_at)
_session_cache_lock = threading.Lock()
_SESSION_CACHE_MAX = 4096         # bound so token-scanning can't grow it without limit


def _hash(password, salt_hex):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), _PBKDF2_ROUNDS).hex()


def user_count():
    with postgres.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM users")
        return cur.fetchone()["n"]


def create_user(username, password):
    """Create a user; returns {id, username, role}. Raises ValueError on bad input
    or a taken username.

    The FIRST account is the owner: signup closes once a user exists
    (routes/auth.py), so the account that bootstraps an install is by definition
    the person who owns it. Everyone created after starts as `viewer` and is
    promoted deliberately — authority is granted, never assumed."""
    username = (username or "").strip()
    # A username or an email address.
    if not re.fullmatch(r"[A-Za-z0-9._%+@-]{3,64}", username):
        raise ValueError("Username must be 3–64 chars (letters, digits, . _ % + @ -)")
    if len(password or "") < 8:
        raise ValueError("Password must be at least 8 characters")
    salt = secrets.token_hex(16)
    try:
        with postgres.cursor() as cur:
            # Decided in SQL, in the same statement as the INSERT, so two
            # concurrent first-signups cannot both see an empty table and both
            # become owner.
            cur.execute(
                "INSERT INTO users(username, pw_hash, salt, role, created_at) "
                "VALUES(%s,%s,%s,"
                "  CASE WHEN EXISTS(SELECT 1 FROM users) THEN 'viewer' ELSE 'owner' END,"
                "  %s) RETURNING id, role",
                (username, _hash(password, salt), salt, time.time()),
            )
            row = cur.fetchone()
            return {"id": row["id"], "username": username, "role": row["role"]}
    except psycopg2.IntegrityError:
        raise ValueError("That username is taken")


def delete_user(username):
    """Remove a user (sessions + prefs cascade via FK). No-op if absent. Used by
    the test harness to (re)create its throwaway `_ci` account."""
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM users WHERE username = %s", ((username or "").strip(),))


def verify_user(username, password):
    """{id, username, role} if the password matches, else None (constant-time compare)."""
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM users WHERE username = %s", ((username or "").strip(),))
        row = cur.fetchone()
    if not row:
        return None
    if hmac.compare_digest(_hash(password or "", row["salt"]), row["pw_hash"]):
        return {"id": row["id"], "username": row["username"], "role": row["role"]}
    return None


def create_session(user_id):
    token, now = secrets.token_urlsafe(32), time.time()
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(%s,%s,%s,%s)",
            (token, user_id, now, now + SESSION_TTL),
        )
    return token


def user_for_session(token):
    """{id, username, role} for a live session token, else None. Cached ~60s so the
    per-request auth check isn't a DB round-trip every time."""
    if not token:
        return None
    now = time.time()
    with _session_cache_lock:
        hit = _session_cache.get(token)
    if hit and now - hit[1] < _SESSION_CACHE_TTL:
        return hit[0]
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT u.id, u.username, u.role, s.expires_at FROM sessions s "
            "JOIN users u ON u.id = s.user_id WHERE s.token = %s",
            (token,),
        )
        row = cur.fetchone()
        if row and row["expires_at"] < now:
            cur.execute("DELETE FROM sessions WHERE token = %s", (token,))
            row = None
    user = ({"id": row["id"], "username": row["username"], "role": row["role"]}
            if row else None)
    with _session_cache_lock:
        # Bound the cache: on overflow drop the oldest entry (FIFO) so a stream of
        # distinct/invalid tokens can't grow it without limit.
        if token not in _session_cache and len(_session_cache) >= _SESSION_CACHE_MAX:
            _session_cache.pop(next(iter(_session_cache)), None)
        _session_cache[token] = (user, now)
    return user


def owner_user_id():
    """The install owner's account id — whose personal agents an unattended
    agent session (no logged-in human) acts for. None before an owner exists."""
    with postgres.cursor() as cur:
        cur.execute("SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1")
        row = cur.fetchone()
    return row["id"] if row else None


def owner_role():
    """The install owner's role, for requests with no logged-in human (a loop or
    cron spawn). Returns 'owner' once an owner account exists, else '' — a fresh
    install with no accounts confers no authority rather than assuming it."""
    with postgres.cursor() as cur:
        cur.execute("SELECT 1 FROM users WHERE role = 'owner' LIMIT 1")
        return "owner" if cur.fetchone() else ""


def delete_session(token):
    if not token:
        return
    with _session_cache_lock:
        _session_cache.pop(token, None)
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM sessions WHERE token = %s", (token,))


def get_prefs(user_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT data FROM prefs WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
    return row["data"] if row and isinstance(row["data"], dict) else {}


def set_prefs(user_id, data):
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO prefs(user_id, data) VALUES(%s, %s) "
            "ON CONFLICT(user_id) DO UPDATE SET data = excluded.data",
            (user_id, Json(data or {})),
        )
