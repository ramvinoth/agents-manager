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
_session_cache_lock = threading.Lock()
_SESSION_CACHE_MAX = 4096         # bound so token-scanning can't grow it without limit


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
            -- ── Orchestrator ("Harman") empire tables ─────────────────────────
            -- ONE canonical Kanban board: a single cards table; every per-session
            -- / project / employee / CEO "board" is a filtered VIEW of it. See
            -- ORCHESTRATOR_KANBAN.md + viewer/orglogic.py.
            CREATE TABLE IF NOT EXISTS employees (
              id         SERIAL PRIMARY KEY,
              name       TEXT NOT NULL,
              role       TEXT NOT NULL DEFAULT '',
              provider   TEXT NOT NULL DEFAULT '',
              model      TEXT NOT NULL DEFAULT '',
              conv_mode  TEXT NOT NULL DEFAULT 'chat',
              avatar     TEXT NOT NULL DEFAULT '',
              status     TEXT NOT NULL DEFAULT 'active',
              created_at DOUBLE PRECISION NOT NULL
            );
            CREATE TABLE IF NOT EXISTS projects (
              id          SERIAL PRIMARY KEY,
              name        TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '',
              host        TEXT NOT NULL DEFAULT 'local',
              cwd         TEXT NOT NULL DEFAULT '',
              created_by  TEXT NOT NULL DEFAULT '',
              created_at  DOUBLE PRECISION NOT NULL
            );
            CREATE TABLE IF NOT EXISTS board_columns (
              id       SERIAL PRIMARY KEY,
              name     TEXT NOT NULL,
              position INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS cards (
              id         SERIAL PRIMARY KEY,
              title      TEXT NOT NULL,
              body       TEXT NOT NULL DEFAULT '',
              column_id  INTEGER REFERENCES board_columns(id) ON DELETE SET NULL,
              assignee   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
              project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
              session_id TEXT,
              position   DOUBLE PRECISION NOT NULL DEFAULT 1.0,
              created_by TEXT NOT NULL DEFAULT '',
              created_at DOUBLE PRECISION NOT NULL,
              updated_at DOUBLE PRECISION NOT NULL
            );
            CREATE TABLE IF NOT EXISTS approvals (
              id          SERIAL PRIMARY KEY,
              kind        TEXT NOT NULL,
              summary     TEXT NOT NULL DEFAULT '',
              detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
              status      TEXT NOT NULL DEFAULT 'open',
              created_by  TEXT NOT NULL DEFAULT '',
              created_at  DOUBLE PRECISION NOT NULL,
              resolved_at DOUBLE PRECISION,
              resolution  TEXT
            );
            CREATE TABLE IF NOT EXISTS audit_log (
              id         SERIAL PRIMARY KEY,
              actor      TEXT NOT NULL DEFAULT '',
              action     TEXT NOT NULL,
              target     JSONB NOT NULL DEFAULT '{}'::jsonb,
              outcome    TEXT NOT NULL DEFAULT '',
              created_at DOUBLE PRECISION NOT NULL
            );
            CREATE TABLE IF NOT EXISTS skills_learned (
              id             SERIAL PRIMARY KEY,
              name           TEXT NOT NULL,
              path           TEXT NOT NULL DEFAULT '',
              origin_employee INTEGER REFERENCES employees(id) ON DELETE SET NULL,
              origin_card    INTEGER,
              origin_session TEXT,
              status         TEXT NOT NULL DEFAULT 'proposed',
              created_at     DOUBLE PRECISION NOT NULL
            );
            """
        )
    # Seed the one board's default columns (idempotent).
    board_columns_seed()


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
    with _session_cache_lock:
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
    with _session_cache_lock:
        # Bound the cache: on overflow drop the oldest entry (FIFO) so a stream of
        # distinct/invalid tokens can't grow it without limit.
        if token not in _session_cache and len(_session_cache) >= _SESSION_CACHE_MAX:
            _session_cache.pop(next(iter(_session_cache)), None)
        _session_cache[token] = (user, now)
    return user


def delete_session(token):
    if not token:
        return
    with _session_cache_lock:
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


# ── Orchestrator ("Harman") accessors ────────────────────────────────────────
# Dumb CRUD only: policy (Green/Red gate, audit-on-action) lives in the
# orchestrator layer (P1+), not here. Rows come back as RealDictCursor dicts.

def _now():
    return time.time()


# Employees -------------------------------------------------------------------

def employee_create(name, role="", provider="", model="", conv_mode="chat", avatar="", status="active"):
    with _db() as cur:
        cur.execute(
            "INSERT INTO employees(name, role, provider, model, conv_mode, avatar, status, created_at) "
            "VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
            (name, role, provider, model, conv_mode, avatar, status, _now()),
        )
        return dict(cur.fetchone())


def employee_list():
    with _db() as cur:
        cur.execute("SELECT * FROM employees ORDER BY id")
        return [dict(r) for r in cur.fetchall()]


def employee_get(emp_id):
    with _db() as cur:
        cur.execute("SELECT * FROM employees WHERE id = %s", (emp_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def employee_update(emp_id, **fields):
    """Update the given columns (name/role/provider/model/conv_mode/avatar/status)."""
    allowed = ("name", "role", "provider", "model", "conv_mode", "avatar", "status")
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets:
        return employee_get(emp_id)
    cols = ", ".join(f"{k} = %s" for k in sets)
    with _db() as cur:
        cur.execute(f"UPDATE employees SET {cols} WHERE id = %s RETURNING *",
                    (*sets.values(), emp_id))
        row = cur.fetchone()
    return dict(row) if row else None


def employee_set_status(emp_id, status):
    return employee_update(emp_id, status=status)


# Projects --------------------------------------------------------------------

def project_create(name, description="", host="local", cwd="", created_by=""):
    with _db() as cur:
        cur.execute(
            "INSERT INTO projects(name, description, host, cwd, created_by, created_at) "
            "VALUES(%s,%s,%s,%s,%s,%s) RETURNING *",
            (name, description, host, cwd, created_by, _now()),
        )
        return dict(cur.fetchone())


def project_list():
    with _db() as cur:
        cur.execute("SELECT * FROM projects ORDER BY id")
        return [dict(r) for r in cur.fetchall()]


def project_get(project_id):
    with _db() as cur:
        cur.execute("SELECT * FROM projects WHERE id = %s", (project_id,))
        row = cur.fetchone()
    return dict(row) if row else None


# Board columns (the ONE board's layout) --------------------------------------

_DEFAULT_COLUMNS = ("Todo", "Doing", "Review", "Done")


def board_columns_seed():
    """Idempotently seed the default columns if the board has none yet."""
    with _db() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM board_columns")
        if cur.fetchone()["n"]:
            return
        for i, name in enumerate(_DEFAULT_COLUMNS):
            cur.execute("INSERT INTO board_columns(name, position) VALUES(%s,%s)", (name, i))


def board_columns_list():
    with _db() as cur:
        cur.execute("SELECT * FROM board_columns ORDER BY position, id")
        return [dict(r) for r in cur.fetchall()]


# Cards (the ONLY card store) -------------------------------------------------

def card_create(title, body="", column_id=None, assignee=None, project_id=None,
                session_id=None, position=1.0, created_by=""):
    with _db() as cur:
        cur.execute(
            "INSERT INTO cards(title, body, column_id, assignee, project_id, session_id, "
            "position, created_by, created_at, updated_at) "
            "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
            (title, body, column_id, assignee, project_id, session_id, position,
             created_by, _now(), _now()),
        )
        return dict(cur.fetchone())


def card_list(session_id=None, project_id=None, assignee=None, column_id=None):
    """All cards, optionally narrowed by any combination of filters (AND). The
    canonical fetch behind every board VIEW; ordering by position is applied in
    viewer.orglogic for the pure/testable path."""
    clauses, params = [], []
    if session_id is not None:
        clauses.append("session_id = %s"); params.append(session_id)
    if project_id is not None:
        clauses.append("project_id = %s"); params.append(project_id)
    if assignee is not None:
        clauses.append("assignee = %s"); params.append(assignee)
    if column_id is not None:
        clauses.append("column_id = %s"); params.append(column_id)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with _db() as cur:
        cur.execute(f"SELECT * FROM cards{where} ORDER BY position, id", params)
        return [dict(r) for r in cur.fetchall()]


def card_get(card_id):
    with _db() as cur:
        cur.execute("SELECT * FROM cards WHERE id = %s", (card_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def card_update(card_id, **fields):
    allowed = ("title", "body", "column_id", "assignee", "project_id", "session_id", "position")
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets:
        return card_get(card_id)
    sets["updated_at"] = _now()
    cols = ", ".join(f"{k} = %s" for k in sets)
    with _db() as cur:
        cur.execute(f"UPDATE cards SET {cols} WHERE id = %s RETURNING *",
                    (*sets.values(), card_id))
        row = cur.fetchone()
    return dict(row) if row else None


def card_move(card_id, column_id, position):
    return card_update(card_id, column_id=column_id, position=position)


def card_assign(card_id, assignee):
    return card_update(card_id, assignee=assignee)


def card_delete(card_id):
    """Hard-delete a card (a pure work item — no provenance to preserve, unlike an
    employee). Returns True if a row was removed."""
    with _db() as cur:
        cur.execute("DELETE FROM cards WHERE id = %s", (card_id,))
        return cur.rowcount > 0


# Approvals -------------------------------------------------------------------

def approval_open(kind, summary="", detail=None, created_by=""):
    with _db() as cur:
        cur.execute(
            "INSERT INTO approvals(kind, summary, detail, status, created_by, created_at) "
            "VALUES(%s,%s,%s,'open',%s,%s) RETURNING *",
            (kind, summary, Json(detail or {}), created_by, _now()),
        )
        return dict(cur.fetchone())


def approval_list_open():
    with _db() as cur:
        cur.execute("SELECT * FROM approvals WHERE status = 'open' ORDER BY created_at")
        return [dict(r) for r in cur.fetchall()]


def approval_resolve(approval_id, resolution):
    """Mark an approval resolved ('approved'/'denied'/free text)."""
    with _db() as cur:
        cur.execute(
            "UPDATE approvals SET status = 'resolved', resolution = %s, resolved_at = %s "
            "WHERE id = %s RETURNING *",
            (resolution, _now(), approval_id),
        )
        row = cur.fetchone()
    return dict(row) if row else None


# Audit log (append-only) -----------------------------------------------------

def audit_append(actor, action, target=None, outcome=""):
    with _db() as cur:
        cur.execute(
            "INSERT INTO audit_log(actor, action, target, outcome, created_at) "
            "VALUES(%s,%s,%s,%s,%s) RETURNING id",
            (actor, action, Json(target or {}), outcome, _now()),
        )
        return cur.fetchone()["id"]


def audit_list(limit=100, actor=None, action=None):
    clauses, params = [], []
    if actor is not None:
        clauses.append("actor = %s"); params.append(actor)
    if action is not None:
        clauses.append("action = %s"); params.append(action)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(int(limit))
    with _db() as cur:
        cur.execute(f"SELECT * FROM audit_log{where} ORDER BY id DESC LIMIT %s", params)
        return [dict(r) for r in cur.fetchall()]


# Learned skills (provenance ledger; content stays a SKILL.md file) -----------

def skill_learned_record(name, path="", origin_employee=None, origin_card=None,
                         origin_session=None, status="proposed"):
    with _db() as cur:
        cur.execute(
            "INSERT INTO skills_learned(name, path, origin_employee, origin_card, "
            "origin_session, status, created_at) VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING *",
            (name, path, origin_employee, origin_card, origin_session, status, _now()),
        )
        return dict(cur.fetchone())


def skill_learned_list(status=None):
    clauses, params = [], []
    if status is not None:
        clauses.append("status = %s"); params.append(status)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with _db() as cur:
        cur.execute(f"SELECT * FROM skills_learned{where} ORDER BY id DESC", params)
        return [dict(r) for r in cur.fetchall()]


def skill_learned_set_status(skill_id, status):
    with _db() as cur:
        cur.execute("UPDATE skills_learned SET status = %s WHERE id = %s RETURNING *",
                    (status, skill_id))
        row = cur.fetchone()
    return dict(row) if row else None
