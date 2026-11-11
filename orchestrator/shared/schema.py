"""Schema creation, versioned migrations, live-change triggers and the one-time legacy JSON backfill."""
import json
import time
from pathlib import Path

from orchestrator import config
from orchestrator.board.loops_repository import loop_upsert
from orchestrator.board.repository import board_columns_ensure, project_list
from orchestrator.integrations.repository import drive_client_set, drive_clients_load
from orchestrator.runtime.repository import _seed_agent_templates, host_env_set, host_upsert, provider_upsert, session_meta_set
from orchestrator.shared import postgres
from orchestrator.shared import settings


# Harman's DB schema generation. The big CREATE/ALTER block in init_db() is
# additive-idempotent, so additive changes (new table, new nullable column) need
# NO bump here — they self-heal on every boot. Bump this ONLY when an ORDERED or
# destructive step is added to _run_migrations() below. The stamp lives in the
# settings table (app_meta), so there is no separate schema_version table.
SCHEMA_VERSION = 6


def _run_migrations(prev):
    """Ordered / non-additive schema steps, run after the additive DDL in
    init_db(). `prev` is the schema_version the DB was last stamped with (0 on a
    fresh install). Each step is guarded `if prev < N:`, applied in order, and
    written IF EXISTS so a fresh install (which never had the old shape) is a
    no-op."""
    if prev < 2:
        # The Employees roster is retired: a session's authority now comes from
        # its agent role (agent_templates.level) or the owner's per-chat
        # override (session_meta.level) — see engine.resolve_level. Drop the
        # roster and every column that pointed at it.
        with postgres.cursor() as cur:
            cur.execute("""
                ALTER TABLE cards DROP COLUMN IF EXISTS assignee;
                ALTER TABLE skills_learned DROP COLUMN IF EXISTS origin_employee;
                ALTER TABLE session_tokens DROP COLUMN IF EXISTS employee_id;
                DO $$ BEGIN
                  IF EXISTS (SELECT 1 FROM information_schema.columns
                             WHERE table_name = 'session_tokens' AND column_name = 'employee_level')
                  THEN ALTER TABLE session_tokens RENAME COLUMN employee_level TO level;
                  END IF;
                END $$;
                DROP TABLE IF EXISTS employees;
                -- The manager tick's knobs (enabled/interval/budget/projects/
                -- default_provider) went with it; keep only the master switch.
                UPDATE settings SET value = jsonb_build_object(
                    'automation_enabled', COALESCE((value->>'automation_enabled')::boolean, false))
                  WHERE key = 'harman';
            """)
    if prev < 3:
        # An agent template held ONE job (cron + job_prompt columns); it now
        # holds a list (agent_templates.jobs). Carry a user template's job
        # over, then drop the pair. Builtins are re-seeded from code anyway.
        with postgres.cursor() as cur:
            cur.execute("""
                DO $$ BEGIN
                  IF EXISTS (SELECT 1 FROM information_schema.columns
                             WHERE table_name = 'agent_templates' AND column_name = 'job_prompt')
                  THEN
                    UPDATE agent_templates
                       SET jobs = jsonb_build_array(jsonb_build_object('prompt', job_prompt, 'cron', cron))
                     WHERE cron IS NOT NULL AND job_prompt IS NOT NULL AND jobs = '[]'::jsonb;
                    ALTER TABLE agent_templates DROP COLUMN cron, DROP COLUMN job_prompt;
                  END IF;
                END $$;
            """)
    if prev < 4:
        # An agent named a Claude alias (agent_templates.model: sonnet/opus/...);
        # it now holds a whole AI selection (agent_templates.ai: provider + model
        # + mode + effort, the shape orchestrator/ai.py validates), so an agent can run
        # on any of the owner's providers. A user agent's alias becomes the
        # built-in provider with that model; builtins keep NULL (= the owner's
        # defaults), because pinning Claude would override a custom-provider default.
        with postgres.cursor() as cur:
            cur.execute("""
                DO $$ BEGIN
                  IF EXISTS (SELECT 1 FROM information_schema.columns
                             WHERE table_name = 'agent_templates' AND column_name = 'model')
                  THEN
                    UPDATE agent_templates
                       SET ai = jsonb_build_object('provider', '', 'convMode', 'agent', 'effort', '',
                                                   'model', jsonb_build_object('kind', 'id', 'id', model))
                     WHERE NOT is_builtin AND model <> '' AND ai IS NULL;
                    ALTER TABLE agent_templates DROP COLUMN model;
                  END IF;
                END $$;
            """)
    if prev < 5:
        # Agents never marked their mail read before listing did it (inbox
        # mark-read-on-list), so every session carried its whole history as
        # unread and a wake could re-act on a week-old "go". That mail was
        # delivered by the wake it came with; mark it read. The last day stays
        # unread in case a session has not listed since.
        with postgres.cursor() as cur:
            cur.execute("UPDATE inbox_messages SET status = 'read', updated_at = %s "
                        "WHERE recipient_type = 'session' AND status = 'sent' "
                        "AND created_at < %s", (postgres.now(), postgres.now() - 86400))
    if prev < 6:
        # One row per skill name. Re-promoting a skill used to INSERT a new row
        # each time (8 rows for one skill). Collapse duplicates onto the FIRST
        # row (it holds the original provenance), keeping 'active' if any
        # duplicate was active, then let the unique index enforce it —
        # ops.repository.skill_learned_record upserts ON CONFLICT (name).
        with postgres.cursor() as cur:
            cur.execute("""
                UPDATE skills_learned k SET status = 'active'
                 WHERE k.status <> 'active' AND EXISTS (
                   SELECT 1 FROM skills_learned d
                    WHERE d.name = k.name AND d.id > k.id AND d.status = 'active');
                DELETE FROM skills_learned a USING skills_learned b
                 WHERE a.name = b.name AND a.id > b.id;
                CREATE UNIQUE INDEX IF NOT EXISTS skills_learned_name ON skills_learned(name);
            """)


def init_db():
    with postgres.cursor() as cur:
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
              created_at DOUBLE PRECISION NOT NULL,
              app_version TEXT,
              app_build   TEXT
            );
            CREATE TABLE IF NOT EXISTS pending_questions (
              session_id  TEXT PRIMARY KEY,
              tool_use_id TEXT NOT NULL,
              questions   JSONB NOT NULL,
              status      TEXT NOT NULL DEFAULT 'open',
              host        TEXT NOT NULL DEFAULT 'local',
              run_id      TEXT NOT NULL DEFAULT '',
              revision    INTEGER NOT NULL DEFAULT 1,
              created_at  DOUBLE PRECISION NOT NULL
            );
            -- Turns in flight, so a server restart or a run that dies mid-turn
            -- pauses them instead of dropping them: boot resumes every row left
            -- behind, and the run finalizer resumes its own (orchestrator/resume.py).
            -- Written when a run of any harness starts, kept in step with its
            -- message queue, deleted when the run ends. `agent` is the harness
            -- (claude, custom, codex, copilot, pi); `ref` is what that harness
            -- needs to resume beyond the session id (e.g. Codex's own id).
            CREATE TABLE IF NOT EXISTS inflight_runs (
              session_id TEXT PRIMARY KEY,
              host       TEXT NOT NULL DEFAULT 'local',
              cwd        TEXT NOT NULL DEFAULT '',
              mode       TEXT NOT NULL DEFAULT '',
              model      TEXT NOT NULL DEFAULT '',
              queue      JSONB NOT NULL DEFAULT '[]',
              resumes    INTEGER NOT NULL DEFAULT 0,
              started_at DOUBLE PRECISION NOT NULL
            );
            CREATE TABLE IF NOT EXISTS session_tokens (
              session_id     TEXT PRIMARY KEY,
              perm_token     TEXT NOT NULL DEFAULT '',
              kanban_token   TEXT NOT NULL DEFAULT '',
              level          TEXT NOT NULL DEFAULT 'ic',
              cwd            TEXT NOT NULL DEFAULT '',
              host           TEXT NOT NULL DEFAULT 'local',
              created_at     DOUBLE PRECISION NOT NULL
            );
            ALTER TABLE inflight_runs ADD COLUMN IF NOT EXISTS agent TEXT NOT NULL DEFAULT 'claude';
            ALTER TABLE inflight_runs ADD COLUMN IF NOT EXISTS ref JSONB NOT NULL DEFAULT '{}';
            ALTER TABLE pending_questions ADD COLUMN IF NOT EXISTS host TEXT NOT NULL DEFAULT 'local';
            ALTER TABLE pending_questions ADD COLUMN IF NOT EXISTS run_id TEXT NOT NULL DEFAULT '';
            ALTER TABLE pending_questions ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'viewer';
            -- What app a device runs, reported by the client on push-register.
            -- NULL = a build from before this column (we simply can't see it).
            ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS app_version TEXT;
            ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS app_build TEXT;
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
            -- / project / CEO "board" is a filtered VIEW of it. See
            -- ORCHESTRATOR_KANBAN.md + orchestrator/orglogic.py.
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
            -- (user:<name> / session:<label>) — no FK, because an
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
            -- Notes: the org's knowledge ledger, next to cards (its work ledger).
            -- A note is markdown owned by whoever wrote it (`created_by` is the
            -- same principal string audit_log carries), scoped like a card: to a
            -- project and/or the chat session it was written in. `kind` is the
            -- note's template (note / journal / meeting / ...); `archived`
            -- follows the owning session's archive flag (routes/sessions) and a
            -- deleted session takes its notes with it.
            CREATE TABLE IF NOT EXISTS notes (
              id         SERIAL PRIMARY KEY,
              title      TEXT NOT NULL DEFAULT '',
              body       TEXT NOT NULL DEFAULT '',
              kind       TEXT NOT NULL DEFAULT 'note',
              project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
              session_id TEXT,
              pinned     BOOLEAN NOT NULL DEFAULT FALSE,
              archived   BOOLEAN NOT NULL DEFAULT FALSE,
              created_by TEXT NOT NULL DEFAULT '',
              created_at DOUBLE PRECISION NOT NULL,
              updated_at DOUBLE PRECISION NOT NULL
            );
            CREATE INDEX IF NOT EXISTS notes_session_idx ON notes(session_id);
            CREATE INDEX IF NOT EXISTS notes_project_idx ON notes(project_id);
            -- The shared project canvas (Excalidraw): one board per project
            -- (or per session for a session scratchpad). Elements are stored
            -- one row each, keyed by the element's own id, so concurrent edits
            -- to different shapes never conflict and a write is an upsert of
            -- the changed rows only (orchestrator/canvas_room flushes them in
            -- batches). `version`/`version_nonce` mirror the element's own
            -- conflict clock (orchestrator/canvas_reconcile). No live trigger: the
            -- canvas has its own socket, and a stroke must not wake every board.
            CREATE TABLE IF NOT EXISTS canvas_boards (
              id         SERIAL PRIMARY KEY,
              owner_kind TEXT NOT NULL,
              owner_id   TEXT NOT NULL,
              title      TEXT NOT NULL DEFAULT '',
              created_at DOUBLE PRECISION NOT NULL,
              updated_at DOUBLE PRECISION NOT NULL,
              UNIQUE (owner_kind, owner_id)
            );
            CREATE TABLE IF NOT EXISTS canvas_elements (
              canvas_id     INTEGER NOT NULL REFERENCES canvas_boards(id) ON DELETE CASCADE,
              element_id    TEXT NOT NULL,
              version       INTEGER NOT NULL,
              version_nonce BIGINT NOT NULL,
              is_deleted    BOOLEAN NOT NULL DEFAULT FALSE,
              data          JSONB NOT NULL,
              updated_by    TEXT NOT NULL DEFAULT '',
              updated_at    DOUBLE PRECISION NOT NULL,
              PRIMARY KEY (canvas_id, element_id)
            );
            -- Images pasted onto a canvas: content-addressed by Excalidraw's
            -- own file id (a hash of the bytes), so a re-upload is a no-op.
            CREATE TABLE IF NOT EXISTS canvas_files (
              canvas_id  INTEGER NOT NULL REFERENCES canvas_boards(id) ON DELETE CASCADE,
              file_id    TEXT NOT NULL,
              mime       TEXT NOT NULL,
              bytes      BYTEA NOT NULL,
              created_by TEXT NOT NULL DEFAULT '',
              created_at DOUBLE PRECISION NOT NULL,
              PRIMARY KEY (canvas_id, file_id)
            );
            -- A note's discussion (the message board): Reddit-style threaded
            -- replies under any note — how agents and the owner talk ABOUT a
            -- piece of knowledge. `parent_id` NULL = top-level comment. `author`
            -- is the resolved principal actor (as on card_comments);
            -- `session_id` is the writing session ('' for a human) — the address
            -- a reply to this comment wakes.
            CREATE TABLE IF NOT EXISTS note_comments (
              id         SERIAL PRIMARY KEY,
              note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
              parent_id  INTEGER REFERENCES note_comments(id) ON DELETE CASCADE,
              author     TEXT NOT NULL DEFAULT '',
              session_id TEXT NOT NULL DEFAULT '',
              body       TEXT NOT NULL,
              created_at DOUBLE PRECISION NOT NULL
            );
            CREATE INDEX IF NOT EXISTS note_comments_note_idx ON note_comments(note_id);
            -- One vote per voter per comment (+1 / -1); the score is their sum.
            -- `voter` is the session id for an agent, the actor for a human.
            CREATE TABLE IF NOT EXISTS note_votes (
              comment_id INTEGER NOT NULL REFERENCES note_comments(id) ON DELETE CASCADE,
              voter      TEXT NOT NULL,
              value      SMALLINT NOT NULL,
              PRIMARY KEY (comment_id, voter)
            );
            -- Inbox: the owner's and the agents' message ledger. A message is
            -- owned by a session (session_id = the chat it was written in or
            -- addressed to) and lives and dies with that chat exactly like a
            -- note: an archived chat shelves its messages, a deleted chat
            -- takes them. `kind` separates free messages from the
            -- auto-delivered decision items — a session's open question, an
            -- open plan, a live tool approval, or a card parked in
            -- Review/Needs-info. A decision message's ref_id points at the
            -- EXISTING durable source (pending_questions/pending_plans/the
            -- approval registry/the card) and its open-vs-resolved state is
            -- DERIVED from that source at read time, never stored here: the
            -- board columns and the per-session answer routes remain the only
            -- decision system, and the inbox is their delivery surface.
            CREATE TABLE IF NOT EXISTS inbox_messages (
              id              SERIAL PRIMARY KEY,
              session_id      TEXT NOT NULL,
              project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
              sender_type     TEXT NOT NULL DEFAULT 'user',
              sender_id       TEXT NOT NULL DEFAULT '',
              recipient_type  TEXT NOT NULL DEFAULT 'user',
              recipient_id    TEXT NOT NULL DEFAULT '',
              body            TEXT NOT NULL DEFAULT '',
              kind            TEXT NOT NULL DEFAULT 'message',
              ref_id          TEXT NOT NULL DEFAULT '',
              in_reply_to     INTEGER NOT NULL DEFAULT 0,
              status          TEXT NOT NULL DEFAULT 'sent',
              snoozed_until   DOUBLE PRECISION NOT NULL DEFAULT 0,
              archived        BOOLEAN NOT NULL DEFAULT FALSE,
              created_at      DOUBLE PRECISION NOT NULL,
              updated_at      DOUBLE PRECISION NOT NULL
            );
            CREATE INDEX IF NOT EXISTS inbox_session_idx ON inbox_messages(session_id);
            CREATE INDEX IF NOT EXISTS inbox_recipient_idx ON inbox_messages(recipient_type, recipient_id);
            CREATE INDEX IF NOT EXISTS inbox_kind_ref_idx ON inbox_messages(kind, ref_id);
            -- A decision item has exactly one durable message: re-delivery of
            -- the same open question/plan/approval/card refreshes that row
            -- (its body carries the newest context) instead of piling up a
            -- second copy. Free messages (ref_id = '') are never deduped.
            CREATE UNIQUE INDEX IF NOT EXISTS inbox_kind_ref_uniq
              ON inbox_messages(kind, ref_id) WHERE ref_id <> '';
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
              is_builtin     BOOLEAN NOT NULL DEFAULT FALSE,
              created_by     TEXT NOT NULL DEFAULT 'system',
              created_at     DOUBLE PRECISION NOT NULL DEFAULT (extract(epoch from now()))
            );
            -- The AI a chat from this agent runs on: an ai.validate selection
            -- {provider, model, convMode, effort}. NULL = the owner's AI defaults.
            ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS ai JSONB;
            -- An agent = persona + an optional Claude Code plugin (a folder under
            -- orchestrator/agent_plugins, passed as --plugin-dir).
            ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS plugin TEXT NOT NULL DEFAULT '';
            -- The Harman authority level (ic < lead < manager) a chat started
            -- from this role acts at on the board (engine.resolve_level).
            ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS level TEXT NOT NULL DEFAULT 'ic';
            -- The scheduled jobs a chat started from this agent begins with:
            -- [{prompt, cron} | {prompt, interval}], the same shape New chat sends.
            ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS jobs JSONB NOT NULL DEFAULT '[]';
            -- The Harman plugins a chat from this agent starts with, saved from a
            -- chat (chatplugins.save_to_template). NULL = just `plugin`. Never
            -- seeded, so the owner's saved setup survives a builtin re-seed.
            ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS plugins JSONB;
            -- A personal agent belongs to the account that made it: only that
            -- account sees, edits or deletes it. NULL = shared with every account
            -- (the builtins, and agents made before agents had owners).
            ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS owner_user_id INTEGER;
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
            -- Epoch of the last board event on a card made by someone OTHER than
            -- the card's own session (a move, comment, edit, dependency), reset
            -- to 0 once that session acts on the card again. The board sweep
            -- wakes on this, not on updated_at: a session's own writes are not
            -- news to it, and waking it on them made it comment "nothing new",
            -- which bumped updated_at, which woke it again next sweep.
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS attention_since DOUBLE PRECISION NOT NULL DEFAULT 0;
            -- The card's open ask (orchestrator.asks, card 235): when an agent raised
            -- it in Review/Needs-info (0 = no open ask) and its optional
            -- deadline (0 = none). Past the deadline the queue drops it and
            -- the scheduler tick tells the asking session.
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS ask_since DOUBLE PRECISION NOT NULL DEFAULT 0;
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS ask_expires_at DOUBLE PRECISION NOT NULL DEFAULT 0;
            -- When the card was parked in a decision column (0 = not parked): the
            -- decision queue's wait clock. Comments never move it, so an agent
            -- rewording its ask or answering the owner's follow-up keeps the
            -- card's place instead of falling behind newer asks. Cards parked
            -- before the column existed take their newest write once.
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS queued_since DOUBLE PRECISION NOT NULL DEFAULT 0;
            UPDATE cards c SET queued_since = coalesce((SELECT max(created_at) FROM card_comments cc
                                                        WHERE cc.card_id = c.id), c.updated_at)
              FROM board_columns bc WHERE bc.id = c.column_id AND c.queued_since = 0
              AND lower(bc.name) IN ('review', 'needs-info');
            -- The sender's own id for the thing an intake card is about (orchestrator.intake
            -- `key`: a membership, a CI run, an alert). A later post on the same
            -- channel with the same key updates that card instead of opening another.
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS intake_key TEXT NOT NULL DEFAULT '';
            CREATE UNIQUE INDEX IF NOT EXISTS cards_intake_key ON cards(created_by, intake_key) WHERE intake_key <> '';
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
            -- Cloud-storage drives: the third leg of the file layer (local /
            -- SSH host / cloud drive). The bytes live on the vendor; this row
            -- holds only the OAuth tokens (`config`) and the plugin lifecycle
            -- (status active|paused, hidden). `kind` selects the adapter in
            -- orchestrator/drives.py — a new vendor is one adapter class + one
            -- registry entry, nothing else.
            CREATE TABLE IF NOT EXISTS drives (
              id         TEXT PRIMARY KEY,
              label      TEXT NOT NULL DEFAULT '',
              kind       TEXT NOT NULL,
              config     JSONB NOT NULL DEFAULT '{}'::jsonb,
              status     TEXT NOT NULL DEFAULT 'active',
              hidden     BOOLEAN NOT NULL DEFAULT FALSE,
              created_at DOUBLE PRECISION NOT NULL
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
            -- Per-model context facts for a connection: {model: {discovered?,
            -- maxOutput?, override?}} (orchestrator.providers.model_rows reads it).
            ALTER TABLE providers ADD COLUMN IF NOT EXISTS model_limits JSONB NOT NULL DEFAULT '{}'::jsonb;
            -- Legacy: the old single per-connection context_limit seeds the
            -- default model's override once (while model_limits is still empty).
            -- It is not zeroed here so a server still running the old code keeps
            -- working until its restart; every new-code write zeroes it instead.
            UPDATE providers SET model_limits = jsonb_build_object(model, jsonb_build_object('override', context_limit))
              WHERE context_limit > 0 AND model <> '' AND model_limits = '{}'::jsonb;
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
              $${"automation_enabled": false}$$::jsonb)
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
            -- (--append-system-prompt in runtime/runners/claude.py). Without it a session sees the raw
            -- mcp__viewer__* tool list but is never told it is a node in the Harman
            -- orchestration system or how the steering rules gate its power. Stored
            -- here (not a code constant) so it is editable at runtime with no deploy;
            -- to_jsonb(...::text) makes it a JSON string without escaping the body.
            -- DO NOTHING so any operator edit always wins over this seed.
            INSERT INTO settings (key, value) VALUES ('system_preamble',
              to_jsonb($preamble$You are one agent session inside the Harman system — a self-hostable multi-agent orchestration layer running on this machine (the "viewer"). It sees every chat session with roles and RBAC, can orchestrate other agent sessions, schedules recurring work, and distills reusable skills. You are not a lone assistant; you are a node in that system and can observe and steer it.

Your tools (mcp__viewer__*): observe — session_list/detail/read/summary/seen, chat_status, host_list, audit_tail, docs_list/read; org — project_list, board_list, card_list, card (one card + its thread), card_comments, card_create/move/update/comment, card_deps/dep_add/dep_remove, task_done; notes — note_list, note, note_create/update/delete, note_comments/note_comment/note_vote (the discussion thread under every note: where sessions and the owner debate knowledge — reply only to add something new, vote to agree); loops — loop_list/create/update/delete, loop_control_get/set; approvals — approval_list; skills — skill_list/read/propose; trust — session_mode_set, session_level_set; inbox — inbox_list, inbox_send; canvas — canvas_show, canvas_read/patch/snapshot.

Authority: your power is the weaker of the human owner's role and this session's level: Own work (key ic: its own cards, notes, messages) < Workspace (lead: also projects, loops, columns) < Organization (manager: also org-wide settings). A session's level comes from the agent it was started from (Agents tab) or the owner's per-chat setting; with neither it runs at Own work, the least authority. To the owner say Own work/Workspace/Organization, never the key ic. You can always observe the whole system; asking for something above your level queues it for the owner's approval (give a reason) instead of failing.

Steering rules: you may create/edit loops for OTHER sessions, never your own. session_mode_set changes another session's permission mode (up to 'bypass' — no tool gating at all): it is Red, so an agent's request queues for the owner, and a session may never set its own (the owner grants trust, a model never requests it of itself). Agent-scheduled (harman) loops fire only when the loop-control mode (user|harman|both|none) licenses that origin AND the automation master switch (harman.automation_enabled) is ON — it defaults OFF, so nothing agent-made runs unattended. Your own (user) scheduled loops follow the loop-control mode alone: the switch never stops work a human explicitly scheduled. Destructive ops (e.g. loop_delete) queue for the owner's approval rather than executing. Board/card writes are scoped to your level.

## The board pipeline (decisions live on the board)
Every project's board is the default pipeline: Todo → Doing → Review → Approved → Declined → Blocked → Needs-info → Done. "Review" is the holding state for work that needs the owner's decision — when you are done but a call is required, move your card to Review and comment with the question. The owner decides by moving the card to Approved or Declined, or by commenting; that move or comment reaches you as a [board-watch] wake. On a wake, read the card and its comments (card_comments) and act: Approved means proceed with that work (move it to Done when it is complete), Declined means stop it. If your work is stuck on a dependency, move the card to Blocked and comment on what is stuck; if you need a fact or a decision from the owner, move it to Needs-info and comment with the question — your comment pushes to the owner. A fresh comment on your card is a message for you — answer on the card. Comment on your card to report status: the owner gets a push when an agent comments. Never decide for the owner: a card in Review waits for their call, and a decision in Approved/Declined is theirs to make, not yours.

## Writing for the owner (every card, comment, push, inbox message and chat line)
The owner reads your words cold — on a phone, hours later, with no memory of your session and often several agents' work interleaved. The recipient has no context beyond the message itself, so write it for a stranger. Never refer to work by a bare number ("card 53", "#82", "the build"): always give the card number AND its title AND a one-line plain-language statement of what that work is, every time you mention it. Every message that needs something from the owner starts with what you need, in one sentence, as a question they can answer with one word or one tap — put context after, never before. If a card is waiting on the owner, its column must say so (Review or Needs-info); a card in Approved or Doing is understood as "the agent is working, nothing is asked of me". Never leave a question for the owner in a column that does not signal it.

## Inbox (the channel — messages both ways)
Every session owns a mailbox (inbox_list / inbox_send): the owner's words, messages from peer sessions, and the decisions you left for the owner. On a wake, read your inbox first: a fresh message is often the reason for the wake. Send to 'user' to reach the owner (they get a push), or to 'session:<id>' to hand work to a peer (it is woken with your text). Every decision you raise (a question, a plan, an approval, or a card parked in Review/Needs-info) is delivered into the owner's inbox automatically — the "Writing for the owner" standard above applies to its body, since that is exactly the text they will judge from. A snoozed or skipped decision is never dropped: it resurfaces on the next tick. The deciding tap itself stays in the chat UI; the inbox is the channel, not a second decision system. The owner sees every mailbox, including messages between sessions — there is no private channel; write accordingly.

## Ask for help early (guessing is the expensive failure)
The owner is a collaborator, not an escalation of last resort. Send to 'user' (or call AskUserQuestion) only when one of these is true: a fact you need exists only in the owner's head (a credential, a preference, a business decision, what "done" means); you have made two attempts at the same problem and are about to try a third; a path forward would spend real money, touch shared infrastructure, or is hard to reverse; or two reasonable interpretations of the task lead to different work. One message, one question, answerable in a tap — then keep working on whatever does not depend on the answer; never stall the whole task on it and never sit silent. Guessing at the owner's intent and discovering the miss an hour later costs far more than the question. Peers are the other half of collaboration: before you rebuild something, ask the session that owns it (session_list / inbox_send to 'session:<id>') — it has the context you lack, and a handoff to the right owner beats a parallel implementation. Asking is not weakness; a session that asks well is the one the owner trusts with more.

## Decisions you raise (native tools, delivered by the system)
Questions you can answer yourself are your own thinking: answer them and keep working — never end a reply on "Should I…?" or "Want me to…?" for work the task already covers, and never offer a menu of options you could pick between. Call Claude's built-in AskUserQuestion ONLY when you are genuinely blocked on something only the owner can decide (a credential, money, a delete, a business choice, two readings that lead to different work); a fact the owner merely needs to know goes in your reply as a statement, not a question. Proposing a plan for sign-off is ExitPlanMode; a gated tool call raises an approval. All three persist when your run ends, land in the owner's inbox as decisions with full context, and resume your session with the answer — never build a second ask path (no polling, no "did you see my question" messages). Write the question or plan body to the "Writing for the owner" standard: it is the only text the owner will judge from.

## The owner's attention (a decision is expensive)
Every decision costs the owner real energy. The work was delegated so the owner does not have to do it; an agent that returns with question after question has handed it back. The owner sees only a few decisions at a time (they set the number, default 3); asks beyond it are held, with no push and no badge, until a slot frees. So each ask must move the goal forward a lot. Before raising one: decide anything that has a sensible default yourself and state the choice in your report; fold every open question for the same work into the one ask already on that card, each with your recommended answer; and check inbox_list's owner_queue — when held is above 0 the queue is full, so keep working and only add an ask that truly blocks you. Clean up after yourself: move finished work to Done, and pull a stale or superseded ask out of Review or Needs-info (with a comment saying why) the moment it no longer needs the owner.

Full design: docs_read ORCHESTRATOR_MCP.md (§8A is the shipped tool list); docs_read system-status shows this machine's live posture (automation switch, loop mode, this preamble).

## Work discipline (board = the durable ledger, notes = the durable knowledge)
In-conversation todos are scratch for the current task only. Work that outlives this conversation — parked or deferred items, follow-ups, work handed to another session — becomes a board card via card_create before the session ends. When asked what work is pending, answer from the board (card_list), not from memory. If your card cannot move until another card is done, record that with card_dep_add instead of waiting silently — the owner sees the same edge. Knowledge that outlives the conversation — research, a decision and why it was taken, meeting notes — goes in a note (note_create), not in chat text; read note_list before researching what a peer may already have written. A repeatable PROCEDURE a teammate could follow (how to deploy X, how to diagnose Y) is a skill, not a note: skill_list shows what the team already knows (each skill is invocable as /<name>), skill_read gives the full text, and skill_propose adds what you learned so every session inherits it. The owner sees the same board and notes; nothing should live only in a session's head.$preamble$::text))
              ON CONFLICT (key) DO NOTHING;
            -- The Employees roster retired (authority = agent role / per-chat
            -- level): rewrite those lines in an installed preamble. Each replace
            -- is a no-op when its old text is absent (an operator rewrite).
            UPDATE settings SET value = to_jsonb(replace(value #>> '{}',
                $o$org — employee_list, project_list,$o$, $n$org — project_list,$n$))
              WHERE key = 'system_preamble' AND position($o$org — employee_list, project_list,$o$ in value #>> '{}') > 0;
            UPDATE settings SET value = to_jsonb(replace(value #>> '{}',
                $o$card_create/move/assign/update/comment$o$, $n$card_create/move/update/comment$n$))
              WHERE key = 'system_preamble' AND position($o$card_create/move/assign/update/comment$o$ in value #>> '{}') > 0;
            UPDATE settings SET value = to_jsonb(replace(value #>> '{}',
                $o$trust — session_mode_set;$o$, $n$trust — session_mode_set, session_level_set;$n$))
              WHERE key = 'system_preamble' AND position($o$trust — session_mode_set;$o$ in value #>> '{}') > 0;
            UPDATE settings SET value = to_jsonb(replace(value #>> '{}',
                $o$A session not linked to an employee still authenticates — at ic, the least authority: you can observe the whole system, but most writes are gated and will queue for the owner's approval or be refused.$o$, $n$A session's level comes from its agent role (Agents tab) or the owner's per-chat setting; with neither it runs at ic, the least authority. You can always observe the whole system; asking for something above your level queues it for the owner's approval (give a reason) instead of failing.$n$))
              WHERE key = 'system_preamble' AND position($o$A session not linked to an employee still authenticates — at ic, the least authority: you can observe the whole system, but most writes are gated and will queue for the owner's approval or be refused.$o$ in value #>> '{}') > 0;
            -- "ic" is an internal key, not words a person knows: name the levels.
            UPDATE settings SET value = to_jsonb(replace(value #>> '{}',
                $o$this session's level (ic < lead < manager). A session's level comes from its agent role (Agents tab) or the owner's per-chat setting; with neither it runs at ic, the least authority.$o$, $n$this session's level: Worker (key ic: its own cards, notes, messages) < Lead (lead: also projects, loops, columns) < Manager (manager: also org settings). A session's level comes from its agent role (Agents tab) or the owner's per-chat setting; with neither it runs as a Worker, the least authority. To the owner say Worker/Lead/Manager, never the key ic.$n$))
              WHERE key = 'system_preamble' AND position($o$this session's level (ic < lead < manager).$o$ in value #>> '{}') > 0;
            -- Levels renamed by REACH, not job title (so they can't be confused
            -- with an agent like "Product Manager"): Worker→Own work, Lead→
            -- Workspace, Manager→Organization. Rewrite the whole level clause in
            -- one replace; a no-op once converged or on an operator rewrite.
            UPDATE settings SET value = to_jsonb(replace(value #>> '{}',
                $o$this session's level: Worker (key ic: its own cards, notes, messages) < Lead (lead: also projects, loops, columns) < Manager (manager: also org settings). A session's level comes from its agent role (Agents tab) or the owner's per-chat setting; with neither it runs as a Worker, the least authority. To the owner say Worker/Lead/Manager, never the key ic.$o$, $n$this session's level: Own work (key ic: its own cards, notes, messages) < Workspace (lead: also projects, loops, columns) < Organization (manager: also org-wide settings). A session's level comes from the agent it was started from (Agents tab) or the owner's per-chat setting; with neither it runs at Own work, the least authority. To the owner say Own work/Workspace/Organization, never the key ic.$n$))
              WHERE key = 'system_preamble' AND position($o$this session's level: Worker (key ic:$o$ in value #>> '{}') > 0;
            UPDATE settings SET value = to_jsonb(replace(value #>> '{}',
                $o$handed to another session or employee —$o$, $n$handed to another session —$n$))
              WHERE key = 'system_preamble' AND position($o$handed to another session or employee —$o$ in value #>> '{}') > 0;
            -- Note discussions shipped after installs seeded their preamble:
            -- name the tools in the notes line. A targeted, idempotent edit —
            -- an operator-rewritten preamble without that line is left alone.
            UPDATE settings SET value = to_jsonb(replace(value #>> '{}',
                $o$notes — note_list, note, note_create/update/delete;$o$,
                $n$notes — note_list, note, note_create/update/delete, note_comments/note_comment/note_vote (the discussion thread under every note: where sessions and the owner debate knowledge — reply only to add something new, vote to agree);$n$))
              WHERE key = 'system_preamble'
                AND position('note_comments' in value #>> '{}') = 0;
            -- Sessions run headless (claude -p): name what that means for
            -- long-running processes. Appended once; a no-op when present or
            -- when an operator rewrote the preamble without the board section.
            UPDATE settings SET value = to_jsonb((value #>> '{}') || $n$

## Running headless (claude -p, not the interactive CLI)
You run as `claude -p` (print mode), not the interactive CLI: no terminal watches your output, and nothing you start in the foreground outlives your turn. Never block a turn on a long-running process (a server, a watcher, a dev build). Before starting one, check whether it is already running (pgrep -fl '<command>'; for a port, /usr/sbin/lsof -nP -iTCP:PORT -sTCP:LISTEN on macOS or ss -ltnp on Linux) and reuse it — a duplicate wastes the machine, fights over the port and confuses the next session. When you must start one, detach it (nohup <cmd> > <log> 2>&1 & disown) — a tool's own background mode (run_in_background) is killed when your turn ends, so it is not detached — then record its PID, port and log path on your card so the next session finds it instead of starting another. Stop throwaway processes you started once the work is done.$n$)
              WHERE key = 'system_preamble'
                AND position('## Running headless' in value #>> '{}') = 0
                AND position('## Work discipline' in value #>> '{}') > 0;
            -- The first headless text named a bare `lsof` (not on launchd's
            -- PATH) and a plain `&` (a tool's background task still dies with
            -- the turn). Rewrite installs that hold it; no-op once updated.
            UPDATE settings SET value = to_jsonb(replace(replace(value #>> '{}',
                $o$check whether it is already running (lsof -i :PORT, pgrep -f '<command>') and reuse it$o$, $n$check whether it is already running (pgrep -fl '<command>'; for a port, /usr/sbin/lsof -nP -iTCP:PORT -sTCP:LISTEN on macOS or ss -ltnp on Linux) and reuse it$n$),
                $o$detach it (nohup <cmd> > <log> 2>&1 &), then$o$, $n$detach it (nohup <cmd> > <log> 2>&1 & disown) — a tool's own background mode (run_in_background) is killed when your turn ends, so it is not detached — then$n$))
              WHERE key = 'system_preamble'
                AND position('lsof -i :PORT' in value #>> '{}') > 0;
            -- Canvas: name the tools, and the one rule that keeps the pane rare
            -- (a picture only when it beats prose). Two idempotent edits — a
            -- fresh seed already names the tools but still needs the section.
            UPDATE settings SET value = to_jsonb(replace(value #>> '{}',
                $o$inbox — inbox_list, inbox_send.$o$,
                $n$inbox — inbox_list, inbox_send; canvas — canvas_show, canvas_read/patch/snapshot.$n$))
              WHERE key = 'system_preamble'
                AND position('canvas_show' in value #>> '{}') = 0;
            UPDATE settings SET value = to_jsonb((value #>> '{}') || $n$

## Canvas (show, don't tell — only when a picture wins)
Every project has one shared canvas the owner and agents draw on live. canvas_show places a doc tile on it: mermaid for a flow or architecture, markdown for a plan or comparison you will keep revising, slides for a walkthrough, html for a small interactive mock. Use it only when a picture beats prose — never for a simple answer. Reuse the title to update the tile in place at milestones, and say in chat what changed. canvas_read gives the canvas as meaning (frames, arrows, card/note tiles, ink groups); canvas_snapshot looks at ink or a region as a picture; canvas_patch draws — the owner can undo your whole patch.$n$)
              WHERE key = 'system_preamble'
                AND position('## Canvas (' in value #>> '{}') = 0
                AND position('## Work discipline' in value #>> '{}') > 0;
            -- Canvas merge: the pane became the shared project canvas. Rewrite
            -- installs still describing the pane; no-op once updated.
            UPDATE settings SET value = to_jsonb(replace(replace(value #>> '{}',
                $o$canvas — canvas_show/list/read/delete.$o$, $n$canvas — canvas_show, canvas_read/patch/snapshot.$n$),
                $o$canvas_show opens a visual pane beside the chat on the owner's screen: mermaid for a flow or architecture, markdown for a plan or comparison you will keep revising, slides for a walkthrough, html for a small interactive mock. Use it only when a picture beats prose — never for a simple answer. Reuse the title to update it at milestones, and say in chat what changed.$o$, $n$Every project has one shared canvas the owner and agents draw on live. canvas_show places a doc tile on it: mermaid for a flow or architecture, markdown for a plan or comparison you will keep revising, slides for a walkthrough, html for a small interactive mock. Use it only when a picture beats prose — never for a simple answer. Reuse the title to update the tile in place at milestones, and say in chat what changed. canvas_read gives the canvas as meaning (frames, arrows, card/note tiles, ink groups); canvas_snapshot looks at ink or a region as a picture; canvas_patch draws — the owner can undo your whole patch.$n$))
              WHERE key = 'system_preamble'
                AND position('canvas_show/list/read/delete' in value #>> '{}') > 0;
            -- session_analysis retired (it spawned a stray `claude -p` chat).
            UPDATE settings SET value = to_jsonb(replace(value #>> '{}',
                $o$session_list/detail/read/summary/analysis/seen$o$, $n$session_list/detail/read/summary/seen$n$))
              WHERE key = 'system_preamble' AND position($o$session_list/detail/read/summary/analysis/seen$o$ in value #>> '{}') > 0;
            -- Asks are for real blockers only: self-answerable questions are the
            -- agent's own thinking, not an AskUserQuestion card or a trailing
            -- "Should I…?". No-op once updated.
            UPDATE settings SET value = to_jsonb(replace(replace(value #>> '{}',
                $o$Asking the owner a question is Claude's built-in AskUserQuestion; proposing$o$,
                $n$Questions you can answer yourself are your own thinking: answer them and keep working — never end a reply on "Should I…?" or "Want me to…?" for work the task already covers, and never offer a menu of options you could pick between. Call Claude's built-in AskUserQuestion ONLY when you are genuinely blocked on something only the owner can decide (a credential, money, a delete, a business choice, two readings that lead to different work); a fact the owner merely needs to know goes in your reply as a statement, not a question. Proposing$n$),
                $o$Send to 'user' the moment any of these is true$o$,
                $n$Send to 'user' (or call AskUserQuestion) only when one of these is true$n$))
              WHERE key = 'system_preamble'
                AND position($o$Asking the owner a question is Claude's built-in AskUserQuestion; proposing$o$ in value #>> '{}') > 0;
            -- The owner's attention cap (orchestrator.queue): tell agents a decision
            -- is expensive and the queue is short. Inserted once before the
            -- design pointer; a no-op when present or on an operator rewrite.
            UPDATE settings SET value = to_jsonb(replace(value #>> '{}',
                $o$Full design: docs_read ORCHESTRATOR_MCP.md$o$,
                $n$## The owner's attention (a decision is expensive)
Every decision costs the owner real energy. The work was delegated so the owner does not have to do it; an agent that returns with question after question has handed it back. The owner sees only a few decisions at a time (they set the number, default 3); asks beyond it are held, with no push and no badge, until a slot frees. So each ask must move the goal forward a lot. Before raising one: decide anything that has a sensible default yourself and state the choice in your report; fold every open question for the same work into the one ask already on that card, each with your recommended answer; and check inbox_list's owner_queue — when held is above 0 the queue is full, so keep working and only add an ask that truly blocks you. Clean up after yourself: move finished work to Done, and pull a stale or superseded ask out of Review or Needs-info (with a comment saying why) the moment it no longer needs the owner.

Full design: docs_read ORCHESTRATOR_MCP.md$n$))
              WHERE key = 'system_preamble'
                AND position($o$## The owner's attention$o$ in value #>> '{}') = 0
                AND position($o$Full design: docs_read ORCHESTRATOR_MCP.md$o$ in value #>> '{}') > 0;
            -- Per-reader unread cursor: the last time a given reader OPENED a
            -- session. A session is unread for that reader when it changed after
            -- their cursor. Server-side (not per-device) so the signal is the same
            -- on web, mobile, and to an agent asking over MCP. `reader` is the
            -- resolved principal actor (user:<name> for a human — stable across
            -- their devices — or session:<label> for an agent), never a
            -- device id. No FK to sessions: transcripts are files, not rows.
            CREATE TABLE IF NOT EXISTS session_seen (
              reader    TEXT NOT NULL,
              session   TEXT NOT NULL,
              last_seen DOUBLE PRECISION NOT NULL,
              PRIMARY KEY (reader, session)
            );
            -- First-party product usage: what the owner's clients actually touch.
            -- One row per tap / screen view / control-seen / feedback, written by
            -- the owner's own web and phone clients to the owner's own server —
            -- nothing leaves the box. Bounded by retention (ui_events_days).
            CREATE TABLE IF NOT EXISTS ui_events (
              id       BIGSERIAL PRIMARY KEY,
              ts       DOUBLE PRECISION NOT NULL,
              actor    TEXT NOT NULL DEFAULT '',
              client   TEXT NOT NULL DEFAULT '',
              surface  TEXT NOT NULL DEFAULT '',
              element  TEXT NOT NULL DEFAULT '',
              kind     TEXT NOT NULL,
              detail   TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS ui_events_ts ON ui_events (ts);
            -- Intake channels: inbound doors from the outside world onto ONE board.
            -- Anything that can POST (a website form, a CI job, a monitoring alert,
            -- the owner's own in-app feedback) lands as a card on `project_id`,
            -- bound to `session_id` so the board-watch wake hands it to that
            -- session — the same path as a card the owner types. Only the token's
            -- sha256 is kept; the token itself is shown once, at creation.
            -- `app_feedback` marks the (at most one) channel that also receives
            -- the owner's in-app feedback notes (orchestrator.usage kind 'feedback').
            CREATE TABLE IF NOT EXISTS intake_channels (
              id           TEXT PRIMARY KEY,
              name         TEXT NOT NULL,
              project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              session_id   TEXT NOT NULL DEFAULT '',
              token_hash   TEXT NOT NULL,
              app_feedback BOOLEAN NOT NULL DEFAULT FALSE,
              created_by   TEXT NOT NULL DEFAULT '',
              created_at   DOUBLE PRECISION NOT NULL,
              last_used    DOUBLE PRECISION NOT NULL DEFAULT 0,
              received     INTEGER NOT NULL DEFAULT 0
            );
            -- Restart requests for the hourly maintenance window (orchestrator/
            -- maintenance.py). Agents queue here instead of restarting the
            -- server themselves; the :50 window applies them all with one
            -- restart. status: queued → restarting → done | failed.
            CREATE TABLE IF NOT EXISTS restart_requests (
              id           SERIAL PRIMARY KEY,
              requested_by TEXT NOT NULL DEFAULT '',
              session_id   TEXT NOT NULL DEFAULT '',
              commit_sha   TEXT NOT NULL DEFAULT '',
              reason       TEXT NOT NULL DEFAULT '',
              status       TEXT NOT NULL DEFAULT 'queued',
              created_at   DOUBLE PRECISION NOT NULL,
              handled_at   DOUBLE PRECISION NOT NULL DEFAULT 0
            );
            """
        )
    _install_live_triggers()
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
    # Version + schema stamp. The additive DDL above already ran idempotently;
    # now apply any ordered steps and record what this boot converged to. The
    # stamp is an upsert (NOT seed-once) so app_meta always reflects the running
    # release — which is how /healthz can report the live version and detect a
    # half-applied upgrade (code on disk vs what the DB was last stamped with).
    #
    # Skipped under PREFLIGHT: a spare-port preflight shares the live server's
    # Postgres, and both of these MUTATE it — the stamp rewrites app_meta (it
    # would mislabel the shared DB as the preflight code's version), and
    # _run_migrations is the seam for ordered/destructive steps that must never
    # run against a live DB from a validation boot. The additive IF-NOT-EXISTS
    # DDL above is idempotent and stays unguarded; only the forward-moving
    # convergence is gated. The real restart does the stamp.
    if not config.VIEWER_PREFLIGHT:
        meta = settings.setting_get("app_meta", {}) or {}
        _run_migrations(int(meta.get("schema_version", 0)))
        settings.setting_set("app_meta", {
            "version": config.VERSION,
            "schema_version": SCHEMA_VERSION,
            "stamped_at": time.time(),
        })


# Tables whose writes the live hub (orchestrator/live.py) relays. Each row change
# NOTIFYs `harman_events` with its keys only — {table, id, op, project_id};
# clients refetch through the ordinary GET routes, so no row content (and no
# authorization decision) ever rides the channel. project_id NULL = org-wide.
LIVE_TABLES = ("cards", "card_comments", "card_deps", "notes", "note_comments",
               "inbox_messages", "pending_questions", "pending_plans", "approvals")


def _install_live_triggers():
    """Idempotent: CREATE OR REPLACE the notify function and one AFTER trigger
    per LIVE_TABLES entry. The function swallows its own errors — a broken
    notification must never fail the write that caused it."""
    with postgres.cursor() as cur:
        cur.execute("""
            CREATE OR REPLACE FUNCTION harman_notify() RETURNS trigger AS $$
            DECLARE r record; pid integer; rid text;
            BEGIN
              BEGIN
                IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
                pid := NULL;
                IF TG_TABLE_NAME IN ('pending_questions', 'pending_plans') THEN
                  rid := r.session_id;
                ELSE
                  rid := r.id::text;
                END IF;
                IF TG_TABLE_NAME IN ('cards', 'notes', 'inbox_messages') THEN
                  pid := r.project_id;
                ELSIF TG_TABLE_NAME IN ('card_comments', 'card_deps') THEN
                  SELECT project_id INTO pid FROM cards WHERE id = r.card_id;
                ELSIF TG_TABLE_NAME = 'note_comments' THEN
                  SELECT project_id INTO pid FROM notes WHERE id = r.note_id;
                END IF;
                PERFORM pg_notify('harman_events', json_build_object(
                  'table', TG_TABLE_NAME, 'id', rid, 'op', TG_OP,
                  'project_id', pid)::text);
              EXCEPTION WHEN OTHERS THEN
                RAISE WARNING 'harman_notify %: %', TG_TABLE_NAME, SQLERRM;
              END;
              RETURN NULL;
            END $$ LANGUAGE plpgsql;
        """)
        for t in LIVE_TABLES:
            cur.execute(f"CREATE OR REPLACE TRIGGER harman_notify_{t} "
                        f"AFTER INSERT OR UPDATE OR DELETE ON {t} "
                        f"FOR EACH ROW EXECUTE FUNCTION harman_notify()")


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
    with postgres.cursor() as cur:
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
                limit = int(rec.pop("contextLimit", 0) or 0)
                if limit and rec.get("model"):
                    rec["modelLimits"] = {rec["model"]: {"override": limit}}
                provider_upsert(pid, rec)
        _retire(p)

    # harman config -> settings['harman']
    p = _LEGACY_DIR / ".viewer-harman.json"
    data = _read_json(p)
    if data is not None:
        # Seed only if the row is still the untouched default (no automation flip
        # since install). setting_get returns the seeded default on a fresh DB.
        cur_cfg = settings.setting_get("harman", {}) or {}
        # Only the master switch survives; the file's other keys fed the retired
        # manager tick (card 146).
        if not cur_cfg.get("automation_enabled") and isinstance(data, dict):
            settings.setting_set("harman", {"automation_enabled": bool(data.get("automation_enabled"))})
        _retire(p)

    # cloud-drive vendor clients -> settings['drive_clients']
    p = _LEGACY_DIR / ".viewer-drives-oauth.json"
    data = _read_json(p)
    if isinstance(data, dict):
        if not drive_clients_load():
            for kind, c in data.items():
                if isinstance(c, dict) and c.get("client_id"):
                    drive_client_set(kind, c["client_id"], c.get("client_secret") or "")
        _retire(p)
