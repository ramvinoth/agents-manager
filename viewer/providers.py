"""Custom LLM provider presets (OpenAI-compatible endpoints, e.g. a llama-swap box).

A "provider" is a reusable, named connection to an OpenAI-compatible endpoint:
{id, name, baseUrl, model} plus a secret apiKey. A chat session opts into one by
storing the preset id in its session-meta ("provider"); the custom runner then
proxies that session's turns to {baseUrl}/v1/chat/completions.

Stored in the Postgres `providers` table. Mirrors hostenv.py's keys-vs-reveal
contract: the LIST view never returns apiKey; a separate reveal path
(get_api_key) returns it only for the runner / the server-side /v1/models fetch.
The key never leaves the box.
"""
import re
import uuid as _uuid

from viewer import db

_ID_RE = re.compile(r"[A-Za-z0-9_-]+$")


def valid_id(pid):
    return isinstance(pid, str) and len(pid) <= 128 and bool(_ID_RE.fullmatch(pid))


def _public(pid, rec):
    """The safe view of a preset — everything EXCEPT the apiKey."""
    return {
        "id": pid,
        "name": rec.get("name", ""),
        "baseUrl": rec.get("baseUrl", ""),
        "model": rec.get("model", ""),
        # The endpoint's real context window (engine --max-model-len). Optional; 0
        # means "unknown/unset" and no window is declared to Claude Code.
        "contextLimit": int(rec.get("contextLimit") or 0),
        # When True this provider is auto-selected for new sessions (falls back to
        # Built-in/Claude when no provider is marked default).
        "isDefault": bool(rec.get("isDefault")),
    }


# How much of the declared window Claude Code should hold back for OUTPUT, and an
# extra safety slack so the model's own +1 boundary rounding can never reach the
# engine's hard ceiling. See viewer.providers.anthropic_env for the derivation.
_OUTPUT_RESERVE = 32000
_CONTEXT_SLACK = 2000


def _declared_context(context_limit):
    """The window to DECLARE to Claude Code (CLAUDE_CODE_MAX_CONTEXT_TOKENS) for an
    endpoint whose real engine limit is `context_limit`. Pure + testable.

    Claude Code, for an unrecognized model id, budgets INPUT at (declared - output)
    and the request total can round up by ~1 at the boundary. Declaring the engine
    limit verbatim therefore lets total = input + output overshoot the engine's
    hard ceiling by that +1 (the exact bug seen: 242000 engine -> 242001 request).
    So we declare BELOW the engine limit, leaving room for the reserved output and
    a small slack. Returns 0 when there's no known limit (declare nothing)."""
    limit = int(context_limit or 0)
    if limit <= 0:
        return 0
    declared = limit - _OUTPUT_RESERVE - _CONTEXT_SLACK
    # Never go non-positive on a tiny/misconfigured limit; fall back to a safe floor.
    return declared if declared > _OUTPUT_RESERVE else max(limit - _CONTEXT_SLACK, 1)



def list_presets():
    """All presets as public dicts (no apiKey), sorted by name then id."""
    data = db.providers_load()
    out = [_public(pid, rec) for pid, rec in data.items() if isinstance(rec, dict)]
    defaults = db.setting_get("ai_defaults")
    if defaults:
        for row in out:
            row["isDefault"] = row["id"] == defaults["selection"]["provider"]
    out.sort(key=lambda p: (p["name"].lower(), p["id"]))
    return out


def get_preset(pid):
    """Full preset record INCLUDING apiKey (reveal path) — for the runner only."""
    if not pid:
        return None
    rec = db.providers_load().get(pid)
    return dict(rec) if isinstance(rec, dict) else None


def get_api_key(pid):
    rec = get_preset(pid)
    return (rec or {}).get("apiKey", "") if rec else ""


def anthropic_env(pid, model=None, preset=None):
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
    rec = preset if preset is not None else get_preset(pid)
    if not rec or not rec.get("baseUrl"):
        return None
    selected_model = rec.get("model", "") if model is None else model
    env = {
        "ANTHROPIC_BASE_URL": rec["baseUrl"],
        "ANTHROPIC_API_KEY": rec.get("apiKey", "") or "dummy_key",
        "ANTHROPIC_AUTH_TOKEN": "",
        "ANTHROPIC_MODEL": selected_model,
    }
    # Declare the context window so Claude Code compacts BEFORE the endpoint's hard
    # limit. For an unrecognized model id (our Qwen etc.) the docs say
    # CLAUDE_CODE_MAX_CONTEXT_TOKENS "applies directly and proactive compaction
    # continues at the declared window". Without this the harness assumes the
    # endpoint's own limit and overshoots it by ~1 (input+output boundary). The
    # window is a property of the model+provider, so it's derived from THIS preset's
    # contextLimit — not a per-session or global setting.
    declared = _declared_context(rec.get("contextLimit")) if selected_model == rec.get("model", "") else 0
    if declared:
        env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] = str(declared)
        env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = str(_OUTPUT_RESERVE)
    return env


def upsert_preset(pid, name, base_url, model, api_key=None, context_limit=None, is_default=None):
    """Create or update a preset. A blank id mints a new uuid4 id. When api_key is
    None the existing key is preserved (edit without re-typing the secret). When
    context_limit is None the existing value is preserved; pass 0 to clear it.
    When is_default is True, all OTHER presets are un-defaulted (at most one default).
    Returns the public view of the saved preset."""
    base_url = (base_url or "").strip().rstrip("/")
    if not re.match(r"https?://", base_url):
        raise ValueError("Base URL must start with http:// or https://")
    pid = (pid or "").strip()
    if pid and not valid_id(pid):
        raise ValueError("Provider id may contain only letters, digits, _ and -")
    if not pid:
        pid = _uuid.uuid4().hex[:12]
    prev = get_preset(pid) or {}
    rec = {
        "name": (name or "").strip() or base_url,
        "baseUrl": base_url,
        "model": (model or "").strip(),
        # Preserve the existing key when the caller didn't supply a new one.
        "apiKey": prev.get("apiKey", "") if api_key is None else str(api_key),
        # Preserve the existing context limit when unspecified; a supplied value
        # (including 0 to clear) wins.
        "contextLimit": int(prev.get("contextLimit") or 0) if context_limit is None
        else max(0, int(context_limit)),
        "isDefault": bool(prev.get("isDefault")) if is_default is None else bool(is_default),
    }
    # provider_upsert clears every other preset's default in the same transaction
    # when this one is the default, so at most one default survives.
    if is_default is None:
        db.provider_upsert(pid, rec)
    else:
        db.provider_upsert(pid, rec, default_change=bool(is_default))
    public = _public(pid, rec)
    defaults = db.setting_get("ai_defaults")
    if defaults:
        public["isDefault"] = pid == defaults["selection"]["provider"]
    return public



def delete_preset(pid):
    return db.provider_delete(pid)


def get_default_id():
    """Return the id of the preset marked isDefault, or "" if none."""
    defaults = db.setting_get("ai_defaults")
    if defaults:
        return defaults["selection"]["provider"]
    data = db.providers_load()
    for pid, rec in data.items():
        if isinstance(rec, dict) and rec.get("isDefault"):
            return pid
    return ""
