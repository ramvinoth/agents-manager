"""Custom LLM provider presets (OpenAI-compatible endpoints, e.g. a llama-swap box).

A "provider" is a reusable, named connection to an OpenAI-compatible endpoint:
{id, name, baseUrl, model} plus a secret apiKey. A chat session opts into one by
storing the preset id in its session-meta ("provider"); the custom runner then
proxies that session's turns to {baseUrl}/v1/chat/completions.

Stored in ~/.claude/.viewer-providers.json (chmod 600). Mirrors hostenv.py's
keys-vs-reveal contract: the LIST view never returns apiKey; a separate reveal
path (get_api_key) returns it only for the runner / the server-side /v1/models
fetch. The key never leaves the box.
"""
import json
import os
import re
import threading
import uuid as _uuid
from pathlib import Path

PROVIDERS_FILE = Path.home() / ".claude" / ".viewer-providers.json"
_LOCK = threading.Lock()
_ID_RE = re.compile(r"[A-Za-z0-9_-]+$")


def _load():
    try:
        return json.loads(PROVIDERS_FILE.read_text()) if PROVIDERS_FILE.exists() else {}
    except Exception:
        return {}


def _save(data):
    tmp = PROVIDERS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    os.replace(tmp, PROVIDERS_FILE)
    try:
        os.chmod(PROVIDERS_FILE, 0o600)
    except OSError:
        pass


def valid_id(pid):
    return bool(_ID_RE.match(pid or ""))


def _public(pid, rec):
    """The safe view of a preset — everything EXCEPT the apiKey."""
    return {
        "id": pid,
        "name": rec.get("name", ""),
        "baseUrl": rec.get("baseUrl", ""),
        "model": rec.get("model", ""),
    }


def list_presets():
    """All presets as public dicts (no apiKey), sorted by name then id."""
    with _LOCK:
        data = _load()
    out = [_public(pid, rec) for pid, rec in data.items() if isinstance(rec, dict)]
    out.sort(key=lambda p: (p["name"].lower(), p["id"]))
    return out


def get_preset(pid):
    """Full preset record INCLUDING apiKey (reveal path) — for the runner only."""
    if not pid:
        return None
    with _LOCK:
        rec = _load().get(pid)
    return dict(rec) if isinstance(rec, dict) else None


def get_api_key(pid):
    rec = get_preset(pid)
    return (rec or {}).get("apiKey", "") if rec else ""


def anthropic_env(pid):
    """Agent mode: the ANTHROPIC_* env that points the Claude Code harness at this
    preset's endpoint (our llama-server, which serves the Anthropic Messages API).
    Returns None when the preset is missing/incomplete so the caller falls back.

    Claude Code requires ANTHROPIC_API_KEY (not AUTH_TOKEN) to authenticate against
    a custom ANTHROPIC_BASE_URL, and setting it is what makes the CLI use that
    endpoint instead of falling back to OAuth. We also blank ANTHROPIC_AUTH_TOKEN so
    an inherited proxy token (e.g. a LiteLLM token in the shell / user settings)
    can't leak and redirect requests. The caller applies these via a `--settings`
    file's env block, which overrides the user's ~/.claude/settings.json — plain
    process env vars do NOT (settings.json wins over them)."""
    rec = get_preset(pid)
    if not rec or not rec.get("baseUrl"):
        return None
    return {
        "ANTHROPIC_BASE_URL": rec["baseUrl"],
        "ANTHROPIC_API_KEY": rec.get("apiKey", "") or "dummy_key",
        "ANTHROPIC_AUTH_TOKEN": "",
        "ANTHROPIC_MODEL": rec.get("model", ""),
    }


def upsert_preset(pid, name, base_url, model, api_key=None):
    """Create or update a preset. A blank id mints a new uuid4 id. When api_key is
    None the existing key is preserved (edit without re-typing the secret).
    Returns the public view of the saved preset."""
    base_url = (base_url or "").strip().rstrip("/")
    if not re.match(r"https?://", base_url):
        raise ValueError("Base URL must start with http:// or https://")
    pid = (pid or "").strip()
    if pid and not valid_id(pid):
        raise ValueError("Provider id may contain only letters, digits, _ and -")
    with _LOCK:
        data = _load()
        if not pid:
            pid = _uuid.uuid4().hex[:12]
        prev = data.get(pid) if isinstance(data.get(pid), dict) else {}
        rec = {
            "name": (name or "").strip() or base_url,
            "baseUrl": base_url,
            "model": (model or "").strip(),
            # Preserve the existing key when the caller didn't supply a new one.
            "apiKey": prev.get("apiKey", "") if api_key is None else str(api_key),
        }
        data[pid] = rec
        _save(data)
    return _public(pid, rec)


def delete_preset(pid):
    with _LOCK:
        data = _load()
        existed = data.pop(pid, None) is not None
        if existed:
            _save(data)
    return existed
