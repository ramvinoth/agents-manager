"""Per-host environment variables (e.g. GH_TOKEN so an agent can authenticate).

Stored in the Postgres `host_env` table as (host, key, value) rows — "local" is
a valid host id. Injected into that host's terminal PTY (and, later, agent runs).
Values are secrets: the list endpoint returns only KEYS; a separate reveal
endpoint returns a single value on demand.
"""
import re

from viewer import db

_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*$")


def valid_key(k):
    return bool(_KEY_RE.match(k or ""))


def host_env(hid):
    """The {KEY: VALUE} map for a host id (empty if none) — used for injection."""
    d = db.host_env_load(hid or "local")
    return {str(k): str(v) for k, v in d.items() if isinstance(k, str) and valid_key(k)}


def list_keys(hid):
    return sorted(host_env(hid).keys())


def get_value(hid, key):
    return host_env(hid).get(key)


def set_var(hid, key, value):
    key = (key or "").strip()
    if not valid_key(key):
        raise ValueError("Key must start with a letter or _ and contain only A–Z, 0–9, _")
    db.host_env_set(hid or "local", key, str(value))


def unset_var(hid, key):
    db.host_env_unset(hid or "local", key)


def unset_host(hid):
    """Drop all vars for a host (called when the host is deleted). No-op for local."""
    if not hid or hid == "local":
        return
    db.host_env_unset_all(hid)
