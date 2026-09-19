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
import json
import os
import re
import secrets
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import psycopg2
import psycopg2.pool
from psycopg2.extras import Json, RealDictCursor

# orglogic is pure (no viewer imports) — importing it here cannot cycle, and the
# default pipeline shape lives ONCE there (orglogic.PIPELINE_COLUMNS).
from viewer import orglogic

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
              role       TEXT NOT NULL DEFAULT 'viewer',
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
            CREATE TABLE IF NOT EXISTS session_tokens (
              session_id     TEXT PRIMARY KEY,
              perm_token     TEXT NOT NULL DEFAULT '',
              kanban_token   TEXT NOT NULL DEFAULT '',
              employee_id    INTEGER,
              employee_level TEXT NOT NULL DEFAULT 'ic',
              cwd            TEXT NOT NULL DEFAULT '',
              host           TEXT NOT NULL DEFAULT 'local',
              created_at     DOUBLE PRECISION NOT NULL
            );
            ALTER TABLE pending_questions ADD COLUMN IF NOT EXISTS host TEXT NOT NULL DEFAULT 'local';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'viewer';
            -- Existing installs: the first account IS the owner (signup closes after
            -- it, see routes/auth.py), so promote it rather than locking the only
            -- user out of their own instance. Idempotent: only fires while no owner
            -- exists, so a later demotion is not silently undone.
            UPDATE users SET role = 'owner' WHERE id = (SELECT MIN(id) FROM users)
              AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner');
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
              id         SERIAL PRIMARY KEY,
              project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              name       TEXT NOT NULL,
              position   INTEGER NOT NULL DEFAULT 0
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
            -- The discussion thread on a card: where the owner and the card's
            -- session talk about the work (decisions, questions, status). `author`
            -- is the resolved principal actor, same string audit_log carries
            -- (user:<name> / an employee or session id) — no FK, because an
            -- agent's identity is a name, not a row.
            CREATE TABLE IF NOT EXISTS card_comments (
              id         SERIAL PRIMARY KEY,
              card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
              author     TEXT NOT NULL DEFAULT '',
              body       TEXT NOT NULL,
              created_at DOUBLE PRECISION NOT NULL
            );
            -- Task dependencies: an edge A -> B means "A cannot move forward
            -- until B is done". Both endpoints cascade with their cards. The
            -- self-edge guard lives in card_dep_add (an SQL check could express
            -- it too, but the rejection message belongs with the code that
            -- receives the intent).
            CREATE TABLE IF NOT EXISTS card_deps (
              id         SERIAL PRIMARY KEY,
              card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
              depends_on INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
              created_by TEXT NOT NULL DEFAULT '',
              created_at DOUBLE PRECISION NOT NULL,
              UNIQUE (card_id, depends_on)
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
            CREATE TABLE IF NOT EXISTS session_backups (
              id              SERIAL PRIMARY KEY,
              session_id      TEXT NOT NULL,
              backup_path     TEXT NOT NULL,
              original_bytes  BIGINT NOT NULL,
              trimmed_bytes   BIGINT,
              reason          TEXT NOT NULL DEFAULT 'auto_trim',
              created_at      TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_sb_session ON session_backups(session_id);
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
            CREATE TABLE IF NOT EXISTS agent_templates (
              id             SERIAL PRIMARY KEY,
              name           TEXT NOT NULL,
              description    TEXT NOT NULL DEFAULT '',
              category       TEXT NOT NULL DEFAULT 'general',
              icon           TEXT NOT NULL DEFAULT 'sparkle',
              system_prompt  TEXT NOT NULL DEFAULT '',
              goal           TEXT NOT NULL DEFAULT '',
              model          TEXT NOT NULL DEFAULT '',
              cron           TEXT,
              job_prompt     TEXT,
              is_builtin     BOOLEAN NOT NULL DEFAULT FALSE,
              created_by     TEXT NOT NULL DEFAULT 'system',
              created_at     DOUBLE PRECISION NOT NULL DEFAULT (extract(epoch from now()))
            );
            -- Migration: add model column if table existed before this field.
            ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT '';
            -- ── Stores migrated from the ~/.claude/*.json files ─────────────────
            -- The JSON files used to be the second persistence layer; this closes
            -- that split so Postgres is the single source of truth (and the only
            -- thing a SaaS deployment needs to carry). migrate_legacy_files()
            -- backfills them once, on first run.
            CREATE TABLE IF NOT EXISTS loops (
              id          TEXT PRIMARY KEY,
              session     TEXT NOT NULL DEFAULT '',
              path        TEXT NOT NULL DEFAULT '',
              prompt      TEXT NOT NULL DEFAULT '',
              interval_sec INTEGER NOT NULL DEFAULT 0,
              cron        TEXT,
              next_run    DOUBLE PRECISION NOT NULL DEFAULT 0,
              runs        INTEGER NOT NULL DEFAULT 0,
              last_run    DOUBLE PRECISION,
              last_rc     INTEGER,
              created     DOUBLE PRECISION NOT NULL DEFAULT 0,
              model       TEXT NOT NULL DEFAULT '',
              -- Custom provider preset id this loop's runs should use. '' = inherit
              -- the resumed session's own provider (the common case). Set to pin a
              -- loop to a specific endpoint regardless of the session's setting; the
              -- preset carries the model, so `model` above only applies to Default
              -- (built-in Claude) runs. Resolved at fire time in run_loop_iteration.
              provider    TEXT NOT NULL DEFAULT '',
              enabled     BOOLEAN NOT NULL DEFAULT TRUE,
              -- WHO scheduled this loop: 'user' (a human, via the UI) or 'harman'
              -- (an agent, via the gated loop_create action). The loop_control
              -- setting gates firing per-origin, INDEPENDENT of the automation
              -- master switch. Existing rows backfill to 'user' (the ALTER below),
              -- so a human's own schedules keep running after the upgrade.
              origin      TEXT NOT NULL DEFAULT 'user',
              -- 'recurring' (the default: cron or interval, re-advances every
              -- fire) or 'once' (a one-shot `at` task: the scheduler deletes the
              -- row when it fires — job_runs keeps the audit, so the loops table
              -- never accumulates spent one-shots).
              kind        TEXT NOT NULL DEFAULT 'recurring'
            );
            ALTER TABLE loops ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'user';
            ALTER TABLE loops ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT '';
            ALTER TABLE loops ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'recurring';
            -- Per-session extras the viewer owns (title/goal/systemPrompt/provider/
            -- convMode/effort/favorite/pinned/avatar/archived). The payload is
            -- free-form JSONB on purpose: the app adds keys over time and a typed
            -- schema would silently drop any it does not know yet.
            CREATE TABLE IF NOT EXISTS session_meta (
              session_id  TEXT PRIMARY KEY,
              data        JSONB NOT NULL DEFAULT '{}'::jsonb,
              updated_at  DOUBLE PRECISION NOT NULL
            );
            CREATE TABLE IF NOT EXISTS hosts (
              id             TEXT PRIMARY KEY,
              label          TEXT NOT NULL DEFAULT '',
              host           TEXT NOT NULL,
              "user"         TEXT NOT NULL,
              port           INTEGER NOT NULL DEFAULT 22,
              claude_home    TEXT NOT NULL DEFAULT '.claude',
              password       TEXT NOT NULL DEFAULT '',
              key_file       TEXT NOT NULL DEFAULT '',
              key_passphrase TEXT NOT NULL DEFAULT '',
              created_at     DOUBLE PRECISION NOT NULL
            );
            CREATE TABLE IF NOT EXISTS host_env (
              host  TEXT NOT NULL,
              key   TEXT NOT NULL,
              value TEXT NOT NULL,
              PRIMARY KEY (host, key)
            );
            CREATE TABLE IF NOT EXISTS providers (
              id            TEXT PRIMARY KEY,
              name          TEXT NOT NULL DEFAULT '',
              base_url      TEXT NOT NULL DEFAULT '',
              model         TEXT NOT NULL DEFAULT '',
              api_key       TEXT NOT NULL DEFAULT '',
              context_limit INTEGER NOT NULL DEFAULT 0,
              is_default    BOOLEAN NOT NULL DEFAULT FALSE,
              created_at    DOUBLE PRECISION NOT NULL
            );
            -- Append-only history: one row per loop firing, for auditability.
            -- loop_id is SET NULL (not CASCADE) on delete so a run's audit trail
            -- OUTLIVES the schedule it came from — a deleted/edited loop must not
            -- erase the record that it once ran. Bounded purely by retention
            -- (age + per-loop count, see job_runs_purge), never by unbounded growth.
            CREATE TABLE IF NOT EXISTS job_runs (
              id          SERIAL PRIMARY KEY,
              loop_id     TEXT REFERENCES loops(id) ON DELETE SET NULL,
              session_id  TEXT NOT NULL DEFAULT '',
              prompt      TEXT NOT NULL DEFAULT '',
              status      TEXT NOT NULL DEFAULT 'running',
              rc          INTEGER,
              detail      TEXT NOT NULL DEFAULT '',
              started_at  DOUBLE PRECISION NOT NULL,
              finished_at DOUBLE PRECISION
            );
            CREATE INDEX IF NOT EXISTS idx_job_runs_loop ON job_runs(loop_id, started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs(started_at);
            -- Singleton key/value store; holds the Harman config and the retention
            -- policy (job-run history caps — tunable at runtime for SaaS plan tiers).
            CREATE TABLE IF NOT EXISTS settings (
              key   TEXT PRIMARY KEY,
              value JSONB NOT NULL
            );
            -- Job-run retention defaults. Kept in settings (not code constants) so a
            -- future SaaS-admin portal can set per-plan caps without a deploy. DO
            -- NOTHING so an operator/admin edit always wins over the seed.
            INSERT INTO settings (key, value) VALUES ('retention',
              $${"job_runs_days": 90, "job_runs_per_loop": 500}$$::jsonb)
              ON CONFLICT (key) DO NOTHING;
            -- Fresh installs get Harman's config seeded (master switch OFF: an
            -- unattended machine must never start running on its own). DO NOTHING
            -- so the legacy-file backfill and any later user edit always win.
            INSERT INTO settings (key, value) VALUES ('harman',
              $${"automation_enabled": false, "enabled": true, "interval": 30,
                 "budget": 2, "projects": [], "default_provider": ""}$$::jsonb)
              ON CONFLICT (key) DO NOTHING;
            -- Loop-firing control. 'mode' is one of user|harman|both|none: which
            -- loop ORIGINS are licensed to fire. It is a different fact from the
            -- automation master switch (a runtime halt on the agent side of the
            -- same set — they intersect at fire time in engine.fire_due_loops).
            -- Default 'user' — a human's own scheduled loops run out of the box;
            -- harman-created loops additionally need the master switch on.
            -- DO NOTHING so a later user edit always wins over the seed.
            INSERT INTO settings (key, value) VALUES ('loop_control',
              $${"mode": "user"}$$::jsonb)
              ON CONFLICT (key) DO NOTHING;
            -- System-awareness preamble prepended to EVERY session's system prompt
            -- (engine.append_system_prompt). Without it a session sees the raw
            -- mcp__viewer__* tool list but is never told it is a node in the Harman
            -- orchestration system or how the steering rules gate its power. Stored
            -- here (not a code constant) so it is editable at runtime with no deploy;
            -- to_jsonb(...::text) makes it a JSON string without escaping the body.
            -- DO NOTHING so any operator edit always wins over this seed.
            INSERT INTO settings (key, value) VALUES ('system_preamble',
              to_jsonb($preamble$You are one agent session inside the Harman system — a self-hostable multi-agent orchestration layer running on this machine (the "viewer"). It sees every chat session with roles and RBAC, can orchestrate other agent sessions, schedules recurring work, and distills reusable skills. You are not a lone assistant; you are a node in that system and can observe and steer it.

Your tools (mcp__viewer__*): observe — session_list/read/summary/analysis, host_list, audit_tail; org — employee_list, project_list, board_list, card_list/create/move/assign/update/comment, task_done; loops — loop_list/create/update/delete, loop_control_get/set; approvals — approval_list; skills — skill_list, skill_propose; trust — session_mode_set.

Authority: your power is the weaker of the human owner's role and this session's level (ic < lead < manager). A session not linked to an employee still authenticates — at ic, the least authority: you can observe the whole system, but most writes are gated and will queue for the owner's approval or be refused.

Steering rules: you may create/edit loops for OTHER sessions, never your own. session_mode_set changes another session's permission mode (up to 'bypass' — no tool gating at all): it is Red, so an agent's request queues for the owner, and a session may never set its own (the owner grants trust, a model never requests it of itself). Agent-scheduled (harman) loops fire only when the loop-control mode (user|harman|both|none) licenses that origin AND the automation master switch (harman.automation_enabled) is ON — it defaults OFF, so nothing agent-made runs unattended. Your own (user) scheduled loops follow the loop-control mode alone: the switch never stops work a human explicitly scheduled. Destructive ops (e.g. loop_delete) queue for the owner's approval rather than executing. Board/card writes are scoped to your level.

## The board pipeline (decisions live on the board)
Every project's board is the default pipeline: Todo → Doing → Review → Approved → Declined → Blocked → Needs-info → Done. "Review" is the holding state for work that needs the owner's decision — when you are done but a call is required, move your card to Review and comment with the question. The owner decides by moving the card to Approved or Declined, or by commenting; that move or comment reaches you as a [board-watch] wake. On a wake, read the card and its comments (card_comments) and act: Approved means proceed with that work (move it to Done when it is complete), Declined means stop it. If your work is stuck on a dependency, move the card to Blocked and comment on what is stuck; if you need a fact or a decision from the owner, move it to Needs-info and comment with the question — your comment pushes to the owner. A fresh comment on your card is a message for you — answer on the card. Comment on your card to report status: the owner gets a push when an agent comments. Never decide for the owner: a card in Review waits for their call, and a decision in Approved/Declined is theirs to make, not yours.

Full design: ORCHESTRATOR_MCP.md.

## Work discipline (board = the durable ledger)
In-conversation todos are scratch for the current task only. Work that outlives this conversation — parked or deferred items, follow-ups, work handed to another session or employee — becomes a board card via card_create before the session ends. When asked what work is pending, answer from the board (card_list), not from memory. The owner sees the same board; nothing should live only in a session's head.$preamble$::text))
              ON CONFLICT (key) DO NOTHING;
            -- Per-reader unread cursor: the last time a given reader OPENED a
            -- session. A session is unread for that reader when it changed after
            -- their cursor. Server-side (not per-device) so the signal is the same
            -- on web, mobile, and to an agent asking over MCP. `reader` is the
            -- resolved principal actor (user:<name> for a human — stable across
            -- their devices — or employee:<name>/session for an agent), never a
            -- device id. No FK to sessions: transcripts are files, not rows.
            CREATE TABLE IF NOT EXISTS session_seen (
              reader    TEXT NOT NULL,
              session   TEXT NOT NULL,
              last_seen DOUBLE PRECISION NOT NULL,
              PRIMARY KEY (reader, session)
            );
            """
        )
    _seed_agent_templates()
    migrate_legacy_files()
    # The decision pipeline is a board SHAPE, like the four defaults above:
    # every project carries it, so every start runs the idempotent ensure
    # (no-op on an install that already converged). One bad project must not
    # wedge the server's boot, so each is guarded.
    for proj in project_list():
        try:
            board_columns_ensure(proj["id"])
        except Exception:
            pass


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
        with _db() as cur:
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
    with _db() as cur:
        cur.execute("DELETE FROM users WHERE username = %s", ((username or "").strip(),))


def verify_user(username, password):
    """{id, username, role} if the password matches, else None (constant-time compare)."""
    with _db() as cur:
        cur.execute("SELECT * FROM users WHERE username = %s", ((username or "").strip(),))
        row = cur.fetchone()
    if not row:
        return None
    if hmac.compare_digest(_hash(password or "", row["salt"]), row["pw_hash"]):
        return {"id": row["id"], "username": row["username"], "role": row["role"]}
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
    """{id, username, role} for a live session token, else None. Cached ~60s so the
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


def owner_role():
    """The install owner's role, for requests with no logged-in human (a loop or
    cron spawn). Returns 'owner' once an owner account exists, else '' — a fresh
    install with no accounts confers no authority rather than assuming it."""
    with _db() as cur:
        cur.execute("SELECT 1 FROM users WHERE role = 'owner' LIMIT 1")
        return "owner" if cur.fetchone() else ""


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


# ---- session tokens (survive a server restart) --------------------------------
# The per-run perm/kanban tokens live in the server's in-memory CHAT_JOBS, which
# is wiped on restart. Persist them here so a session's still-running MCP tools
# (and the durable pending question/plan that references them) stay authorized
# across a restart. Cleared when the run's job is reaped.

def session_token_set(session_id, perm_token, kanban_token, employee_id,
                      employee_level="ic", cwd="", host="local"):
    with _db() as cur:
        cur.execute(
            "INSERT INTO session_tokens(session_id, perm_token, kanban_token, "
            "employee_id, employee_level, cwd, host, created_at) "
            "VALUES(%s,%s,%s,%s,%s,%s,%s,%s) "
            "ON CONFLICT (session_id) DO UPDATE SET "
            "perm_token = EXCLUDED.perm_token, kanban_token = EXCLUDED.kanban_token, "
            "employee_id = EXCLUDED.employee_id, employee_level = EXCLUDED.employee_level, "
            "cwd = EXCLUDED.cwd, host = EXCLUDED.host, created_at = EXCLUDED.created_at",
            (session_id, perm_token or "", kanban_token or "", employee_id,
             employee_level or "ic", cwd or "", host or "local", _now()),
        )


def session_token_get(session_id):
    with _db() as cur:
        cur.execute("SELECT * FROM session_tokens WHERE session_id = %s", (session_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def session_token_delete(session_id):
    with _db() as cur:
        cur.execute("DELETE FROM session_tokens WHERE session_id = %s", (session_id,))


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


# Projects --------------------------------------------------------------------

# Every project gets this column layout the moment it's created. The decision
# pipeline (Review = needs the owner's call, then Approved / Declined) sits
# between Doing and Done; Done stays last (task_done and the position fallbacks
# key on the final column). New projects get the full tuple here; projects
# created before the decision columns existed are fixed up by
# board_columns_ensure at every server start (idempotent no-op once done).
_DEFAULT_COLUMNS = orglogic.PIPELINE_COLUMNS


def project_create(name, description="", host="local", cwd="", created_by=""):
    with _db() as cur:
        cur.execute(
            "INSERT INTO projects(name, description, host, cwd, created_by, created_at) "
            "VALUES(%s,%s,%s,%s,%s,%s) RETURNING *",
            (name, description, host, cwd, created_by, _now()),
        )
        proj = dict(cur.fetchone())
        for i, cname in enumerate(_DEFAULT_COLUMNS):
            cur.execute(
                "INSERT INTO board_columns(project_id, name, position) VALUES(%s,%s,%s)",
                (proj["id"], cname, i),
            )
    return proj


def project_list():
    with _db() as cur:
        cur.execute("SELECT * FROM projects ORDER BY id")
        return [dict(r) for r in cur.fetchall()]


def project_get(project_id):
    with _db() as cur:
        cur.execute("SELECT * FROM projects WHERE id = %s", (project_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def project_get_by_cwd(host, cwd):
    cwd = _norm_cwd(host, cwd)
    with _db() as cur:
        cur.execute("SELECT * FROM projects WHERE host = %s AND cwd = %s ORDER BY id LIMIT 1",
                    (host, cwd))
        row = cur.fetchone()
    return dict(row) if row else None


def project_ensure(host, cwd, name, created_by=""):
    """Find-or-create the org project for a (host, cwd) directory. The single
    bridge between the LHS's cwd-keyed projects and the org board — resolved
    server-side so no client duplicates the mapping. cwd is normalized (tilde
    expanded on local) so the web entry point and a spawned agent session, which
    may pass the same dir in different forms, always land on ONE project. New
    projects get the default columns via project_create."""
    cwd = _norm_cwd(host, cwd)
    existing = project_get_by_cwd(host, cwd)
    if existing:
        return existing
    return project_create(name or cwd, "", host, cwd, created_by)


def _norm_cwd(host, cwd):
    """Canonical form of a directory used as a project key. On the local host we
    expand a leading ~ and strip a trailing slash so "~/x", "/home/u/x" and
    "/home/u/x/" don't fork into separate projects. Remote paths are left as-is
    (their home dir isn't ours to expand)."""
    cwd = (cwd or "").rstrip("/")
    if host in (None, "", "local") and cwd.startswith("~"):
        cwd = os.path.expanduser(cwd)
    return cwd or "/"


# Board columns (per project) -------------------------------------------------

def board_columns_list(project_id):
    with _db() as cur:
        cur.execute("SELECT * FROM board_columns WHERE project_id = %s ORDER BY position, id",
                    (project_id,))
        return [dict(r) for r in cur.fetchall()]


def board_column_create(project_id, name, position=0):
    with _db() as cur:
        cur.execute(
            "INSERT INTO board_columns(project_id, name, position) VALUES(%s,%s,%s) RETURNING *",
            (project_id, name, position),
        )
        return dict(cur.fetchone())


def board_column_update(column_id, **fields):
    allowed = {k: v for k, v in fields.items() if k in ("name", "position") and v is not None}
    if not allowed:
        return board_column_get(column_id)
    sets = ", ".join(f"{k} = %s" for k in allowed)
    with _db() as cur:
        cur.execute(f"UPDATE board_columns SET {sets} WHERE id = %s RETURNING *",
                    (*allowed.values(), column_id))
        row = cur.fetchone()
    return dict(row) if row else None


def board_column_get(column_id):
    with _db() as cur:
        cur.execute("SELECT * FROM board_columns WHERE id = %s", (column_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def board_column_delete(column_id):
    """Delete a column. Cards in it keep existing (column_id FK is ON DELETE
    SET NULL) so no task is lost when its column is removed."""
    with _db() as cur:
        cur.execute("DELETE FROM board_columns WHERE id = %s", (column_id,))
        return cur.rowcount > 0


def board_columns_ensure(project_id):
    """Guarantee the default pipeline is present on this project's board.

    Applies the pure orglogic.ensure_pipeline_columns plan: a pipeline-named
    column missing gets created at its canonical position; one present out of
    place gets its position canonicalised (the name is the contract — see
    orglogic.project_columns, which resolves the same way). Custom columns are
    never touched. Idempotent, and called at every server start (init_db) so
    projects created before the decision columns existed converge on the same
    shape as new ones — the pipeline is default everywhere, not opt-in.
    Returns the plan it applied (for tests/inspection)."""
    cols = board_columns_list(project_id)
    plan = orglogic.ensure_pipeline_columns(cols)
    current = {c["id"]: c["position"] for c in cols}
    applied = 0
    for item in plan:
        if item["id"] is None:
            board_column_create(project_id, item["name"], item["position"])
            applied += 1
        elif current.get(item["id"]) != item["position"]:
            board_column_update(item["id"], position=item["position"])
            applied += 1
    return plan



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


# Card comments (the discussion thread on a card) ----------------------------

def card_comment_add(card_id, author, body):
    with _db() as cur:
        cur.execute(
            "INSERT INTO card_comments(card_id, author, body, created_at) "
            "VALUES(%s,%s,%s,%s) RETURNING *",
            (card_id, author or "", body, _now()),
        )
        return dict(cur.fetchone())


def card_comment_list(card_id):
    with _db() as cur:
        cur.execute("SELECT * FROM card_comments WHERE card_id = %s ORDER BY created_at, id",
                    (card_id,))
        return [dict(r) for r in cur.fetchall()]


def card_comment_counts():
    """{card_id: n} over every card that has at least one comment — the badge
    the board lists render without N+1 per-card queries."""
    with _db() as cur:
        cur.execute("SELECT card_id, COUNT(*) AS n FROM card_comments GROUP BY card_id")
        return {r["card_id"]: r["n"] for r in cur.fetchall()}


# Card dependencies (A cannot move forward until B is done) ------------------

def card_dep_add(card_id, depends_on, created_by=""):
    """Record the edge `card_id` -> `depends_on`. A card may not depend on
    itself (that blocks itself forever); an existing edge is a no-op (the
    UNIQUE constraint, not a duplicate row). Returns the stored row, or
    {"exists": True} when the edge was already there."""
    if card_id == depends_on:
        return {"error": "a card cannot depend on itself"}
    with _db() as cur:
        cur.execute(
            "INSERT INTO card_deps(card_id, depends_on, created_by, created_at) "
            "VALUES(%s,%s,%s,%s) ON CONFLICT (card_id, depends_on) DO NOTHING "
            "RETURNING *",
            (card_id, depends_on, created_by or "", _now()),
        )
        row = cur.fetchone()
        return dict(row) if row else {"exists": True}


def card_dep_remove(card_id, depends_on):
    """Remove the edge; True if a row was deleted."""
    with _db() as cur:
        cur.execute("DELETE FROM card_deps WHERE card_id=%s AND depends_on=%s",
                    (card_id, depends_on))
        return cur.rowcount > 0


def card_deps_batch(card_ids):
    """{card_id: [dep, ...]} where dep = {id, title, column_name, done}.
    `done` follows the board's name contract: the dep's column named (case
    insensitive) "Done" — the same rule project_columns resolves by, so the
    web board, a woken session, and the owner's view all agree on what is done."""
    if not card_ids:
        return {}
    with _db() as cur:
        cur.execute(
            "SELECT d.card_id, d.depends_on AS id, c.title, bc.name AS column_name "
            "FROM card_deps d "
            "JOIN cards c ON c.id = d.depends_on "
            "LEFT JOIN board_columns bc ON bc.id = c.column_id "
            "WHERE d.card_id = ANY(%s) ORDER BY d.card_id, d.id",
            (list(card_ids),),
        )
        out = {}
        for r in cur.fetchall():
            col = (r.get("column_name") or "").lower()
            out.setdefault(r["card_id"], []).append(
                {"id": r["id"], "title": r.get("title", ""),
                 "column_name": r.get("column_name") or "",
                 "done": col == "done"})
        return out


def board_changed_since(since):
    """Did the board change after `since` (epoch seconds)? Cards (updated_at),
    comments (created_at) and dependency edges (created_at) all store epoch
    doubles, so the check is a plain numeric comparison. Returns
    (changed, summary) — the summary is a one-line data string for wake
    prompts, never instructions."""
    with _db() as cur:
        cur.execute("SELECT count(*) AS n FROM cards WHERE updated_at > %s", (since,))
        n_cards = cur.fetchone()["n"]
        cur.execute("SELECT count(*) AS n FROM card_comments WHERE created_at > %s",
                    (since,))
        n_comments = cur.fetchone()["n"]
        cur.execute("SELECT count(*) AS n FROM card_deps WHERE created_at > %s",
                    (since,))
        n_deps = cur.fetchone()["n"]
    if not (n_cards or n_comments or n_deps):
        return False, ""
    bits = []
    if n_cards:
        bits.append(f"{n_cards} card(s) changed")
    if n_comments:
        bits.append(f"{n_comments} new comment(s)")
    if n_deps:
        bits.append(f"{n_deps} dependency change(s)")
    return True, ", ".join(bits)


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


def approval_get(approval_id):
    with _db() as cur:
        cur.execute("SELECT * FROM approvals WHERE id = %s", (approval_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def approval_resolve(approval_id, resolution):
    """Mark an approval resolved ('approved'/'denied'/free text). Only an OPEN
    approval resolves: the row carries an intent that EXECUTES on approval, so
    without this an already-approved row could be re-resolved and the action run
    a second time. Returns None if it was not open."""
    with _db() as cur:
        cur.execute(
            "UPDATE approvals SET status = 'resolved', resolution = %s, resolved_at = %s "
            "WHERE id = %s AND status = 'open' RETURNING *",
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


# --------------------------------------------------------------------------- #
# Session backups                                                              #
# --------------------------------------------------------------------------- #

def backup_create(session_id, backup_path, original_bytes, trimmed_bytes=None,
                  reason="auto_trim"):
    """Record a new session backup. Returns the row dict."""
    with _db() as cur:
        cur.execute(
            "INSERT INTO session_backups(session_id, backup_path, original_bytes, "
            "trimmed_bytes, reason) VALUES(%s,%s,%s,%s,%s) RETURNING *",
            (session_id, backup_path, original_bytes, trimmed_bytes, reason),
        )
        return dict(cur.fetchone())


def backup_list(session_id):
    """List all backups for a session, newest first."""
    with _db() as cur:
        cur.execute(
            "SELECT * FROM session_backups WHERE session_id = %s ORDER BY created_at DESC",
            (session_id,),
        )
        return [dict(r) for r in cur.fetchall()]


def backup_get(backup_id):
    """Get a single backup by id."""
    with _db() as cur:
        cur.execute("SELECT * FROM session_backups WHERE id = %s", (backup_id,))
        row = cur.fetchone()
        return dict(row) if row else None


def backup_delete(backup_id):
    """Delete a backup row (caller is responsible for deleting the file)."""
    with _db() as cur:
        cur.execute("DELETE FROM session_backups WHERE id = %s RETURNING backup_path",
                    (backup_id,))
        row = cur.fetchone()
        return row["backup_path"] if row else None


# ---------------------------------------------------------------------------
# Agent templates — curated session presets
# ---------------------------------------------------------------------------

_BUILTIN_TEMPLATES = [
    # Personal
    {"name": "Writing Coach", "description": "Review and improve your writing for clarity, tone, and structure.",
     "category": "personal", "icon": "book", "model": "sonnet",
     "system_prompt": "You are a professional writing coach. Review the user's text for clarity, grammar, tone, and structure. Provide specific, actionable suggestions. Be encouraging but honest. Focus on making the writing more effective for its intended audience.",
     "goal": "Help the user produce clear, compelling writing."},
    {"name": "Learning Tutor", "description": "Explain concepts using the Socratic method, adapted to your level.",
     "category": "personal", "icon": "school", "model": "sonnet",
     "system_prompt": "You are a patient, adaptive tutor. Use the Socratic method: ask guiding questions before giving answers. Gauge the user's level from their questions and adjust complexity. Use analogies and concrete examples. When the user is stuck, break the problem into smaller steps rather than giving the full answer.",
     "goal": "Help the user deeply understand the topic, not just memorize answers."},
    {"name": "Fitness Planner", "description": "Create personalized workout and nutrition plans.",
     "category": "personal", "icon": "barbell", "model": "sonnet",
     "cron": "0 7 * * *",
     "job_prompt": "Good morning! Check in on yesterday's workout. Any soreness or energy changes? Adjust today's plan accordingly.",
     "system_prompt": "You are a certified personal trainer and nutritionist. Ask about the user's fitness goals, current fitness level, available equipment, and dietary preferences before creating plans. Provide structured weekly workout routines with sets, reps, and rest periods. Include warm-up and cool-down. Offer meal prep suggestions that are practical and sustainable.",
     "goal": "Create a realistic, sustainable fitness and nutrition plan tailored to the user's goals."},
    {"name": "Travel Planner", "description": "Build detailed itineraries with local tips and logistics.",
     "category": "personal", "icon": "airplane", "model": "sonnet",
     "system_prompt": "You are an experienced travel planner. When creating itineraries, consider: budget, travel style (adventure/relaxation/culture), season, visa requirements, local transportation, and must-see vs hidden gems. Organize by day with specific timings. Include practical tips: best neighborhoods to stay, local food to try, common scams to avoid, and packing essentials.",
     "goal": "Create a complete, day-by-day travel itinerary the user can follow immediately."},
    # Engineering
    {"name": "Code Reviewer", "description": "Thorough, constructive code reviews focused on correctness and maintainability.",
     "category": "engineering", "icon": "code", "model": "sonnet",
     "system_prompt": "You are a senior engineer doing code review. Focus on: correctness, edge cases, error handling, security, performance, readability, and maintainability. Prioritize issues by severity. Suggest specific improvements with code examples. Be respectful — explain WHY something is problematic, not just that it is. Check for: missing error handling, race conditions, resource leaks, and API contract violations.",
     "goal": "Catch bugs and improve code quality through constructive, specific feedback."},
    {"name": "Architect", "description": "System design and architecture decisions with trade-off analysis.",
     "category": "engineering", "icon": "build", "model": "opus",
     "system_prompt": "You are a senior software architect. When designing systems, always consider: scalability, reliability, maintainability, cost, and team capability. Present multiple options with explicit trade-offs. Use diagrams (describe them in text/mermaid) when helpful. Challenge assumptions. Ask clarifying questions about constraints before proposing solutions. Reference real-world patterns and their failure modes.",
     "goal": "Design robust, scalable systems with clear reasoning for every decision."},
    {"name": "Debug Assistant", "description": "Systematic debugging with hypothesis-driven investigation.",
     "category": "engineering", "icon": "bug", "model": "sonnet",
     "system_prompt": "You are an expert debugger. Follow a systematic approach: 1) Reproduce the issue, 2) Form hypotheses about the root cause, 3) Test each hypothesis with the smallest possible experiment, 4) Fix the root cause, not just symptoms. Ask for: error messages, logs, reproduction steps, and what changed recently. Consider: race conditions, state corruption, configuration drift, and dependency version mismatches.",
     "goal": "Find and fix the root cause of bugs, not just patch symptoms."},
    {"name": "DevOps Engineer", "description": "Infrastructure, CI/CD, monitoring, and deployment automation.",
     "category": "engineering", "icon": "cloud", "model": "sonnet",
     "cron": "0 */6 * * *",
     "job_prompt": "Run a health check: review recent logs, check error rates, and report any infrastructure alerts or anomalies.",
     "system_prompt": "You are a senior DevOps engineer. Help with: CI/CD pipelines, infrastructure as code (Terraform, Pulumi), container orchestration (Docker, K8s), monitoring/alerting, secrets management, and deployment strategies. Prioritize: reliability, security, automation, and observability. Always consider failure modes and rollback strategies. Prefer immutable infrastructure and declarative configuration.",
     "goal": "Build reliable, automated infrastructure with proper monitoring and rollback capabilities."},
    # Design
    {"name": "UX Researcher", "description": "User research, usability analysis, and interview planning.",
     "category": "design", "icon": "eye", "model": "sonnet",
     "system_prompt": "You are a UX researcher. Help plan and analyze user research: interviews, surveys, usability tests, and A/B tests. Write unbiased interview scripts. Identify cognitive biases in research design. Synthesize findings into actionable insights. Present recommendations with supporting evidence. Consider accessibility and inclusive design in all recommendations.",
     "goal": "Generate actionable user insights that improve product decisions."},
    {"name": "UI Designer", "description": "Component design, layout patterns, and accessibility.",
     "category": "design", "icon": "brush", "model": "sonnet",
     "system_prompt": "You are a senior UI designer. Help with: component design, layout patterns, responsive design, design tokens, accessibility (WCAG), animation/micro-interactions, and design system maintenance. Consider: visual hierarchy, whitespace, typography scale, color contrast, and touch targets. Always design for the worst case (long text, missing images, error states, loading states, empty states).",
     "goal": "Create polished, accessible UI components that handle all edge cases gracefully."},
    # Business
    {"name": "Marketing Strategist", "description": "Campaign planning, copywriting, and analytics strategy.",
     "category": "business", "icon": "megaphone", "model": "sonnet",
     "system_prompt": "You are a marketing strategist. Help with: campaign planning, content strategy, copywriting, social media, email marketing, SEO, and marketing analytics. Tailor strategies to the business size, budget, and target audience. Provide specific, measurable goals. Write copy that is clear, compelling, and on-brand. Always consider the customer journey and conversion funnel.",
     "goal": "Create data-driven marketing strategies with measurable outcomes."},
    {"name": "Product Manager", "description": "PRDs, prioritization frameworks, and user story writing.",
     "category": "business", "icon": "clipboard", "model": "sonnet",
     "system_prompt": "You are a senior product manager. Help with: writing PRDs, feature prioritization (RICE, ICE, MoSCoW), user story mapping, roadmap planning, stakeholder communication, and metrics definition. Ask clarifying questions about business goals, user needs, and technical constraints. Focus on outcomes over outputs. Define clear success metrics for every feature.",
     "goal": "Define products that solve real user problems and drive business outcomes."},
    {"name": "Legal Advisor", "description": "Contract review, compliance guidance, and risk assessment.",
     "category": "business", "icon": "shield", "model": "opus",
     "system_prompt": "You are a knowledgeable legal advisor. Help review contracts, identify risks, explain legal concepts in plain language, and suggest protective clauses. Cover: intellectual property, liability, termination, confidentiality, and regulatory compliance. Always caveat that you're providing general guidance, not legal advice, and recommend consulting a licensed attorney for specific situations.",
     "goal": "Identify legal risks and suggest protective measures in clear, plain language."},
    {"name": "Financial Analyst", "description": "Budgets, forecasts, financial modeling, and reporting.",
     "category": "business", "icon": "calculator", "model": "opus",
     "cron": "0 9 * * 1",
     "job_prompt": "Generate the weekly financial summary: review this week's activity, flag anomalies, and update the forecast.",
     "system_prompt": "You are a financial analyst. Help with: budget planning, financial forecasting, P&L analysis, cash flow management, pricing strategy, and financial reporting. Build clear financial models with assumptions stated explicitly. Use sensitivity analysis to show best/worst/expected cases. Present findings in a way that non-finance stakeholders can understand.",
     "goal": "Provide clear financial analysis that drives informed business decisions."},
]


def _seed_agent_templates():
    """Insert or update builtin templates on startup.
    On first run: inserts all. On subsequent runs: updates existing builtins
    (matched by name) to pick up new fields like model, cron, job_prompt."""
    with _db() as cur:
        for t in _BUILTIN_TEMPLATES:
            cur.execute("SELECT id FROM agent_templates WHERE name = %s AND is_builtin = TRUE", (t["name"],))
            row = cur.fetchone()
            if row:
                # Update existing builtin with any new field values
                cur.execute(
                    """UPDATE agent_templates SET description=%s, category=%s, icon=%s,
                       system_prompt=%s, goal=%s, model=%s, cron=%s, job_prompt=%s
                       WHERE id=%s""",
                    (t["description"], t["category"], t["icon"],
                     t["system_prompt"], t["goal"], t.get("model", ""),
                     t.get("cron"), t.get("job_prompt"), row["id"])
                )
            else:
                cur.execute(
                    """INSERT INTO agent_templates
                       (name, description, category, icon, system_prompt, goal, model, cron, job_prompt, is_builtin, created_by, created_at)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, TRUE, 'system', extract(epoch from now()))""",
                    (t["name"], t["description"], t["category"], t["icon"],
                     t["system_prompt"], t["goal"], t.get("model", ""),
                     t.get("cron"), t.get("job_prompt"))
                )


def agent_templates_list():
    """Return all templates (builtins + user-created), newest first."""
    with _db() as cur:
        cur.execute("SELECT * FROM agent_templates ORDER BY is_builtin DESC, category, name")
        return cur.fetchall()


def agent_template_create(name, description, category, icon, system_prompt, goal, model="", cron=None, job_prompt=None, created_by="user"):
    """Create a user-defined template. Returns the new row."""
    with _db() as cur:
        cur.execute(
            """INSERT INTO agent_templates
               (name, description, category, icon, system_prompt, goal, model, cron, job_prompt, is_builtin, created_by, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, FALSE, %s, extract(epoch from now()))
               RETURNING *""",
            (name, description, category, icon, system_prompt, goal, model, cron, job_prompt, created_by)
        )
        return cur.fetchone()


def agent_template_delete(template_id):
    """Delete a user-created template (builtins cannot be deleted)."""
    with _db() as cur:
        cur.execute("DELETE FROM agent_templates WHERE id = %s AND is_builtin = FALSE RETURNING id",
                    (template_id,))
        return cur.fetchone() is not None


# Loops (recurring prompts) ---------------------------------------------------
# Moved out of ~/.claude/.viewer-loops.json into Postgres. Per-row CRUD: each
# scheduler edit touches ONE loop, so nothing rewrites the whole set. Rows come
# back in the historical JSON shape (camelCase keys like nextRun) so the routes
# and clients are unchanged.

# JSON key -> SQL column -> default. Explicit (not **row) so a stray client key
# can't inject a column and the name mapping lives in exactly one place.
_LOOP_COLS = (
    ("session", "session", ""), ("path", "path", ""), ("prompt", "prompt", ""),
    ("interval", "interval_sec", 0), ("cron", "cron", None),
    ("nextRun", "next_run", 0), ("runs", "runs", 0), ("lastRun", "last_run", None),
    ("lastRc", "last_rc", None), ("created", "created", 0), ("model", "model", ""),
    ("provider", "provider", ""),
    ("enabled", "enabled", True), ("origin", "origin", "user"),
    ("kind", "kind", "recurring"),
)


def _loop_row(r):
    """A DB row -> the historical loop dict shape (without the id, which callers
    attach as needed)."""
    return {jk: r[col] for jk, col, _ in _LOOP_COLS}


def loop_list(session=None):
    """All loops (optionally only those for one session) as {id: {...}}, ordered
    by creation so the UI list is stable."""
    with _db() as cur:
        if session:
            cur.execute("SELECT * FROM loops WHERE session = %s ORDER BY created", (session,))
        else:
            cur.execute("SELECT * FROM loops ORDER BY created")
        return {r["id"]: _loop_row(r) for r in cur.fetchall()}


def loop_get(lid):
    with _db() as cur:
        cur.execute("SELECT * FROM loops WHERE id = %s", (lid,))
        row = cur.fetchone()
    return _loop_row(row) if row else None


def loop_upsert(lid, entry):
    """Create or fully replace one loop from an entry dict (historical JSON keys).
    Missing keys fall back to their column default."""
    cols = [col for _, col, _ in _LOOP_COLS]
    vals = [entry.get(jk, dflt) for jk, _, dflt in _LOOP_COLS]
    setclause = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)
    with _db() as cur:
        cur.execute(
            f"INSERT INTO loops (id, {', '.join(cols)}) "
            f"VALUES (%s, {', '.join(['%s'] * len(cols))}) "
            f"ON CONFLICT (id) DO UPDATE SET {setclause}",
            (lid, *vals),
        )


def loop_update(lid, fields):
    """Patch only the given JSON keys of one loop. Returns the updated row (or None
    if the id is gone). Used by the scheduler's per-tick nextRun/runs bumps and the
    edit-loop route, so a concurrent edit to a different field isn't clobbered."""
    jk_to_col = {jk: col for jk, col, _ in _LOOP_COLS}
    sets, vals = [], []
    for jk, v in fields.items():
        col = jk_to_col.get(jk)
        if col:
            sets.append(f"{col} = %s")
            vals.append(v)
    if not sets:
        return loop_get(lid)
    with _db() as cur:
        cur.execute(f"UPDATE loops SET {', '.join(sets)} WHERE id = %s RETURNING *",
                    (*vals, lid))
        row = cur.fetchone()
    return _loop_row(row) if row else None


def loop_delete(lid):
    with _db() as cur:
        cur.execute("DELETE FROM loops WHERE id = %s RETURNING id", (lid,))
        return cur.fetchone() is not None


def loop_delete_for_session(session):
    """Drop every loop tied to a session (called when the session is deleted).
    Returns how many were removed."""
    with _db() as cur:
        cur.execute("DELETE FROM loops WHERE session = %s RETURNING id", (session,))
        return len(cur.fetchall())


def loops_due(now, origins=None):
    """Enabled loops whose nextRun has arrived, each as a dict with its id — the
    scheduler's read side. Ordered by nextRun so the earliest-due fire first.

    `origins` gates by WHO scheduled the loop (see the loop_control setting and
    loops.allowed_origins): a collection of allowed origin strings restricts the
    result to those; None means no origin filter (every origin). An EMPTY
    collection returns nothing — 'none' mode fires no loops at all."""
    with _db() as cur:
        if origins is None:
            cur.execute(
                "SELECT * FROM loops WHERE enabled = TRUE AND next_run <= %s "
                "ORDER BY next_run", (now,))
        else:
            cur.execute(
                "SELECT * FROM loops WHERE enabled = TRUE AND next_run <= %s "
                "AND origin = ANY(%s) ORDER BY next_run", (now, list(origins)))
        return [dict(_loop_row(r), id=r["id"]) for r in cur.fetchall()]


def loops_disable_for_employee(provider_id):
    """Disable every loop whose session runs AS a given employee, identified by
    that employee's provider preset id (the session↔employee link, see
    engine._resolve_employee). Called when an agent is fired/deactivated so its
    scheduled work stops. enabled=FALSE (not delete) — reversible on rehire, and
    the schedules + their history are preserved. Returns how many were disabled.

    A blank provider_id matches nothing: an employee with no provider link owns no
    agent sessions, so firing them must not disable UNrelated loops."""
    if not provider_id:
        return 0
    with _db() as cur:
        cur.execute(
            "UPDATE loops SET enabled = FALSE WHERE enabled = TRUE AND session IN "
            "(SELECT session_id FROM session_meta WHERE data->>'provider' = %s) "
            "RETURNING id",
            (provider_id,))
        return len(cur.fetchall())


# Job runs (append-only history) ----------------------------------------------
# One row per loop firing. Distinct from `loops` (the schedule definition): a
# schedule is one row that fires forever; each firing is one job_runs row. This
# is the audit trail — retention-bounded, never unbounded.

def job_run_start(loop_id, session_id, prompt):
    """Record that a loop just fired. Returns the new run's id, which the caller
    hands to job_run_finish when the run completes. Best-effort at the call site:
    a failure to log history must never stop the actual run."""
    with _db() as cur:
        cur.execute(
            "INSERT INTO job_runs (loop_id, session_id, prompt, status, started_at) "
            "VALUES (%s, %s, %s, 'running', %s) RETURNING id",
            (loop_id, session_id, prompt, _now()))
        return cur.fetchone()["id"]


def job_run_finish(run_id, rc, detail=""):
    """Finalize a run row: status from the return code (ok/error), rc, a bounded
    detail (stderr tail), and the finish time."""
    if run_id is None:
        return
    status = "ok" if rc == 0 else "error"
    with _db() as cur:
        cur.execute(
            "UPDATE job_runs SET status = %s, rc = %s, detail = %s, finished_at = %s "
            "WHERE id = %s",
            (status, rc, (detail or "")[:2000], _now(), run_id))


def job_runs_list(loop_id, limit=100):
    """A loop's run history, newest first (the audit view for one schedule)."""
    with _db() as cur:
        cur.execute(
            "SELECT id, loop_id, session_id, prompt, status, rc, detail, started_at, "
            "finished_at FROM job_runs WHERE loop_id = %s ORDER BY started_at DESC LIMIT %s",
            (loop_id, limit))
        return [dict(r) for r in cur.fetchall()]


def job_runs_purge(max_age_days, max_per_loop):
    """Enforce the retention policy on job_runs so history can't overflow. Two
    independent caps, whichever removes a row first:
      • age: drop runs finished more than max_age_days ago (tidiness).
      • count: keep only the newest max_per_loop runs per loop (the real overflow
        guard — a 30s loop is ~2,880 runs/day, so age alone wouldn't bound it).
    Detached runs (loop_id NULL, from a deleted schedule) are aged out by the age
    cap only — they have no loop to count against. Returns the rows removed."""
    removed = 0
    with _db() as cur:
        if max_age_days and max_age_days > 0:
            cutoff = _now() - float(max_age_days) * 86400
            # started_at is always set; finished_at may be NULL for a wedged run,
            # so age off the start time (a run older than the window is stale
            # regardless of whether it recorded a finish).
            cur.execute("DELETE FROM job_runs WHERE started_at < %s RETURNING id", (cutoff,))
            removed += len(cur.fetchall())
        if max_per_loop and max_per_loop > 0:
            # Per loop, rank newest-first and delete beyond the cap. Only non-NULL
            # loop_ids: detached runs aren't grouped under a live schedule.
            cur.execute(
                "DELETE FROM job_runs WHERE id IN ("
                "  SELECT id FROM ("
                "    SELECT id, row_number() OVER "
                "      (PARTITION BY loop_id ORDER BY started_at DESC) AS rn"
                "    FROM job_runs WHERE loop_id IS NOT NULL"
                "  ) ranked WHERE rn > %s) RETURNING id",
                (max_per_loop,))
            removed += len(cur.fetchall())
    return removed


# Session meta ----------------------------------------------------------------
# Per-session extras (title/goal/systemPrompt/provider/convMode/effort/favorite/
# pinned/avatar/archived). Moved out of ~/.claude/.viewer-meta.json. The payload
# is JSONB so keys the app adds later survive without a schema change. Per-row
# CRUD with a JSONB merge for patches, so two concurrent field edits on the same
# session don't clobber each other.

def session_meta_get(sid):
    """One session's meta dict (empty dict if none)."""
    with _db() as cur:
        cur.execute("SELECT data FROM session_meta WHERE session_id = %s", (sid,))
        row = cur.fetchone()
    return (row["data"] or {}) if row else {}


def session_meta_all():
    """All session meta as {session_id: {...}} — for the list overlay and the
    apply-provider-to-all route."""
    with _db() as cur:
        cur.execute("SELECT session_id, data FROM session_meta")
        return {r["session_id"]: (r["data"] or {}) for r in cur.fetchall()}


def session_meta_patch(sid, fields):
    """Merge `fields` into one session's meta (JSONB concat, so untouched keys
    survive a concurrent writer) and return the full merged dict. `fields` values
    of None are stored as-is; callers that mean 'remove' should handle that
    explicitly — no current caller does."""
    with _db() as cur:
        cur.execute(
            "INSERT INTO session_meta (session_id, data, updated_at) VALUES (%s, %s, %s) "
            "ON CONFLICT (session_id) DO UPDATE SET data = session_meta.data || EXCLUDED.data, "
            "updated_at = EXCLUDED.updated_at RETURNING data",
            (sid, Json(fields), _now()),
        )
        return cur.fetchone()["data"]


def session_meta_set(sid, data):
    """Replace one session's meta wholesale (used where the caller builds the full
    dict, e.g. a fresh spawn)."""
    with _db() as cur:
        cur.execute(
            "INSERT INTO session_meta (session_id, data, updated_at) VALUES (%s, %s, %s) "
            "ON CONFLICT (session_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at",
            (sid, Json(data or {}), _now()),
        )


def session_meta_delete(sid):
    with _db() as cur:
        cur.execute("DELETE FROM session_meta WHERE session_id = %s RETURNING session_id", (sid,))
        return cur.fetchone() is not None


def session_meta_set_provider_all(pid):
    """Set the provider on EVERY session's meta (the apply-default route). Returns
    how many rows were touched. A row with no `provider` key yet gets one."""
    with _db() as cur:
        cur.execute(
            "UPDATE session_meta SET data = data || %s, updated_at = %s RETURNING session_id",
            (Json({"provider": pid}), _now()),
        )
        return len(cur.fetchall())


def session_personas():
    """{session_id: {id, name, role, avatar}} for every session whose token is
    linked to an employee — the join that fuses the org roster to the running
    fleet. One query for the whole list (the third overlay batch-fetcher next to
    `session_meta_all`/`session_seen_get`), so the list handler answers 'which
    persona is driving this session' without a query per row. Sessions with no
    `employee_id` are simply absent, so the overlay leaves them personaless."""
    with _db() as cur:
        cur.execute(
            "SELECT st.session_id, e.id, e.name, e.role, e.avatar "
            "FROM session_tokens st JOIN employees e ON e.id = st.employee_id "
            "WHERE st.employee_id IS NOT NULL"
        )
        return {
            r["session_id"]: {"id": r["id"], "name": r["name"],
                              "role": r["role"], "avatar": r["avatar"]}
            for r in cur.fetchall()
        }


# Per-reader unread cursors ---------------------------------------------------
# One row per (reader, session): when that reader last OPENED the session. Unread
# is derived, never stored: a session is unread for a reader when its transcript
# changed after the reader's cursor. Kept server-side so web, mobile and an agent
# over MCP all agree, unlike the old per-device seen-map this replaced.

def session_seen_get(reader):
    """{session_id: last_seen_epoch} for one reader — empty when they've opened
    nothing. The list handler joins this against each session's mtime to flag
    unread, so it's a single fetch per list request, not one query per session."""
    with _db() as cur:
        cur.execute("SELECT session, last_seen FROM session_seen WHERE reader = %s", (reader,))
        return {r["session"]: r["last_seen"] for r in cur.fetchall()}


def session_seen_set(reader, session, ts=None):
    """Advance a reader's cursor on one session to `ts` (default now). Idempotent
    upsert; a later open always moves the cursor forward, never back."""
    with _db() as cur:
        cur.execute(
            "INSERT INTO session_seen (reader, session, last_seen) VALUES (%s, %s, %s) "
            "ON CONFLICT (reader, session) DO UPDATE SET last_seen = EXCLUDED.last_seen",
            (reader, session, ts if ts is not None else _now()),
        )


# Hosts (SSH registry) --------------------------------------------------------
# The hosts store keeps the same {id: {label, host, user, port, claudeHome,
# password, keyFile, keyPassphrase}} shape the config file had, so remote.py /
# routes/auth.py read it unchanged. Secrets live in these columns; the list
# route already strips them before returning to a client. `user` is a reserved
# word in Postgres, so it's double-quoted wherever it's named in DDL/DML.
_HOST_COLS = (
    ("label", "label", ""), ("host", "host", ""), ("user", '"user"', ""),
    ("port", "port", 22), ("claudeHome", "claude_home", ".claude"),
    ("password", "password", ""), ("keyFile", "key_file", ""),
    ("keyPassphrase", "key_passphrase", ""),
)


def hosts_load():
    with _db() as cur:
        cur.execute("SELECT * FROM hosts")
        # The `user` column comes back under its plain name in the row dict.
        cols_by_json = {jk: (col.strip('"')) for jk, col, _ in _HOST_COLS}
        out = {}
        for r in cur.fetchall():
            out[r["id"]] = {jk: r[col] for jk, col in cols_by_json.items()}
    return out


def host_upsert(hid, entry):
    cols = [col for _, col, _ in _HOST_COLS]  # already quoted where needed
    vals = [entry.get(jk, dflt) for jk, _, dflt in _HOST_COLS]
    setclause = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)
    with _db() as cur:
        cur.execute(
            f"INSERT INTO hosts (id, {', '.join(cols)}, created_at) "
            f"VALUES (%s, {', '.join(['%s'] * len(cols))}, %s) "
            f"ON CONFLICT (id) DO UPDATE SET {setclause}",
            (hid, *vals, _now()),
        )


def host_delete(hid):
    with _db() as cur:
        cur.execute("DELETE FROM hosts WHERE id = %s RETURNING id", (hid,))
        return cur.fetchone() is not None


# Per-host env vars -----------------------------------------------------------

def host_env_load(hid):
    """The {KEY: VALUE} map for a host id."""
    with _db() as cur:
        cur.execute("SELECT key, value FROM host_env WHERE host = %s", (hid,))
        return {r["key"]: r["value"] for r in cur.fetchall()}


def host_env_set(hid, key, value):
    with _db() as cur:
        cur.execute(
            "INSERT INTO host_env (host, key, value) VALUES (%s, %s, %s) "
            "ON CONFLICT (host, key) DO UPDATE SET value = EXCLUDED.value",
            (hid, key, str(value)),
        )


def host_env_unset(hid, key):
    with _db() as cur:
        cur.execute("DELETE FROM host_env WHERE host = %s AND key = %s", (hid, key))


def host_env_unset_all(hid):
    with _db() as cur:
        cur.execute("DELETE FROM host_env WHERE host = %s", (hid,))


# Provider presets ------------------------------------------------------------
# Same {id: {name, baseUrl, model, apiKey, contextLimit, isDefault}} shape the
# providers file held, so providers.py's public API is untouched.
_PROVIDER_COLS = (
    ("name", "name", ""), ("baseUrl", "base_url", ""), ("model", "model", ""),
    ("apiKey", "api_key", ""), ("contextLimit", "context_limit", 0),
    ("isDefault", "is_default", False),
)


def providers_load():
    with _db() as cur:
        cur.execute("SELECT * FROM providers")
        out = {}
        for r in cur.fetchall():
            out[r["id"]] = {jk: r[col] for jk, col, _ in _PROVIDER_COLS}
    return out


def provider_upsert(pid, rec):
    cols = [col for _, col, _ in _PROVIDER_COLS]
    vals = [rec.get(jk, dflt) for jk, _, dflt in _PROVIDER_COLS]
    setclause = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)
    with _db() as cur:
        # At most one default: clearing others and the upsert must be one
        # transaction, else a crash between them could leave two defaults.
        if rec.get("isDefault"):
            cur.execute("UPDATE providers SET is_default = FALSE WHERE id <> %s", (pid,))
        cur.execute(
            f"INSERT INTO providers (id, {', '.join(cols)}, created_at) "
            f"VALUES (%s, {', '.join(['%s'] * len(cols))}, %s) "
            f"ON CONFLICT (id) DO UPDATE SET {setclause}",
            (pid, *vals, _now()),
        )


def provider_delete(pid):
    with _db() as cur:
        cur.execute("DELETE FROM providers WHERE id = %s RETURNING id", (pid,))
        return cur.fetchone() is not None


# Settings (singleton key/value) ----------------------------------------------

def setting_get(key, default=None):
    with _db() as cur:
        cur.execute("SELECT value FROM settings WHERE key = %s", (key,))
        row = cur.fetchone()
    return row["value"] if row else default


def setting_set(key, value):
    with _db() as cur:
        cur.execute(
            "INSERT INTO settings (key, value) VALUES (%s, %s) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            (key, Json(value)),
        )


# Retention policy. Reads from settings so a SaaS-admin portal can tune the caps
# per plan/license without a deploy; falls back to the seeded defaults when the
# row is missing or a value is malformed (never returns junk the purge can't use).
_RETENTION_DEFAULTS = {"job_runs_days": 90, "job_runs_per_loop": 500}


def retention_config():
    cfg = setting_get("retention", {}) or {}
    out = {}
    for k, dflt in _RETENTION_DEFAULTS.items():
        try:
            out[k] = int(cfg.get(k, dflt))
        except (TypeError, ValueError):
            out[k] = dflt
    return out


# One-time backfill -----------------------------------------------------------

# The legacy files. After a successful backfill each is moved aside (not deleted)
# so a first Postgres run is reversible and nothing is lost if the migration is
# wrong. Keyed name -> (path, migrate_fn).
_LEGACY_DIR = Path.home() / ".claude"
_TRASH_DIR = _LEGACY_DIR / ".viewer-migrated"


def _read_json(path):
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def _table_empty(table):
    with _db() as cur:
        cur.execute(f"SELECT 1 FROM {table} LIMIT 1")
        return cur.fetchone() is None


def migrate_legacy_files():
    """Backfill the six ~/.claude/*.json stores into Postgres ONCE, then move each
    file into ~/.claude/.viewer-migrated/ so the old second-source is gone but
    recoverable. Idempotent: a file already moved (or absent) is skipped, and each
    table is only seeded when EMPTY so a later user edit is never clobbered by a
    stale file that somehow reappears."""
    _TRASH_DIR.mkdir(parents=True, exist_ok=True)

    def _retire(path):
        try:
            path.replace(_TRASH_DIR / path.name)
        except Exception:
            pass

    # loops
    p = _LEGACY_DIR / ".viewer-loops.json"
    data = _read_json(p)
    if data is not None:
        if _table_empty("loops"):
            for lid, entry in data.items():
                loop_upsert(lid, entry)
        _retire(p)

    # session meta
    p = _LEGACY_DIR / ".viewer-meta.json"
    data = _read_json(p)
    if data is not None:
        if _table_empty("session_meta"):
            for sid, meta in data.items():
                session_meta_set(sid, meta)
        _retire(p)

    # hosts
    p = _LEGACY_DIR / ".viewer-hosts.json"
    data = _read_json(p)
    if data is not None:
        if _table_empty("hosts"):
            for hid, entry in data.items():
                host_upsert(hid, entry)
        _retire(p)

    # per-host env
    p = _LEGACY_DIR / ".viewer-env.json"
    data = _read_json(p)
    if data is not None:
        if _table_empty("host_env"):
            for hid, kv in (data or {}).items():
                for k, v in (kv or {}).items():
                    host_env_set(hid, k, v)
        _retire(p)

    # providers
    p = _LEGACY_DIR / ".viewer-providers.json"
    data = _read_json(p)
    if data is not None:
        if _table_empty("providers"):
            for pid, rec in data.items():
                provider_upsert(pid, rec)
        _retire(p)

    # harman config -> settings['harman']
    p = _LEGACY_DIR / ".viewer-harman.json"
    data = _read_json(p)
    if data is not None:
        # Seed only if the row is still the untouched default (no automation flip
        # since install). setting_get returns the seeded default on a fresh DB.
        cur_cfg = setting_get("harman", {}) or {}
        if not cur_cfg.get("automation_enabled"):
            merged = dict(cur_cfg)
            merged.update(data)
            setting_set("harman", merged)
        _retire(p)
