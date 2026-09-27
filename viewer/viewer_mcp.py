"""viewer.viewer_mcp — the stdio MCP server that gives an agent session the viewer.

Two tiers, one transport:

- **See everything** (read-only): the fleet's sessions, their transcripts and
  analyses, the board, the org, the audit trail. An agent can find out what is
  happening on this machine without being able to change any of it.
- **Act on the board** (writes): create/move/assign cards, mark work done, propose
  a learned skill.

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
    "docs_list":        ("GET", "/api/org/docs"),
    "docs_read":        ("GET", "/api/org/docs/read"),
    "approval_list":    ("GET", "/api/org/approvals"),
    "audit_tail":       ("GET", "/api/org/audit"),
    "board_list":       ("GET", "/api/org/board"),
    "card_list":        ("GET", "/api/org/cards"),
    "card":             ("GET", "/api/org/card"),
    "card_comments":    ("GET", "/api/org/card_comments"),
    "card_deps":        ("GET", "/api/org/card_deps"),
    "note_list":        ("GET", "/api/org/notes"),
    "note":             ("GET", "/api/org/note"),
    "loop_list":        ("GET", "/api/loops"),
    "loop_control_get": ("GET", "/api/org/loop-control"),
    "inbox_list":       ("GET", "/api/inbox"),
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
    "skill_propose": ("POST", "/api/org/skills/propose"),
    "session_seen":  ("POST", "/api/session/seen"),
    "session_mode_set": ("POST", "/api/session/mode"),
    "inbox_send":    ("POST", "/api/inbox/send"),
    # ── Schedule recurring work (writes; gated + self-mutation rail server-side)
    "loop_create":   ("POST", "/api/org/loops"),
    "loop_update":   ("POST", "/api/org/loops/update"),
    "loop_delete":   ("POST", "/api/org/loops/delete"),
    "loop_control_set": ("POST", "/api/org/loop-control"),
}

# Tools whose URL is completed at call time from an argument rather than being a
# fixed endpoint. Listed explicitly so _call never string-builds a path by accident.
_PATH_ARG = {"session_read": "session"}

# Board READ tools default to THIS session's project, so an agent's view of the
# board stays inside the project it is working in. card_create is NOT here: the
# create route resolves the card's project from the session itself (the one rule
# in routes.orchestrator), so the MCP never carries a second copy of it.
_PROJECT_DEFAULT = {"board_list": "project", "card_list": "project", "note_list": "project"}

_HOST_ARG = {"type": "string",
             "description": "Host id from host_list; omit for this machine."}

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
    {"name": "skill_list", "description": "The team's learned-skill library.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {}}},
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
    {"name": "note_create", "description": "Create a note (markdown). kind: note | journal | meeting | idea | checklist. Notes you create are owned by you and scoped to this session and its project; they archive when the chat is archived and go when it is deleted.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["title"], "properties": {
         "title": {"type": "string"}, "body": {"type": "string"}, "kind": {"type": "string"},
         "project_id": {"type": "integer"}, "pinned": {"type": "boolean"}}}},
    {"name": "note_update", "description": "Edit a note's title/body/kind, pin it, or archive/unarchive it.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["note_id"], "properties": {
         "note_id": {"type": "integer"}, "title": {"type": "string"}, "body": {"type": "string"},
         "kind": {"type": "string"}, "pinned": {"type": "boolean"}, "archived": {"type": "boolean"}}}},
    {"name": "note_delete", "description": "Delete a note. Irreversible, so it queues for the owner's approval; prefer note_update archived=true.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["note_id"], "properties": {
         "note_id": {"type": "integer"}}}},
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
     "description": "Your inbox: the messages addressed to your session (from the owner or other sessions) and the ones you sent to the owner, newest first. A row can carry a decision (kind: message | question | plan | approval | card) with its LIVE state — open/resolved, read/snoozed — derived at read time; the deciding tap itself stays in the chat UI, the inbox only tells you what is waiting and what the owner said. Read it on a wake and before you act. Filter with kind.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "kind": {"type": "string", "enum": ["message", "question", "plan", "approval", "card"]}}}},
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
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["id"], "properties": {
         "id": {"type": "string", "description": "Loop id from loop_list."}}}},
    {"name": "loop_control_set",
     "description": "Set WHICH loop origins may fire: user (human-scheduled only), harman (agent-scheduled only), both, or none. Manager-scoped; setting it does not touch the automation master switch.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["mode"], "properties": {
         "mode": {"type": "string", "enum": ["user", "harman", "both", "none"]}}}},
    # ── Delegate trust to a session (Red: queues for the owner) ─────────────
    {"name": "session_mode_set",
     "description": "Set the permission mode a session's runs start in: default (every tool gated), acceptEdits (file edits auto-approve, commands still gated), plan, or bypass (no gating at all — runs start with --dangerously-skip-permissions). It applies to EVERY later run of that session (loop-fired AND chat) — the way a trusted agent runs its loops without a command-approval push per Bash. Red: the request queues for the owner's approval and runs once he approves; a model can never set its OWN session (the server refuses it — trust is granted by the person, not requested by the agent).",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["for_session", "mode"], "properties": {
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
    except Exception as e:
        return {"error": f"viewer unreachable: {e}"}
    try:
        return json.loads(body)
    except ValueError:
        # A transcript read streams raw JSONL, not one JSON document. Hand it back
        # as text rather than failing the tool call on a successful response.
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
