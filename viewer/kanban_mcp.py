"""viewer.kanban_mcp — a stdio MCP server giving an agent-mode employee session a
`kanban` tool: it can create/move/assign cards on the ONE company board from
inside a turn, without leaving chat.

Mirrors permission_mcp.py exactly: this runs as a SEPARATE process (possibly on a
remote host over an SSH reverse tunnel), so it CANNOT import viewer.db. Each tool
is dumb transport — it POSTs the matching /api/org/* endpoint with the per-run
kanban token; ALL policy (responsibility scope, Green/Red gate, audit) lives
server-side in the route handler. Speaks newline-delimited JSON-RPC on stdout;
prints NOTHING to stdout except protocol messages.

Spawned by start_claude_run (engine.py) via the shared --mcp-config, with the
session + token + viewer base passed in the environment.
"""
import json
import os
import sys
import urllib.request

SESSION = os.environ.get("VIEWER_KANBAN_SESSION", "")
TOKEN = os.environ.get("VIEWER_KANBAN_TOKEN", "")
BASE = os.environ.get("VIEWER_KANBAN_BASE") or (
    "http://127.0.0.1:" + os.environ.get("VIEWER_KANBAN_PORT", "8091"))

# tool name -> (HTTP method, path). Kept in lockstep with viewer/routes/orchestrator.py.
_TOOLS = {
    "board_list":  ("GET", "/api/org/board"),
    "card_list":   ("GET", "/api/org/cards"),
    "card_create": ("POST", "/api/org/cards"),
    "card_move":   ("POST", "/api/org/cards/move"),
    "card_assign": ("POST", "/api/org/cards/assign"),
    "card_update": ("POST", "/api/org/cards/update"),
    "task_done":   ("POST", "/api/org/cards/done"),
}

_TOOL_LIST = [
    {"name": "board_list", "description": "List the board's columns.",
     "inputSchema": {"type": "object", "additionalProperties": False, "properties": {}}},
    {"name": "card_list", "description": "List cards, optionally filtered by session/project/assignee.",
     "inputSchema": {"type": "object", "additionalProperties": True, "properties": {
         "session": {"type": "string"}, "project": {"type": "integer"}, "assignee": {"type": "integer"}}}},
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
]


def _send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _call(tool, args):
    """Proxy a tool call to the viewer's /api/org endpoint. Returns the server's
    JSON (already the policy verdict — allowed / queued / denied)."""
    spec = _TOOLS.get(tool)
    if not spec:
        return {"error": f"unknown tool {tool}"}
    method, path = spec
    payload = dict(args or {})
    payload["session"] = SESSION
    payload["token"] = TOKEN
    url = BASE + path
    try:
        if method == "GET":
            # pass filters as query params; token/session go in headers for GET
            from urllib.parse import urlencode
            q = {k: v for k, v in payload.items() if k not in ("session", "token") and v is not None}
            if q:
                url += "?" + urlencode(q)
            req = urllib.request.Request(url, method="GET", headers={
                "X-Kanban-Session": SESSION, "X-Kanban-Token": TOKEN})
        else:
            req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                         headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"{}")
    except Exception as e:
        return {"error": f"viewer unreachable: {e}"}


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
                "serverInfo": {"name": "viewerkanban", "version": "1.0.0"}}})
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
