"""viewer.mcp_probe — ask an MCP server what it actually is.

The RHS panel's MCP list is built by reading config files (engine.capabilities);
it has never contacted a server. So a server that has been broken for weeks
renders exactly like a healthy one, and the "tools" the panel implies it knows
about are not tools at all — they are a command line.

This module does the one thing that config cannot: the real MCP handshake
(`initialize` -> `notifications/initialized` -> `tools/list`) and reports what
came back.

Two deliberate non-features:

- NO CACHE. A probe means "tell me the truth right now". A cached answer would
  reintroduce the exact dishonesty this module exists to remove.
- NOT AUTOMATIC. Probing a stdio server EXECUTES its configured command. That is
  not a new capability — the agent runs that same command every turn — but it
  must never happen as a side effect of opening a panel. Callers are the manual
  Test buttons only.

`probe()` never raises; every failure becomes a state + verbatim error text.
"""
import json
import os
import re
import shlex
import subprocess
import time
import urllib.error
import urllib.request

PROTOCOL_VERSION = "2024-11-05"
CLIENT_INFO = {"name": "agents-manager", "version": "1"}
DEFAULT_TIMEOUT = 15

#: "reachable but you are not logged in" is NOT the same as "broken", and saying
#: so would send the user to edit a config that is perfectly correct.
STATE_OK = "ok"
STATE_AUTH = "auth"
STATE_FAILED = "failed"


def _infer_transport(cfg):
    """Same inference engine.capabilities() already uses for the panel's badge,
    so a row cannot claim one transport and be probed as another."""
    t = (cfg.get("type") or "").strip().lower()
    if t in ("http", "sse", "streamable-http", "stdio"):
        return "stdio" if t == "stdio" else ("sse" if t == "sse" else "http")
    return "http" if cfg.get("url") else "stdio"


def _parse_frame(content_type, raw):
    """One JSON-RPC message out of an HTTP response body.

    Measured, not assumed: the same endpoint family answers in two envelopes.
    Phoenix replies `Content-Type: text/event-stream` with the payload on a
    `data:` line; other gateways reply plain JSON. Reading only one of the two
    would make half the working servers look broken.
    """
    if "text/event-stream" in (content_type or "").lower():
        for line in (raw or "").splitlines():
            if line.startswith("data:"):
                try:
                    return json.loads(line[5:].strip())
                except Exception:
                    continue
        return {}
    try:
        return json.loads(raw or "{}")
    except Exception:
        return {}


def _tool_rows(result):
    """result.tools -> [{"name","description"}], defensively.

    Descriptions are clipped: some servers ship paragraphs (this repo's own
    query_docs tool is ~2 KB) and the panel only ever shows a couple of lines.
    """
    tools = (result or {}).get("tools")
    if not isinstance(tools, list):
        return []
    out = []
    for t in tools:
        if not isinstance(t, dict):
            continue
        name = t.get("name")
        if not isinstance(name, str) or not name:
            continue
        desc = t.get("description")
        out.append({"name": name,
                    "description": (desc[:400] if isinstance(desc, str) else "")})
    return out


def _server_info(result):
    si = (result or {}).get("serverInfo")
    if not isinstance(si, dict):
        return {}
    return {"name": str(si.get("name") or ""), "version": str(si.get("version") or "")}


def _result(name, transport, state, started, error="", tools=None, server=None, detail=""):
    return {"name": name, "transport": transport, "state": state,
            "error": error, "detail": detail, "tools": tools or [],
            "server": server or {}, "elapsed_ms": int((time.time() - started) * 1000)}


# ---- stdio -----------------------------------------------------------------

def _stdio_command(cfg):
    parts = [cfg.get("command") or ""] + [str(a) for a in (cfg.get("args") or [])]
    return " ".join(shlex.quote(p) for p in parts if p)


def _probe_stdio(name, cfg, cwd, timeout, started):
    cmd = _stdio_command(cfg)
    if not cmd:
        return _result(name, "stdio", STATE_FAILED, started,
                       error="No command configured for this server.")
    env = dict(os.environ)
    for k, v in (cfg.get("env") or {}).items():
        env[str(k)] = str(v)
    # `bash -lc`, not a bare exec: measured — a real config here resolves `uv`
    # only through a login shell, and it is how engine.py drives every other
    # host command, so the probe sees the same PATH a run would.
    # start_new_session so a hung server's children die with the group, not
    # orphaned holding the pipe open past our timeout.
    try:
        p = subprocess.Popen(
            ["bash", "-lc", cmd], cwd=cwd or None, env=env, text=True,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True)
    except Exception as e:
        return _result(name, "stdio", STATE_FAILED, started, error=f"{type(e).__name__}: {e}")

    lines = [
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
            "clientInfo": CLIENT_INFO}}),
        json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
    ]
    try:
        out, err = p.communicate("\n".join(lines) + "\n", timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_group(p)
        out, err = p.communicate()
        return _result(name, "stdio", STATE_FAILED, started,
                       error=f"No response within {timeout}s.", detail=_tail(err))
    except Exception as e:
        _kill_group(p)
        return _result(name, "stdio", STATE_FAILED, started, error=f"{type(e).__name__}: {e}")

    server, tools, saw_reply = {}, [], False
    for line in (out or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue  # servers that chat on stdout; only JSON-RPC frames count
        res = msg.get("result")
        if not isinstance(res, dict):
            continue
        saw_reply = True
        if msg.get("id") == 1:
            server = _server_info(res)
        elif msg.get("id") == 2:
            tools = _tool_rows(res)
    if not saw_reply:
        # The interesting text is on stderr — a real broken server here says
        # "Failed to spawn: ... No such file or directory", which names the
        # exact fix. A generic "connection failed" would throw that away.
        return _result(name, "stdio", STATE_FAILED, started,
                       error=_tail(err) or f"Server exited ({p.returncode}) without a response.")
    return _result(name, "stdio", STATE_OK, started, tools=tools, server=server)


def _kill_group(p):
    try:
        os.killpg(os.getpgid(p.pid), 9)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass


def _tail(text, limit=1200):
    text = (text or "").strip()
    return text[-limit:] if len(text) > limit else text


# ---- http / sse ------------------------------------------------------------

def _probe_http(name, cfg, transport, timeout, started):
    url = (cfg.get("url") or "").strip()
    if not url:
        return _result(name, transport, STATE_FAILED, started,
                       error="No url configured for this server.")
    headers = {"Content-Type": "application/json",
               "Accept": "application/json, text/event-stream"}
    for k, v in (cfg.get("headers") or {}).items():
        headers[str(k)] = str(v)
    session = {}

    def post(body):
        h = dict(headers)
        if session.get("id"):
            h["Mcp-Session-Id"] = session["id"]
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=h)
        r = urllib.request.urlopen(req, timeout=timeout)
        if r.headers.get("Mcp-Session-Id"):
            session["id"] = r.headers["Mcp-Session-Id"]
        return _parse_frame(r.headers.get("Content-Type"), r.read().decode("utf-8", "replace"))

    try:
        init = post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
            "clientInfo": CLIENT_INFO}})
    except urllib.error.HTTPError as e:
        return _http_error(name, transport, started, e)
    except Exception as e:
        return _result(name, transport, STATE_FAILED, started, error=f"{type(e).__name__}: {e}")

    if init.get("error"):
        return _result(name, transport, STATE_FAILED, started,
                       error=_rpc_error(init["error"]))
    server = _server_info(init.get("result"))
    try:
        # Spec-required, but servers disagree about whether a notification may
        # be answered with a body; a failure here must not fail the probe.
        post({"jsonrpc": "2.0", "method": "notifications/initialized"})
    except Exception:
        pass
    try:
        listed = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    except urllib.error.HTTPError as e:
        return _http_error(name, transport, started, e)
    except Exception as e:
        return _result(name, transport, STATE_FAILED, started,
                       error=f"{type(e).__name__}: {e}", server=server)
    if listed.get("error"):
        return _result(name, transport, STATE_FAILED, started,
                       error=_rpc_error(listed["error"]), server=server)
    return _result(name, transport, STATE_OK, started,
                   tools=_tool_rows(listed.get("result")), server=server)


def _rpc_error(err):
    if isinstance(err, dict):
        return f"{err.get('message') or 'JSON-RPC error'} (code {err.get('code')})"
    return str(err)


def _http_error(name, transport, started, e):
    """401/403 -> `auth`, everything else -> `failed`.

    Measured: an OAuth-gated server answers 401 with
    `WWW-Authenticate: Bearer resource_metadata="https://.../.well-known/..."`.
    That server is up and its config is right — the fix is a login, so it must
    not be shown in the same red as a typo'd command.
    """
    challenge = e.headers.get("WWW-Authenticate") if e.headers else ""
    if e.code in (401, 403):
        return _result(name, transport, STATE_AUTH, started,
                       error=f"HTTP {e.code} {e.reason}", detail=_auth_hint(challenge))
    return _result(name, transport, STATE_FAILED, started,
                   error=f"HTTP {e.code} {e.reason}", detail=_tail(_read_error(e), 400))


def _auth_hint(challenge):
    m = re.search(r'resource_metadata="([^"]+)"', challenge or "")
    return m.group(1) if m else (challenge or "")


def _read_error(e):
    try:
        return e.read().decode("utf-8", "replace")
    except Exception:
        return ""


# ---- entry point -----------------------------------------------------------

def probe(name, cfg, cwd="", timeout=DEFAULT_TIMEOUT):
    """Handshake with one configured MCP server. Never raises.

    Returns {name, transport, state, error, detail, tools, server, elapsed_ms}
    where state is 'ok' | 'auth' | 'failed'. ('unknown' is the UI's word for a
    server nobody has tested; the backend never invents it.)
    """
    started = time.time()
    if not isinstance(cfg, dict):
        return _result(name, "", STATE_FAILED, started, error="Server config is not an object.")
    transport = _infer_transport(cfg)
    try:
        if transport == "stdio":
            return _probe_stdio(name, cfg, cwd, timeout, started)
        return _probe_http(name, cfg, transport, timeout, started)
    except Exception as e:  # belt and braces: a probe must never 500 the panel
        return _result(name, transport, STATE_FAILED, started, error=f"{type(e).__name__}: {e}")
