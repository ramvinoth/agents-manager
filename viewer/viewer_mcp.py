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
    "session_analysis": ("GET", "/api/session-analysis"),
    "chat_status":      ("GET", "/api/chat/status"),
    "host_list":        ("GET", "/api/hosts"),
    "project_list":     ("GET", "/api/org/projects"),
    "employee_list":    ("GET", "/api/org/employees"),
    "skill_list":       ("GET", "/api/org/skills"),
    "approval_list":    ("GET", "/api/org/approvals"),
    "audit_tail":       ("GET", "/api/org/audit"),
    "board_list":       ("GET", "/api/org/board"),
    "card_list":        ("GET", "/api/org/cards"),
    # ── Act on the board (writes; gated server-side) ────────────────────────
    "card_create":   ("POST", "/api/org/cards"),
    "card_move":     ("POST", "/api/org/cards/move"),
    "card_assign":   ("POST", "/api/org/cards/assign"),
    "card_update":   ("POST", "/api/org/cards/update"),
    "task_done":     ("POST", "/api/org/cards/done"),
    "skill_propose": ("POST", "/api/org/skills/propose"),
}

# Tools whose URL is completed at call time from an argument rather than being a
# fixed endpoint. Listed explicitly so _call never string-builds a path by accident.
_PATH_ARG = {"session_read": "session"}

# Board tools default to THIS session's project, so an agent's view of the board and
# the cards it creates stay inside the project it is working in. tool -> arg name,
# since the read routes take `project` and card_create takes `project_id`.
_PROJECT_DEFAULT = {"board_list": "project", "card_list": "project",
                    "card_create": "project_id"}

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
    {"name": "card_list", "description": "List cards in your project, optionally filtered by session/assignee.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "session": {"type": "string"}, "project": {"type": "integer"}, "assignee": {"type": "integer"}}}},
    # ── Act on the board ────────────────────────────────────────────────────
    {"name": "card_create", "description": "Create a card on the board (title required).",
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
    {"name": "task_done", "description": "Mark a card done (move to the Done column).",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["card_id"], "properties": {
         "card_id": {"type": "integer"}}}},
    {"name": "skill_propose", "description": "Propose a reusable skill learned from this work so the whole team inherits it. Novel skills are promoted immediately; ones that overlap an existing skill are queued for the owner to review.",
     "inputSchema": {"type": "object", "additionalProperties": True, "required": ["name", "trigger", "body"], "properties": {
         "name": {"type": "string", "description": "short kebab/underscore id"},
         "trigger": {"type": "string", "description": "when to use this skill (its description)"},
         "body": {"type": "string", "description": "the procedure/lesson"},
         "from_card": {"type": "integer"}}}},
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
