"""viewer.permission_mcp — a tiny stdio MCP server used as claude's
`--permission-prompt-tool`.

When a driven `claude -p` run wants to use a tool that needs approval, the CLI
calls this server's `approve` tool with `{tool_name, input, tool_use_id}`. We
forward that to the viewer backend, which surfaces an Allow/Deny prompt in the UI
and blocks until the user decides; the decision comes back as
`{"behavior":"allow"|"deny", ...}` (the contract confirmed against claude 2.1.220).

Spawned by `start_claude_run` (engine.py) via `--mcp-config`, with the session,
port and a per-run token passed in the environment. Speaks newline-delimited
JSON-RPC on stdio; must print NOTHING to stdout except protocol messages.
"""
import json
import os
import sys
import urllib.request

SESSION = os.environ.get("VIEWER_PERM_SESSION", "")
TOKEN = os.environ.get("VIEWER_PERM_TOKEN", "")
# Base URL of the viewer to call back to. Local runs use 127.0.0.1; a remote host
# gets an explicit tailnet/public base (VIEWER_PERM_BASE) it can actually reach.
BASE = os.environ.get("VIEWER_PERM_BASE") or (
    "http://127.0.0.1:" + os.environ.get("VIEWER_PERM_PORT", "8091"))


def _send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _decide(args):
    """Ask the viewer (which asks the user). Returns a claude permission decision."""
    tinput = args.get("input", {})
    payload = json.dumps({
        "session": SESSION,
        "token": TOKEN,
        "tool_name": args.get("tool_name", ""),
        "input": tinput,
        "tool_use_id": args.get("tool_use_id", ""),
    }).encode()
    try:
        req = urllib.request.Request(
            BASE + "/api/chat/permission", data=payload,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=3600) as r:
            res = json.loads(r.read() or b"{}")
        if res.get("behavior") == "allow":
            return {"behavior": "allow", "updatedInput": tinput}
        return {"behavior": "deny", "message": res.get("message") or "Denied in viewer"}
    except Exception as e:
        return {"behavior": "deny", "message": f"viewer unreachable: {e}"}


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
                "serverInfo": {"name": "viewerperm", "version": "1.0.0"}}})
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": rid, "result": {"tools": [{
                "name": "approve",
                "description": "Approve or deny a tool call, via the viewer UI.",
                "inputSchema": {"type": "object", "additionalProperties": True}}]}})
        elif method == "tools/call":
            args = (req.get("params") or {}).get("arguments", {})
            _send({"jsonrpc": "2.0", "id": rid, "result": {
                "content": [{"type": "text", "text": json.dumps(_decide(args))}]}})
        elif method and method.startswith("notifications/"):
            pass
        elif rid is not None:
            _send({"jsonrpc": "2.0", "id": rid, "result": {}})


if __name__ == "__main__":
    main()
