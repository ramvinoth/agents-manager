"""Per-host environment variables (e.g. GH_TOKEN so an agent can authenticate).

Stored in ~/.claude/.viewer-env.json (chmod 600, alongside the hosts config) as
{host_id: {KEY: VALUE}} — "local" is a valid host id. Injected into that host's
terminal PTY (and, later, agent runs). Values are secrets: the list endpoint
returns only KEYS; a separate reveal endpoint returns a single value on demand.
"""
import json
import os
import re
import threading
from pathlib import Path

ENV_FILE = Path.home() / ".claude" / ".viewer-env.json"
_LOCK = threading.Lock()
_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*$")


def _load():
    try:
        return json.loads(ENV_FILE.read_text()) if ENV_FILE.exists() else {}
    except Exception:
        return {}


def _save(data):
    ENV_FILE.write_text(json.dumps(data, indent=2))
    try:
        os.chmod(ENV_FILE, 0o600)
    except OSError:
        pass


def valid_key(k):
    return bool(_KEY_RE.match(k or ""))


def host_env(hid):
    """The {KEY: VALUE} map for a host id (empty if none) — used for injection."""
    with _LOCK:
        d = _load().get(hid or "local") or {}
    return {str(k): str(v) for k, v in d.items() if isinstance(k, str) and valid_key(k)}


def list_keys(hid):
    return sorted(host_env(hid).keys())


def get_value(hid, key):
    return host_env(hid).get(key)


def set_var(hid, key, value):
    key = (key or "").strip()
    if not valid_key(key):
        raise ValueError("Key must start with a letter or _ and contain only A–Z, 0–9, _")
    with _LOCK:
        d = _load()
        d.setdefault(hid or "local", {})[key] = str(value)
        _save(d)


def unset_var(hid, key):
    with _LOCK:
        d = _load()
        bucket = d.get(hid or "local")
        if bucket:
            bucket.pop(key, None)
            if not bucket:
                d.pop(hid or "local", None)
            _save(d)


def unset_host(hid):
    """Drop all vars for a host (called when the host is deleted). No-op for local."""
    if not hid or hid == "local":
        return
    with _LOCK:
        d = _load()
        if d.pop(hid, None) is not None:
            _save(d)
