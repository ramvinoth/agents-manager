"""viewer.claude_models — the selectable model list for a Claude session.

Claude Code has no "list models" command, but when it is pointed at an
Anthropic-compatible gateway (an LLM proxy, copilot-api, llama-server …) that
gateway serves an OpenAI-shaped `/v1/models` catalogue. Reading it means the
picker tracks whatever the gateway offers — a new model appears without a code
change — instead of the three hardcoded aliases the UI used to show.

Deliberately mirrors viewer.copilot.copilot_models: same host-aware signature,
same ~10-minute cache, same `[{"v","label"}]` shape, and the same contract that
it NEVER raises. An empty list is the normal answer for a session on a real
Anthropic login — there is no gateway to enumerate — and the UI falls back to
its built-in aliases in that case.

The endpoint comes from ~/.claude/settings.json, NOT the environment: engine.py
strips ANTHROPIC_* from the server's own env before driving a run, so the
settings file is the only authority for where a run will actually connect.
"""
import json
import os
import re
import time
import urllib.request

from viewer.remote import remote_run_python

_MODELS_CACHE = {}   # host -> (expires_ts, [{"v","label"}])
_MODELS_TTL = 600
_TIMEOUT = 15


def _pick_models(payload):
    """OpenAI-shaped catalogue -> [{"v","label"}], parsed liberally.

    Gateways disagree about the envelope: some return {"data":[…]}, some a bare
    list. Same tolerant read as routes/providers.py. Order is preserved as the
    gateway sent it — we never rank or filter ids here.
    """
    rows = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        return []
    out, seen = [], set()
    for r in rows:
        if not isinstance(r, dict):
            continue
        i = r.get("id")
        if not isinstance(i, str) or not i or i in seen:
            continue
        seen.add(i)
        out.append({"v": i, "label": r.get("display_name") or r.get("name") or i})
    return out


def _settings_endpoint(path):
    """(base_url, token) from a claude settings.json, or ("","") if it has none."""
    try:
        raw = re.sub(r"(?m)^\s*//.*$", "", open(path).read())
        env = (json.loads(raw) or {}).get("env") or {}
    except Exception:
        return "", ""
    base = (env.get("ANTHROPIC_BASE_URL") or "").rstrip("/")
    tok = env.get("ANTHROPIC_AUTH_TOKEN") or env.get("ANTHROPIC_API_KEY") or ""
    return base, tok


def _models_local():
    base, tok = _settings_endpoint(os.path.expanduser("~/.claude/settings.json"))
    if not base:
        return []
    hdr = {"Accept": "application/json"}
    if tok:
        # Both spellings: Anthropic-style gateways read x-api-key, OpenAI-style
        # ones read Authorization. Sending both costs nothing and avoids a 401
        # that would look like "no models".
        hdr["Authorization"] = "Bearer " + tok
        hdr["x-api-key"] = tok
    req = urllib.request.Request(base + "/v1/models", headers=hdr)
    return _pick_models(json.loads(urllib.request.urlopen(req, timeout=_TIMEOUT).read()))


# Same fetch on a remote host (the token stays on the host; only ids come back).
CLAUDE_MODELS_SCRIPT = r'''
import json, os, re, urllib.request
def run():
    try:
        raw = re.sub(r"(?m)^\s*//.*$", "", open(os.path.expanduser("~/.claude/settings.json")).read())
        env = (json.loads(raw) or {}).get("env") or {}
    except Exception:
        return []
    base = (env.get("ANTHROPIC_BASE_URL") or "").rstrip("/")
    if not base:
        return []
    tok = env.get("ANTHROPIC_AUTH_TOKEN") or env.get("ANTHROPIC_API_KEY") or ""
    hdr = {"Accept": "application/json"}
    if tok:
        hdr["Authorization"] = "Bearer " + tok
        hdr["x-api-key"] = tok
    try:
        req = urllib.request.Request(base + "/v1/models", headers=hdr)
        payload = json.loads(urllib.request.urlopen(req, timeout=15).read())
    except Exception:
        return []
    rows = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        return []
    out, seen = [], set()
    for r in rows:
        if not isinstance(r, dict):
            continue
        i = r.get("id")
        if not isinstance(i, str) or not i or i in seen:
            continue
        seen.add(i)
        out.append({"v": i, "label": r.get("display_name") or r.get("name") or i})
    return out
print(json.dumps(run()))
'''


def claude_models(host="local"):
    """Models the host's Claude gateway serves, cached ~10 min. [] when there is
    no gateway configured or it cannot be reached — never raises."""
    now = time.time()
    hit = _MODELS_CACHE.get(host)
    if hit and hit[0] > now:
        return hit[1]
    try:
        if host and host != "local":
            txt = remote_run_python(host, CLAUDE_MODELS_SCRIPT)
            models = json.loads(txt.strip().splitlines()[-1])
        else:
            models = _models_local()
        if not isinstance(models, list):
            models = []
    except Exception:
        models = []
    _MODELS_CACHE[host] = (now + _MODELS_TTL, models)
    return models
