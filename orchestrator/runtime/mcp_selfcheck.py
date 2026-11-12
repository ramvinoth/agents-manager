"""Prove the MCP servers every driven claude run loads actually start and list their tools.

The maintenance preflight runs this against the code ON DISK (`python -m
orchestrator.runtime.mcp_selfcheck`) before restarting. A spare server answering
GET / proves the web app boots; it says nothing about these stdio servers. On
2026-11-10 a package rename left the config pointing at missing scripts: the server
booted fine, and every chat's tool calls then died with "mcp__viewerperm__approve
not found". Exit 0 when every server lists its required tool; otherwise exit 1 and
print what failed.
"""
import json
import subprocess
import sys

from orchestrator.runtime.run_config import REQUIRED_MCP_TOOLS, perm_mcp_servers

TIMEOUT = 20


def probe(name, spec, timeout=TIMEOUT):
    """Start one stdio server, send initialize + tools/list. Returns None when its
    required tool is listed, else a one-line reason."""
    msgs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "preflight", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    stdin = "".join(json.dumps(m) + "\n" for m in msgs)
    try:
        out = subprocess.run([spec["command"], *spec["args"]], input=stdin, capture_output=True,
                             text=True, timeout=timeout, env=spec.get("env")).stdout
    except (OSError, subprocess.TimeoutExpired) as e:
        return f"{name}: did not run ({e})"
    for line in out.splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            return f"{name}: printed non-protocol output on stdout: {line[:120]}"
        if msg.get("id") == 2:
            tools = {t.get("name") for t in (msg.get("result") or {}).get("tools", [])}
            want = REQUIRED_MCP_TOOLS[name]
            return None if want in tools else f"{name}: tools/list lacks '{want}'"
    return f"{name}: no tools/list reply (stdout: {out[-200:]!r})"


def main():
    servers = perm_mcp_servers()
    missing = set(REQUIRED_MCP_TOOLS) - set(servers)
    fails = [f"{n}: not in the run config" for n in sorted(missing)]
    fails += [r for n, s in servers.items() if n in REQUIRED_MCP_TOOLS and (r := probe(n, s))]
    print("\n".join(fails) or "mcp servers ok: " + ", ".join(sorted(servers)))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
