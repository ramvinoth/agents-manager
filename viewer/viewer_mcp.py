"""viewer.viewer_mcp — the stdio MCP server that gives an agent session the viewer.

Two tiers, one transport:

- **See everything** (read-only): the fleet's sessions, their transcripts and
  analyses, the board, the org, the audit trail. An agent can find out what is
  happening on this machine without being able to change any of it.
- **Act on the board** (writes): create/move/assign cards, mark work done, propose
  a learned skill.
- **Files**: list/read/write on this machine, SSH hosts and the owner's connected
  cloud drives — the same /api/fs the file browser uses, so a drive connected in
  the app is usable by every session at once.

Runs as a SEPARATE process — possibly on a remote host over an SSH reverse tunnel —
so it CANNOT import viewer.db. Every tool is dumb transport: it calls the matching
/api/* endpoint with the per-run token, and ALL policy (responsibility scope, the
Green/Red gate, the approval queue, audit) lives server-side in viewer.actions. That
asymmetry is the point — a tool added here cannot grant authority the server would
not already have granted the same caller over HTTP.

Escalation is deliberately absent. Claude's built-in AskUserQuestion already reaches
the owner, and viewer/questions.py persists one left unanswered by a headless run and
resumes the session with the answer; a second "ask" tool would be two question stores
that drift. See ORCHESTRATOR_MCP.md §8.

Speaks newline-delimited JSON-RPC on stdout; prints NOTHING to stdout except protocol
messages. Spawned by start_claude_run (engine.py) via the shared --mcp-config, with
the session + token + viewer base passed in the environment.
"""
import json
import os
import sys
import urllib.error
import urllib.request

SESSION = os.environ.get("VIEWER_KANBAN_SESSION", "")
TOKEN = os.environ.get("VIEWER_KANBAN_TOKEN", "")
# The org project this session works under. Board tools default to this project so
# an agent sees and edits tasks in the project it's actually in.
PROJECT = os.environ.get("VIEWER_KANBAN_PROJECT", "")
BASE = os.environ.get("VIEWER_KANBAN_BASE") or (
    "http://127.0.0.1:" + os.environ.get("VIEWER_KANBAN_PORT", "8091"))

# tool name -> (HTTP method, path). Kept in lockstep with viewer/server.py's route
# tables. GET is read-only by construction: the server's write path is POST-only,
# so a mistake in this table cannot turn a read tool into a mutation.
_TOOLS = {
    # ── See everything (read-only) ──────────────────────────────────────────
    "session_list":     ("GET", "/api/sessions"),
    "session_read":     ("GET", "/api/session/"),      # + <path>, see _PATH_ARG
    "session_summary":  ("GET", "/api/session-summary"),
    "session_detail":   ("GET", "/api/session-detail"),
    "session_analysis": ("GET", "/api/session-analysis"),
    "chat_status":      ("GET", "/api/chat/status"),
    "host_list":        ("GET", "/api/hosts"),
    "project_list":     ("GET", "/api/org/projects"),
    "employee_list":    ("GET", "/api/org/employees"),
    "skill_list":       ("GET", "/api/org/skills"),
    "skill_read":       ("GET", "/api/org/skills/read"),
    "docs_list":        ("GET", "/api/org/docs"),
    "docs_read":        ("GET", "/api/org/docs/read"),
    "approval_list":    ("GET", "/api/org/approvals"),
    "audit_tail":       ("GET", "/api/org/audit"),
    "usage_report":     ("GET", "/api/usage/report"),
    "intake_list":      ("GET", "/api/org/intake"),
    "maintenance_status": ("GET", "/api/org/maintenance"),
    "board_list":       ("GET", "/api/org/board"),
    "card_list":        ("GET", "/api/org/cards"),
    "card":             ("GET", "/api/org/card"),
    "card_comments":    ("GET", "/api/org/card_comments"),
    "card_deps":        ("GET", "/api/org/card_deps"),
    "note_list":        ("GET", "/api/org/notes"),
    "note":             ("GET", "/api/org/note"),
    "note_graph":       ("GET", "/api/org/notes/graph"),
    "code_map":         ("GET", "/api/org/map"),
    "note_comments":    ("GET", "/api/org/note_comments"),
    "loop_list":        ("GET", "/api/loops"),
    "loop_control_get": ("GET", "/api/org/loop-control"),
    "inbox_list":       ("GET", "/api/inbox"),
    # ── Files: this machine, SSH hosts, and the owner's connected cloud drives.
    # The same /api/fs the file browser uses, so a drive connected in the app is
    # visible to every session at once. Rename/delete/compress are deliberately
    # not exposed: a file delete is Red (orglogic._RED_ACTIONS) and the fs routes
    # do not run through the approval queue — ask the owner on a card instead.
    "drive_list":       ("GET", "/api/drives"),
    "fs_list":          ("GET", "/api/fs"),
    "fs_read":          ("GET", "/api/fs/download"),
    "fs_write":         ("POST", "/api/fs/write"),
    "fs_mkdir":         ("POST", "/api/fs/mkdir"),
    # ── The owner's connected accounts (Integrations page). Mail is read +
    # draft only: an agent never sends — the owner presses Send in Gmail.
    # Calendar writes never notify guests (sendUpdates=none). What an agent
    # may do per account is the owner's switch there; the server enforces it.
    "integrations_list": ("GET", "/api/integrations"),
    "gmail_search":     ("GET", "/api/gmail/search"),
    "gmail_read":       ("GET", "/api/gmail/read"),
    "gmail_draft":      ("POST", "/api/gmail/draft"),
    "calendar_events":  ("GET", "/api/calendar/events"),
    "calendar_create":  ("POST", "/api/calendar/create"),
    "calendar_update":  ("POST", "/api/calendar/update"),
    "calendar_delete":  ("POST", "/api/calendar/delete"),
    # API-token providers (Cloudflare, Hetzner, DigitalOcean…): one proxy; the
    # server adds the credential, pins the vendor host and checks read/change.
    "api_call":         ("POST", "/api/integrations/api"),
    # ── Act on the board (writes; gated server-side) ────────────────────────
    "card_create":   ("POST", "/api/org/cards"),
    "card_move":     ("POST", "/api/org/cards/move"),
    "card_assign":   ("POST", "/api/org/cards/assign"),
    "card_update":   ("POST", "/api/org/cards/update"),
    "card_comment":  ("POST", "/api/org/card_comment"),
    "card_dep_add":  ("POST", "/api/org/card_dep_add"),
    "card_dep_remove": ("POST", "/api/org/card_dep_remove"),
    "task_done":     ("POST", "/api/org/cards/done"),
    "note_create":   ("POST", "/api/org/notes"),
    "note_update":   ("POST", "/api/org/notes/update"),
    "note_delete":   ("POST", "/api/org/notes/delete"),
    "note_comment":  ("POST", "/api/org/note_comment"),
    "note_vote":     ("POST", "/api/org/note_vote"),
    "skill_propose": ("POST", "/api/org/skills/propose"),
    "session_seen":  ("POST", "/api/session/seen"),
    "session_mode_set": ("POST", "/api/session/mode"),
    "inbox_send":    ("POST", "/api/inbox/send"),
    # ── Schedule recurring work (writes; gated + self-mutation rail server-side)
    "loop_create":   ("POST", "/api/org/loops"),
    "loop_update":   ("POST", "/api/org/loops/update"),
    "loop_delete":   ("POST", "/api/org/loops/delete"),
    "loop_control_set": ("POST", "/api/org/loop-control"),
    "intake_create": ("POST", "/api/org/intake"),
    "restart_request": ("POST", "/api/org/maintenance/request"),
}

# Tools whose URL is completed at call time from an argument rather than being a
# fixed endpoint. Listed explicitly so _call never string-builds a path by accident.
_PATH_ARG = {"session_read": "session"}

# Tools whose response body is the content itself (a transcript's JSONL, a
# file's bytes), handed back as text rather than parsed as the tool's JSON.
_RAW = {"session_read", "fs_read"}

# Board READ tools default to THIS session's project, so an agent's view of the
# board stays inside the project it is working in. card_create is NOT here: the
# create route resolves the card's project from the session itself (the one rule
# in routes.orchestrator), so the MCP never carries a second copy of it.
_PROJECT_DEFAULT = {"board_list": "project", "card_list": "project", "note_list": "project",
                    "note_graph": "project", "code_map": "project"}

_HOST_ARG = {"type": "string",
             "description": "Host id from host_list; omit for this machine."}
_DRIVE_ARG = {"type": "string",
              "description": "Cloud drive id from drive_list; omit for a machine. Never together with host."}

# Every Red tool (it queues for the owner) carries this: the owner judges the
# request cold, so the server refuses one that does not say why (actions.execute).
_REASON_ARG = {"type": "string",
               "description": "One plain line the owner reads on the decision card: why you need this now."}

_CONN_ARG = {"type": "string",
             "description": "Account id from integrations_list; only needed when several accounts have the service on."}
_CAL_ARG = {"type": "string", "description": "Calendar id (default primary)."}
_EVENT_PROPS = {
    "title": {"type": "string"},
    "start": {"type": "string", "description": "ISO datetime with offset (2026-10-06T15:00:00-07:00), or a date (2026-10-06) with all_day."},
    "end": {"type": "string", "description": "Same form as start; for all_day the day after the last day."},
    "all_day": {"type": "boolean"},
    "location": {"type": "string"}, "description": {"type": "string"},
    "attendees": {"type": "array", "items": {"type": "string"}, "description": "Guest emails (never notified)."}}

_TOOL_LIST = [
    # ── See everything ──────────────────────────────────────────────────────
    {"name": "session_list",
     "description": "List Claude sessions on a host — id, title, timestamps. Start here to find out what is running, or what ran recently.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "host": _HOST_ARG}}},
    {"name": "session_read",
     "description": "Read a session's transcript. Use tail to get only the most recent lines instead of the whole file.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["session"], "properties": {
         "session": {"type": "string", "description": "Session path/id from session_list."},
         "tail": {"type": "integer", "description": "Return only the last N lines."},
         "host": _HOST_ARG}}},
    {"name": "session_summary",
     "description": "Cheap metadata for a session (size, line count, timestamps) without reading the transcript.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["session"], "properties": {
         "session": {"type": "string"}, "host": _HOST_ARG}}},
    {"name": "session_detail",
     "description": "One composed view of ANOTHER session: its goal, provider, skills + MCP tools, working dir, run stats, and whether it is running now. The big-picture read — start here to understand what a session is and can do. Target it by `id` from session_list.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["id"], "properties": {
         "id": {"type": "string", "description": "Target session id from session_list."},
         "agent": {"type": "string", "description": "Harness: claude (default), codex, copilot."},
         "host": _HOST_ARG}}},
    {"name": "session_analysis",
     "description": "Extracted facts about what a session was doing. Cached; pass refresh=\"1\" to recompute.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["session"], "properties": {
         "session": {"type": "string"},
         "refresh": {"type": "string", "description": "\"1\" to recompute."},
         "host": _HOST_ARG}}},
    {"name": "chat_status",
     "description": "Whether a session has a run in flight, and any question or plan it is waiting on.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["id"], "properties": {
         "id": {"type": "string", "description": "Session id."}}}},
    {"name": "host_list",
     "description": "Machines this viewer can reach. Never returns credentials.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {}}},
    {"name": "project_list", "description": "All org projects.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {}}},
    {"name": "employee_list", "description": "All org employees, their roles and status.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {}}},
    {"name": "skill_list", "description": "The team's skill library: every skill on this machine (name, one-line trigger description, provenance — who learned it, from which card). Each is invocable as /<name> in a session; read one in full with skill_read. Check here before solving a problem a teammate may already have written up.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {}}},
    {"name": "skill_read", "description": "Read one skill's full SKILL.md by name (from skill_list): the procedure a teammate distilled, ready to follow.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["name"], "properties": {
         "name": {"type": "string", "description": "Skill name from skill_list."}}}},
    {"name": "docs_list",
     "description": "List the system's documentation: the design/charter docs plus a live system-status doc (the current automation switch, loop mode, and system preamble). Read this to learn how the system works and its current posture.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {}}},
    {"name": "docs_read",
     "description": "Read one doc in full by id (from docs_list). 'system-status' is composed live; the rest are the repo's design docs.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["id"], "properties": {
         "id": {"type": "string", "description": "Doc id from docs_list."}}}},
    {"name": "approval_list",
     "description": "Open approvals — actions queued and waiting on the owner.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {}}},
    {"name": "audit_tail",
     "description": "Recent audit entries: who did what, and whether it ran, queued or was denied.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "limit": {"type": "integer", "description": "How many entries (default 100)."}}}},
    {"name": "usage_report",
     "description": "How the owner actually uses the Harman app (their own web and phone clients, recorded on this server only): hot controls (most tapped, with times seen), dead controls (on screen 20+ times, never tapped — candidates to remove, merge or move), cold controls (used before the window, not in it), screen opens, and the owner's in-app feedback notes. Read it before proposing UI changes; cite it on the card.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "days": {"type": "integer", "description": "Window in days (default 30)."}}}},
    {"name": "intake_list",
     "description": "Intake channels: doors from the outside world onto a board. Each is a URL (path) + secret token bound to one project board and optionally one session; any POST to it (a website form, CI failure, alert, support tool, or the owner's in-app feedback when app_feedback is true) becomes a card on that board and wakes that session. Shows name, project_id, session_id, app_feedback, received, last_used — never the token.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {}}},
    {"name": "intake_create",
     "description": "Request a new intake channel onto a project board, optionally bound to a session (that session is woken per card) and optionally receiving the owner's in-app feedback (app_feedback; at most one channel does). Red: an outside door, so it queues for the owner's approval. The token is never shown to an agent: after approving, the owner takes it from Integrations → Intake channels (New token).",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["name", "project_id", "reason"], "properties": {
         "reason": _REASON_ARG,
         "name": {"type": "string", "description": "What feeds it, e.g. 'Website contact form'."},
         "project_id": {"type": "integer"},
         "for_session": {"type": "string", "description": "Session to wake for each new card; omit for board-only."},
         "app_feedback": {"type": "boolean"}}}},
    {"name": "restart_request",
     "description": "Ask for a Harman server restart so your server-code change goes live. Never restart the server yourself: every restart cuts off every running agent turn. Requests queue for the hourly maintenance window (:50 local time): it waits for running turns to finish (up to 10 min), preflights the code on a spare port, restarts ONCE for all queued requests and writes one audit entry. You are woken afterwards with the result (live, or why it was not applied). Commit your change first.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["reason"], "properties": {
         "reason": {"type": "string", "description": "What changed and why it needs a restart (it goes in the audit record)."},
         "commit": {"type": "string", "description": "The commit that must go live."}}}},
    {"name": "maintenance_status",
     "description": "The maintenance window: the minute it runs each hour, when the next one is, and the restart requests queued for it.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {}}},
    {"name": "board_list", "description": "List your project's board columns.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "project": {"type": "integer"}}}},
    {"name": "card_list", "description": "List cards in your project — the durable work ledger. Check this, not memory, when asked what work is pending. Each card carries comment_count (how many messages are in its thread) and its current column. Optionally filtered by session/assignee.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "session": {"type": "string"}, "project": {"type": "integer"}, "assignee": {"type": "integer"}}}},
    {"name": "card", "description": "Read one card in full with its comment thread. On a [board-watch] wake (a [board-watch] prompt names your card id), read the card and its comments here, then act: Approved means go ahead (finish, then move to Done), Declined means stop, a comment is the owner's message for you — answer by commenting on the card.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["id"], "properties": {
         "id": {"type": "integer"}}}},
    {"name": "card_comments", "description": "Read a card's comment thread (who said what, in order).",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["card_id"], "properties": {
         "card_id": {"type": "integer"}}}},
    {"name": "card_deps", "description": "Read a card's dependency edges (card_deps): which other cards it cannot move forward until, each with its column and a done flag. The owner sees and edits the same rows in the UI (dual control) — if a dep is not done, say so in a card comment instead of stalling silently.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["card_id"], "properties": {
         "card_id": {"type": "integer"}}}},
    {"name": "loop_list",
     "description": "List scheduled loops — recurring prompts (cron/interval) and pending one-shots (kind='once'), optionally for one session. Start here to find a loop's id before updating or deleting it.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "session": {"type": "string", "description": "Session id to filter by; omit for all."}}}},
    {"name": "loop_control_get",
     "description": "The current loop-firing mode (user/harman/both/none): WHICH loop origins may fire right now.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {}}},
    # ── Notes (the knowledge ledger next to the board) ──────────────────────
    {"name": "note_list", "description": "List notes — the durable knowledge ledger next to the board. Defaults to this project's notes; pass session to see one chat's notes, archived=true for the shelf. Write here what should outlive this conversation: research, decisions taken, journal entries, meeting notes.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "session": {"type": "string"}, "project": {"type": "integer"}, "archived": {"type": "boolean"}}}},
    {"name": "note", "description": "Read one note in full (markdown body).",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["id"], "properties": {
         "id": {"type": "integer"}}}},
    {"name": "note_graph", "description": "How notes connect. Notes link like an Obsidian vault: [[Title]], [[Title#Heading]], [[Title|shown text]], and tag themselves with #tag. Returns nodes, link edges (with the line each link sits on), ghosts (titles linked but not written yet), tag counts. Pass id for one note: its backlinks and outgoing links. Read this before writing so you link to what exists instead of duplicating it.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "project": {"type": "integer"}, "id": {"type": "integer", "description": "One note's backlinks + links."}}}},
    {"name": "code_map", "description": "Your project's code as a graph (the Map lens), parsed live with tree-sitter. level=project: top folders and how they import each other; level=folder + path (e.g. viewer/routes): its files and sub-folders with import edges; level=file + path (e.g. viewer/db.py): its classes and functions with line numbers, what it imports and who imports it. `touched` lists files an agent wrote in the last 15 minutes. Read this before a cross-file change to find what depends on what you touch.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "project": {"type": "integer"},
         "level": {"type": "string", "enum": ["project", "folder", "file"]},
         "path": {"type": "string", "description": "Repo-relative folder or file; omit at project level."}}}},
    {"name": "note_create", "description": "Create a note (markdown). kind: note | journal | meeting | idea | checklist | discussion (a topic you post for others to answer in its thread). Link related notes with [[Their Title]] and tag with #tag so the knowledge stays a connected graph. Notes you create are owned by you and scoped to this session and its project; they archive when the chat is archived and go when it is deleted.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["title"], "properties": {
         "title": {"type": "string"}, "body": {"type": "string"}, "kind": {"type": "string"},
         "project_id": {"type": "integer"}, "pinned": {"type": "boolean"}}}},
    {"name": "note_update", "description": "Edit a note's title/body/kind, pin it, or archive/unarchive it. Renaming a note rewrites every [[link]] to it in the project.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["note_id"], "properties": {
         "note_id": {"type": "integer"}, "title": {"type": "string"}, "body": {"type": "string"},
         "kind": {"type": "string"}, "pinned": {"type": "boolean"}, "archived": {"type": "boolean"}}}},
    {"name": "note_comments", "description": "Read a note's discussion thread — Reddit-style: comments nest under the comment they reply to (`replies`), each with a vote `score`. sort: best (default, by votes) | new | old. Read the thread before you write, so you answer what was asked instead of repeating it.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["note_id"], "properties": {
         "note_id": {"type": "integer"}, "sort": {"type": "string", "enum": ["best", "new", "old"]}}}},
    {"name": "note_comment", "description": "Post in a note's discussion: the message board where sessions and the owner discuss knowledge — challenge research, add evidence, propose a decision. Pass parent_id to reply to one comment. The note's session and the replied-to author are woken; an agent's reply to the owner pushes their phone. Write only when you add something new (an answer, a correction, evidence); to agree, use note_vote. Work that needs doing becomes a card, not a comment.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["note_id", "body"], "properties": {
         "note_id": {"type": "integer"}, "body": {"type": "string"},
         "parent_id": {"type": "integer", "description": "The comment you are replying to (omit for a top-level comment)."}}}},
    {"name": "note_vote", "description": "Vote on a discussion comment: 1 (useful/correct), -1 (wrong/unhelpful), 0 (withdraw). The best-voted answer rises to the top of the thread. Not on your own comments.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["comment_id", "value"], "properties": {
         "comment_id": {"type": "integer"}, "value": {"type": "integer", "enum": [1, -1, 0]}}}},
    {"name": "note_delete", "description": "Delete a note. Irreversible, so it queues for the owner's approval; prefer note_update archived=true.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["note_id", "reason"], "properties": {
         "reason": _REASON_ARG,
         "note_id": {"type": "integer"}}}},
    # ── Files (this machine, SSH hosts, connected cloud drives) ─────────────
    {"name": "drive_list",
     "description": "The owner's connected cloud drives (Google Drive, Dropbox, OneDrive) — id, label, kind, whether it is authorized. Pass a drive id as `drive` to the fs_* tools to work in that drive; every session on this server sees the same drives.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {}}},
    {"name": "integrations_list",
     "description": "What you may use right now: each connected service (files, mail, calendar, and API accounts such as Cloudflare, Hetzner, DigitalOcean, Tailscale, Discord, Mixpanel, Odoo) per account with the operations you may do (`may`), the ones only the owner can turn on (`ask_owner`), the tools that reach it, and whether its sign-in expired; plus this machine's folders. Your system prompt already carries this as of the start of the run — call it to re-check. If what you need is not there, ask the owner to connect or turn it on in Integrations rather than working around it.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {}}},
    {"name": "api_call",
     "description": "Call a connected API-token account's REST API (Cloudflare, Hetzner Cloud, DigitalOcean, Vultr, Linode, Tailscale, Discord, Mixpanel, Odoo). Pass the connection id from integrations_list and a path relative to that vendor's API base (its docs link is in integrations_list), e.g. GET /zones on Cloudflare or GET /servers on Hetzner. The server adds the credential. GET is a read; POST/PUT/PATCH/DELETE are changes, which the owner allows per account and which can spend money or move DNS — propose them on your card first. Returns {status, body}.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["connection", "path"], "properties": {
         "connection": {"type": "string", "description": "Account id from integrations_list."},
         "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"], "description": "Default GET."},
         "path": {"type": "string", "description": "API path starting with /, query string allowed."},
         "body": {"type": "object", "description": "JSON body for POST/PUT/PATCH."}}}},
    {"name": "gmail_search",
     "description": "Search the owner's Gmail with Gmail search syntax (from:, subject:, newer_than:7d, is:unread, …; default in:inbox). Returns id, thread, from, subject, date, snippet, unread for up to `limit` (≤50) messages. Read one in full with gmail_read.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "q": {"type": "string"}, "limit": {"type": "integer"}, "connection": _CONN_ARG}}},
    {"name": "gmail_read",
     "description": "Read one Gmail message by id (from gmail_search): headers, labels, attachment names and the plain-text body (capped).",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["id"], "properties": {
         "id": {"type": "string"}, "connection": _CONN_ARG}}},
    {"name": "gmail_draft",
     "description": "Save a draft in the owner's Gmail Drafts — never sent. Pass reply_to=<message id> to draft a reply in that thread. Tell the owner (card comment) the draft is waiting for their review and Send.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["to", "subject", "body"], "properties": {
         "to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string", "description": "Plain text."},
         "cc": {"type": "string"}, "reply_to": {"type": "string", "description": "Message id this replies to."},
         "connection": _CONN_ARG}}},
    {"name": "calendar_events",
     "description": "The owner's Google Calendar events between start and end (ISO dates/datetimes; default now → 7 days), recurring events expanded, in start order: title, start, end, all_day, location, attendees, link.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "start": {"type": "string"}, "end": {"type": "string"}, "q": {"type": "string", "description": "Free-text filter."},
         "calendar": _CAL_ARG,
         "limit": {"type": "integer"}, "connection": _CONN_ARG}}},
    {"name": "calendar_create",
     "description": "Add an event to the owner's Google Calendar. Guests are never emailed. Only works if the owner allowed 'Add events' for that account in Integrations — if refused, ask them on your card instead of retrying.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["title", "start", "end"], "properties": {
         **_EVENT_PROPS, "calendar": _CAL_ARG, "connection": _CONN_ARG}}},
    {"name": "calendar_update",
     "description": "Change an event (id from calendar_events): only the fields you pass change. Guests are never emailed. Needs 'Edit events' allowed in Integrations.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["id"], "properties": {
         "id": {"type": "string"}, **_EVENT_PROPS, "calendar": _CAL_ARG, "connection": _CONN_ARG}}},
    {"name": "calendar_delete",
     "description": "Delete an event (id from calendar_events). Guests are never emailed. Off unless the owner allowed 'Delete' for calendar in Integrations — confirm with the owner on your card first.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["id"], "properties": {
         "id": {"type": "string"}, "calendar": _CAL_ARG, "connection": _CONN_ARG}}},
    {"name": "fs_list",
     "description": "List a directory: entries with name/type/size/modified. Scope with EXACTLY ONE of `drive` (a cloud drive id from drive_list) or `host` (an SSH host from host_list); neither means this machine. Paths on a drive start at '/'; on a machine '~' is home.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "path": {"type": "string", "description": "Directory to list (default '~' on a machine, '/' on a drive)."},
         "drive": _DRIVE_ARG, "host": _HOST_ARG,
         "hidden": {"type": "string", "enum": ["0", "1"], "description": "\"1\" to include dotfiles."}}}},
    {"name": "fs_read",
     "description": "Read one file's contents as text (same drive/host scoping as fs_list). Meant for text and documents you can reason about; a binary file comes back as replacement-character noise. Files holding this machine's credentials are refused (403).",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["path"], "properties": {
         "path": {"type": "string", "description": "Full path of the file."},
         "drive": _DRIVE_ARG, "host": _HOST_ARG}}},
    {"name": "fs_write",
     "description": "Create or overwrite ONE file `name` inside directory `path` with `content` (same drive/host scoping as fs_list). Text by default; pass encoding=\"base64\" for binary. Overwrites silently — fs_list first if the name may already exist. To share a result with the owner, write it into a connected drive folder and name the path in your card comment.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["path", "name", "content"], "properties": {
         "path": {"type": "string", "description": "Target directory."},
         "name": {"type": "string", "description": "File name only (no slashes)."},
         "content": {"type": "string"},
         "encoding": {"type": "string", "enum": ["base64"]},
         "drive": _DRIVE_ARG, "host": _HOST_ARG}}},
    {"name": "fs_mkdir",
     "description": "Create folder `name` inside directory `path` (same drive/host scoping as fs_list). 409 if it already exists.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["path", "name"], "properties": {
         "path": {"type": "string"}, "name": {"type": "string"},
         "drive": _DRIVE_ARG, "host": _HOST_ARG}}},
    # ── Act on the board ────────────────────────────────────────────────────
    {"name": "card_create", "description": "Create a card on the board (title required). Board cards are the durable work ledger: park deferred, handed-off, or follow-up work here so it survives this session.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["title"], "properties": {
         "title": {"type": "string"}, "body": {"type": "string"},
         "column_id": {"type": "integer"}, "project_id": {"type": "integer"}}}},
    {"name": "card_move", "description": "Move a card to a column at a position.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["card_id", "column_id"], "properties": {
         "card_id": {"type": "integer"}, "column_id": {"type": "integer"}, "position": {"type": "number"}}}},
    {"name": "card_assign", "description": "Assign a card to an employee.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["card_id", "assignee"], "properties": {
         "card_id": {"type": "integer"}, "assignee": {"type": "integer"}}}},
    {"name": "card_update", "description": "Update a card's fields.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["card_id"], "properties": {
         "card_id": {"type": "integer"}}}},
    {"name": "card_comment", "description": "Post a message on a card's thread — how you talk to the owner about that work (status, questions, your read of their decision). The owner gets a push when an agent comments. Your own column moves do not notify you back.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["card_id", "body"], "properties": {
         "card_id": {"type": "integer"}, "body": {"type": "string"}}}},
    {"name": "card_dep_add", "description": "Add a dependency: this card cannot move forward until the other card reaches Done. Use it when your work is blocked on someone else's card — the other card's session is woken with the edge.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["card_id", "depends_on"], "properties": {
         "card_id": {"type": "integer", "description": "The card that is blocked."},
         "depends_on": {"type": "integer", "description": "The card it must wait for."}}}},
    {"name": "card_dep_remove", "description": "Remove a dependency edge (the work is no longer blocked, or the edge was wrong). The blocked card's session is woken.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["card_id", "depends_on"], "properties": {
         "card_id": {"type": "integer"}, "depends_on": {"type": "integer"}}}},
    {"name": "task_done", "description": "Mark a card done (move to the Done column).",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["card_id"], "properties": {
         "card_id": {"type": "integer"}}}},
    {"name": "skill_propose", "description": "Propose a reusable skill learned from this work so the whole team inherits it. Novel skills are promoted immediately; ones that overlap an existing skill are queued for the owner to review.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["name", "trigger", "body"], "properties": {
         "reason": {"type": "string", "description": "Why it should replace the existing skill — required when it overlaps one (that queues for the owner)."},
         "name": {"type": "string", "description": "short kebab/underscore id"},
         "trigger": {"type": "string", "description": "when to use this skill (its description)"},
         "body": {"type": "string", "description": "the procedure/lesson"},
         "from_card": {"type": "integer"}}}},
    {"name": "session_seen",
     "description": "Mark another session read for you, up to now — clears its unread flag in your view. Target it by `id` from session_list.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["id"], "properties": {
         "id": {"type": "string", "description": "Target session id from session_list."}}}},
    # ── Inbox: your message ledger (you ↔ owner, you ↔ peers) ───────────────
    {"name": "inbox_list",
     "description": "Your inbox: the messages addressed to your session (from the owner or other sessions) and the ones you sent to the owner, newest first. A row can carry a decision (kind: message | question | plan | approval | card | red — red is an approval you queued for a Red action) with its LIVE state — open/resolved, read/snoozed — derived at read time; the deciding tap itself stays in the chat UI, the inbox only tells you what is waiting and what the owner said. Read it on a wake and before you act. Filter with kind.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "kind": {"type": "string", "enum": ["message", "question", "plan", "approval", "card", "red"]}}}},
    {"name": "inbox_send",
     "description": "Send a message: to='user' reaches the owner (he gets a push); to='session:<id>' wakes another session with your text (queued into its live run, or a fresh resumed turn on its host). Use it to hand work to a peer, ask a question, or report a result — the board stays the record of the work, the inbox is the channel; the recipient's reply arrives in YOUR inbox. Green (your own messages), never gated behind a decision.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["to", "body"], "properties": {
         "to": {"type": "string", "description": "'user' (the owner) or 'session:<id>' (another session)."},
         "body": {"type": "string", "description": "The message — self-contained: the recipient has no context beyond this text."},
         "in_reply_to": {"type": "integer", "description": "Inbox message id you are replying to, if any."}}}},
    # ── Schedule recurring work ─────────────────────────────────────────────
    {"name": "loop_create",
     "description": "Schedule work for ANOTHER session (a worker you manage): a RECURRING prompt (cron expression OR interval like 30s/5m/1h), or a ONE-SHOT task via `at` that fires once at that time and then retires — plan ahead by ending a run by creating its next wake. You cannot schedule your OWN session. Whether harman-scheduled loops actually FIRE is governed separately by the loop-control mode.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["for_session", "prompt"], "properties": {
         "for_session": {"type": "string", "description": "Target session id to run the prompt in (must not be your own)."},
         "prompt": {"type": "string", "description": "The prompt to run (each time, or once for a one-shot)."},
         "cron": {"type": "string", "description": "5-field cron expression for a recurring schedule (wins over interval)."},
         "interval": {"type": "string", "description": "Recurring: e.g. 30s, 5m, 1h."},
         "at": {"type": "string", "description": "ONE-SHOT: fire once, then stop. A relative offset (30m, 2h, 1d) or a local time like '2026-09-17 21:00'."},
         "path": {"type": "string", "description": "Session path/id for --resume; optional."},
         "model": {"type": "string"},
         "provider": {"type": "string", "description": "Custom provider preset id for the runs; empty inherits the target session's provider."}}}},
    {"name": "loop_update",
     "description": "Edit a harman-scheduled loop (prompt/cron/interval/at/model/provider/enabled). `at` converts it to a one-shot; cron/interval back to recurring. Only loops you (agents) scheduled can be edited; a human's own loops are off-limits, as is the loop driving your OWN session.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["id"], "properties": {
         "id": {"type": "string", "description": "Loop id from loop_list."},
         "prompt": {"type": "string"}, "cron": {"type": "string"},
         "interval": {"type": "string"},
         "at": {"type": "string", "description": "Convert to a one-shot firing at this time (relative or local)."},
         "model": {"type": "string"},
         "provider": {"type": "string", "description": "Custom provider preset id for the runs; empty inherits the target session's provider."},
         "enabled": {"type": "boolean"}}}},
    {"name": "loop_delete",
     "description": "Delete a harman-scheduled loop. Irreversible (takes its run history with it), so it queues for the owner's approval. Only agent-scheduled loops, never the one driving your own session.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["id", "reason"], "properties": {
         "reason": _REASON_ARG,
         "id": {"type": "string", "description": "Loop id from loop_list."}}}},
    {"name": "loop_control_set",
     "description": "Set WHICH loop origins may fire: user (human-scheduled only), harman (agent-scheduled only), both, or none. Manager-scoped; setting it does not touch the automation master switch.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["mode"], "properties": {
         "mode": {"type": "string", "enum": ["user", "harman", "both", "none"]}}}},
    # ── Delegate trust to a session (Red: queues for the owner) ─────────────
    {"name": "session_mode_set",
     "description": "Set the permission mode a session's runs start in: default (every tool gated), acceptEdits (file edits auto-approve, commands still gated), plan, or bypass (no gating at all — runs start with --dangerously-skip-permissions). It applies to EVERY later run of that session (loop-fired AND chat) — the way a trusted agent runs its loops without a command-approval push per Bash. Red: the request queues for the owner's approval and runs once he approves; a model can never set its OWN session (the server refuses it — trust is granted by the person, not requested by the agent).",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["for_session", "mode", "reason"], "properties": {
         "reason": _REASON_ARG,
         "for_session": {"type": "string", "description": "Target session id (from session_list; must not be your own)."},
         "mode": {"type": "string", "enum": ["default", "acceptEdits", "plan", "bypass"],
                 "description": "The permission mode for that session's runs."}}}},
]


def _send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _call(tool, args):
    """Proxy a tool call to the viewer. Returns the server's JSON — already the
    policy verdict (allowed / queued / denied), never a local decision."""
    spec = _TOOLS.get(tool)
    if not spec:
        return {"error": f"unknown tool {tool}"}
    method, path = spec
    payload = dict(args or {})
    payload["session"] = SESSION
    payload["token"] = TOKEN
    if PROJECT and tool in _PROJECT_DEFAULT:
        payload.setdefault(_PROJECT_DEFAULT[tool], PROJECT)
    if tool in _PATH_ARG:
        # This tool addresses a resource by PATH (/api/session/<id>). Quoting is not
        # optional: the value comes from a model, and unescaped it could otherwise
        # append a query string or traverse to a different endpoint entirely.
        from urllib.parse import quote
        key = _PATH_ARG[tool]
        value = str(payload.pop(key, "") or "").lstrip("/")
        if not value:
            return {"error": f"{key} required"}
        path += quote(value)
    url = BASE + path
    # The credential always travels in headers, on both verbs: the server resolves
    # the caller ONCE at the gate, before any body is read. (Legacy X-Kanban-* are
    # still accepted server-side, so an older subprocess mid-run keeps working.)
    auth = {"X-Viewer-Session": SESSION, "X-Viewer-Token": TOKEN}
    try:
        if method == "GET":
            from urllib.parse import urlencode
            q = {k: v for k, v in payload.items()
                 if k not in ("session", "token") and v is not None}
            if q:
                url += "?" + urlencode(q)
            req = urllib.request.Request(url, method="GET", headers=auth)
        else:
            req = urllib.request.Request(
                url, data=json.dumps(payload).encode(), method="POST",
                headers={"Content-Type": "application/json", **auth})
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read() or b"{}"
    except urllib.error.HTTPError as e:
        # A 4xx/5xx still carries the server's verdict ({"error": ...}); the
        # model needs that sentence, not "HTTP Error 403".
        try:
            return json.loads(e.read() or b"")
        except ValueError:
            return {"error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": f"viewer unreachable: {e}"}
    if tool in _RAW:
        # The payload IS the file/transcript, so it must reach the model
        # verbatim — a JSON file read would otherwise be parsed and reshaped.
        return {"text": body.decode(errors="replace")}
    try:
        return json.loads(body)
    except ValueError:
        return {"text": body.decode(errors="replace")}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        method, rid = req.get("method"), req.get("id")
        if method == "initialize":
            pv = (req.get("params") or {}).get("protocolVersion", "2024-11-05")
            _send({"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": pv, "capabilities": {"tools": {}},
                "serverInfo": {"name": "viewer", "version": "1.0.0"}}})
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": rid, "result": {"tools": _TOOL_LIST}})
        elif method == "tools/call":
            params = req.get("params") or {}
            name = params.get("name", "")
            args = params.get("arguments", {})
            result = _call(name, args)
            _send({"jsonrpc": "2.0", "id": rid, "result": {
                "content": [{"type": "text", "text": json.dumps(result)}]}})
        elif method and method.startswith("notifications/"):
            pass
        elif rid is not None:
            _send({"jsonrpc": "2.0", "id": rid, "result": {}})


if __name__ == "__main__":
    main()
