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
            CREATE TABLE IF NOT EXISTS push_tokens (
              token      TEXT PRIMARY KEY,
              user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              platform   TEXT NOT NULL DEFAULT 'ios',
              created_at DOUBLE PRECISION NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pending_questions (
              session_id  TEXT PRIMARY KEY,
              tool_use_id TEXT NOT NULL,
              questions   JSONB NOT NULL,
              status      TEXT NOT NULL DEFAULT 'open',
              host        TEXT NOT NULL DEFAULT 'local',
              created_at  DOUBLE PRECISION NOT NULL
            );
            ALTER TABLE pending_questions ADD COLUMN IF NOT EXISTS host TEXT NOT NULL DEFAULT 'local';
            CREATE TABLE IF NOT EXISTS pending_plans (
              session_id  TEXT PRIMARY KEY,
              tool_use_id TEXT NOT NULL,
              plan        TEXT NOT NULL,
              status      TEXT NOT NULL DEFAULT 'open',
              host        TEXT NOT NULL DEFAULT 'local',
              created_at  DOUBLE PRECISION NOT NULL
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


def add_push_token(user_id, token, platform="ios"):
    """Register a device push token for a user. Idempotent: re-registering the
    same token re-points it at this user (a device can only serve one account)."""
    if not token:
        return
    with _db() as cur:
        cur.execute(
            "INSERT INTO push_tokens(token, user_id, platform, created_at) VALUES(%s,%s,%s,%s) "
            "ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, "
            "platform = excluded.platform, created_at = excluded.created_at",
            (token, user_id, platform or "ios", time.time()),
        )


def remove_push_token(token):
    """Drop a device token (logout, or Expo reported it unregistered)."""
    if not token:
        return
    with _db() as cur:
        cur.execute("DELETE FROM push_tokens WHERE token = %s", (token,))


def push_tokens_for_user(user_id):
    """All device tokens registered for a user (may be several devices)."""
    with _db() as cur:
        cur.execute("SELECT token FROM push_tokens WHERE user_id = %s", (user_id,))
        return [r["token"] for r in cur.fetchall()]


def all_push_tokens():
    """Every registered device token. The base is single-owner, so a run's
    completion pushes to all of them (there's effectively one account)."""
    with _db() as cur:
        cur.execute("SELECT token FROM push_tokens")
        return [r["token"] for r in cur.fetchall()]


# ---- pending questions (async AskUserQuestion) ---------------------------------
# When a driven run ends on an unanswered AskUserQuestion, the question is parked
# here as a durable row instead of blocking a live subprocess. The app renders it
# and, when the user answers, the session is resumed via `claude --resume`. One
# open question per session at a time (PRIMARY KEY on session_id).


def pending_question_set(session_id, tool_use_id, questions, host="local"):
    """Record (or replace) the open question for a session, remembering which host
    the run was on so the answer can resume there."""
    with _db() as cur:
        cur.execute(
            "INSERT INTO pending_questions(session_id, tool_use_id, questions, status, host, created_at) "
            "VALUES(%s,%s,%s,'open',%s,%s) "
            "ON CONFLICT(session_id) DO UPDATE SET tool_use_id = excluded.tool_use_id, "
            "questions = excluded.questions, status = 'open', host = excluded.host, "
            "created_at = excluded.created_at",
            (session_id, tool_use_id, Json(questions or []), host or "local", time.time()),
        )


def pending_question_get_open(session_id):
    """The open question for a session, else None. Shape:
    {tool_use_id, questions, host}."""
    with _db() as cur:
        cur.execute(
            "SELECT tool_use_id, questions, host FROM pending_questions "
            "WHERE session_id = %s AND status = 'open'",
            (session_id,),
        )
        row = cur.fetchone()
    return {"tool_use_id": row["tool_use_id"], "questions": row["questions"],
            "host": row["host"]} if row else None


def pending_question_resolve(session_id, tool_use_id):
    """Mark the session's open question answered. Returns True if one was open and
    matched (guards a double-submit / stale card). Deletes the row (answered
    questions carry no further state — the resumed run is the record)."""
    with _db() as cur:
        cur.execute(
            "DELETE FROM pending_questions WHERE session_id = %s AND tool_use_id = %s AND status = 'open'",
            (session_id, tool_use_id),
        )
        return cur.rowcount > 0


def pending_question_delete(session_id):
    """Drop any pending question for a session (e.g. session deleted)."""
    with _db() as cur:
        cur.execute("DELETE FROM pending_questions WHERE session_id = %s", (session_id,))


# ---- pending plans (ExitPlanMode approval) -------------------------------------

def pending_plan_set(session_id, tool_use_id, plan, host="local"):
    """Record (or replace) the open plan awaiting approval for a session."""
    with _db() as cur:
        cur.execute(
            "INSERT INTO pending_plans(session_id, tool_use_id, plan, status, host, created_at) "
            "VALUES(%s,%s,%s,'open',%s,%s) "
            "ON CONFLICT(session_id) DO UPDATE SET tool_use_id = excluded.tool_use_id, "
            "plan = excluded.plan, status = 'open', host = excluded.host, "
            "created_at = excluded.created_at",
            (session_id, tool_use_id, plan or "", host or "local", time.time()),
        )


def pending_plan_get_open(session_id):
    """The open plan for a session, else None. Shape: {tool_use_id, plan, host}."""
    with _db() as cur:
        cur.execute(
            "SELECT tool_use_id, plan, host FROM pending_plans "
            "WHERE session_id = %s AND status = 'open'",
            (session_id,),
        )
        row = cur.fetchone()
    return {"tool_use_id": row["tool_use_id"], "plan": row["plan"],
            "host": row["host"]} if row else None


def pending_plan_delete(session_id):
    with _db() as cur:
        cur.execute("DELETE FROM pending_plans WHERE session_id = %s", (session_id,))
