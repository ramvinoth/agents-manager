"""Custom LLM provider presets (OpenAI-compatible endpoints, e.g. a llama-swap box).

A "provider" is a reusable, named CONNECTION to an OpenAI-compatible endpoint:
{id, name, baseUrl, model (the connection's default model)} plus a secret apiKey.
One connection serves every model its endpoint lists. A context window is a fact
about a MODEL, so it lives per model in `modelLimits` ({model: {discovered,
maxOutput, override}}): `discovered` is cached from the endpoint's /v1/models
metadata, `override` is the owner's correction and wins. A chat session opts into one by
storing the preset id in its session-meta ("provider"); the custom runner then
proxies that session's turns to {baseUrl}/v1/chat/completions.

Stored in the Postgres `providers` table. Mirrors hostenv.py's keys-vs-reveal
contract: the LIST view never returns apiKey; a separate reveal path
(get_api_key) returns it only for the runner / the server-side /v1/models fetch.
The key never leaves the box.
"""
import re
import uuid as _uuid

from viewer import db, inference_health

_ID_RE = re.compile(r"[A-Za-z0-9_-]+$")


def valid_id(pid):
    return isinstance(pid, str) and len(pid) <= 128 and bool(_ID_RE.fullmatch(pid))


def _limits(rec):
    raw = rec.get("modelLimits")
    return {m: v for m, v in raw.items() if isinstance(v, dict)} if isinstance(raw, dict) else {}


def context_window(rec, model):
    """The real context window (tokens) of `model` on this connection: the owner's
    override, else the endpoint's discovered value, else 0 (unknown)."""
    facts = _limits(rec).get(model) or {}
    return int(facts.get("override") or 0) or int(facts.get("discovered") or 0)


def model_rows(rec):
    """The connection's known models (its default first, then by id), each with
    its effective window and where that number came from."""
    limits = _limits(rec)
    default = rec.get("model", "")
    ids = sorted(set(limits) | ({default} if default else set()), key=lambda m: (m != default, m))
    rows = []
    for m in ids:
        facts = limits.get(m, {})
        override, discovered = int(facts.get("override") or 0), int(facts.get("discovered") or 0)
        rows.append({"id": m, "contextWindow": override or discovered,
                     "source": "override" if override else "discovered" if discovered else "",
                     "discovered": discovered, "override": override,
                     "maxOutput": int(facts.get("maxOutput") or 0)})
    return rows


def _public(pid, rec):
    """The safe view of a preset — everything EXCEPT the apiKey."""
    return {
        "id": pid,
        "name": rec.get("name", ""),
        "baseUrl": rec.get("baseUrl", ""),
        "model": rec.get("model", ""),
        "models": model_rows(rec),
        # Legacy read field for clients that predate per-model limits: the
        # default model's effective window.
        "contextLimit": context_window(rec, rec.get("model", "")),
        # When True this provider is auto-selected for new sessions (falls back to
        # Built-in/Claude when no provider is marked default).
        "isDefault": bool(rec.get("isDefault")),
    }


# How much of the declared window Claude Code should hold back for OUTPUT, and an
# extra safety slack so the model's own +1 boundary rounding can never reach the
# engine's hard ceiling. See viewer.providers.anthropic_env for the derivation.
_OUTPUT_RESERVE = 32000
_CONTEXT_SLACK = 2000


def _declared_context(context_limit, output=_OUTPUT_RESERVE):
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
    declared = limit - output - _CONTEXT_SLACK
    # Never go non-positive on a tiny/misconfigured limit; fall back to a safe floor.
    return declared if declared > output else max(limit - _CONTEXT_SLACK, 1)



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
        # Few CLI retries: liveness is judged by inference_health.Watch, not by
        # retrying a dead or overloaded endpoint ten times with backoff.
        "CLAUDE_CODE_MAX_RETRIES": inference_health.MAX_RETRIES,
    }
    # Declare the context window so Claude Code compacts BEFORE the endpoint's hard
    # limit. For an unrecognized model id (our Qwen etc.) the docs say
    # CLAUDE_CODE_MAX_CONTEXT_TOKENS "applies directly and proactive compaction
    # continues at the declared window". Without this the harness assumes the
    # endpoint's own limit and overshoots it by ~1 (input+output boundary). The
    # window is a property of the MODEL on this connection, so it is resolved for
    # whichever model this run selected — not a per-session or global setting.
    max_output = int((_limits(rec).get(selected_model) or {}).get("maxOutput") or 0)
    output = min(_OUTPUT_RESERVE, max_output) if max_output else _OUTPUT_RESERVE
    declared = _declared_context(context_window(rec, selected_model), output)
    if declared:
        env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] = str(declared)
        env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = str(output)
    return env


def _clean_overrides(overrides):
    if not isinstance(overrides, dict):
        raise ValueError("modelOverrides must map model ids to token counts")
    out = {}
    for m, n in overrides.items():
        if not isinstance(m, str) or not m.strip() or len(m) > 256 or type(n) is not int or n < 0:
            raise ValueError("Invalid model override")
        out[m.strip()] = n
    return out


def upsert_preset(pid, name, base_url, model, api_key=None, context_limit=None, is_default=None,
                  model_overrides=None):
    """Create or update a preset. A blank id mints a new uuid4 id. When api_key is
    None the existing key is preserved (edit without re-typing the secret).
    `model_overrides` ({model: tokens}, 0 clears) replaces the owner's context
    overrides; discovered facts are kept. `context_limit` is the legacy single
    field: it sets (0 clears) the DEFAULT model's override. None keeps either.
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
    model = (model or "").strip()
    limits = {m: dict(v) for m, v in _limits(prev).items()}
    # Discovered facts belong to the endpoint they came from.
    if prev and base_url != (prev.get("baseUrl") or "").rstrip("/"):
        limits = {m: {"override": v["override"]} for m, v in limits.items() if v.get("override")}
    overrides = None
    if model_overrides is not None:
        overrides = _clean_overrides(model_overrides)
        for facts in limits.values():
            facts.pop("override", None)
    if context_limit is not None and model:
        overrides = {**(overrides or {}), model: max(0, int(context_limit))}
    for m, n in (overrides or {}).items():
        facts = limits.setdefault(m, {})
        if n:
            facts["override"] = n
        else:
            facts.pop("override", None)
    rec = {
        "name": (name or "").strip() or base_url,
        "baseUrl": base_url,
        "model": model,
        # Preserve the existing key when the caller didn't supply a new one.
        "apiKey": prev.get("apiKey", "") if api_key is None else str(api_key),
        "isDefault": bool(prev.get("isDefault")) if is_default is None else bool(is_default),
        "modelLimits": {m: v for m, v in limits.items() if v},
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


def remember_discovered(pid, facts):
    """Cache what the endpoint itself reports ({model: {discovered, maxOutput}})
    on a saved connection, so a launch can declare the window with no network
    call. Owner overrides are untouched; models the endpoint stopped listing keep
    only their override. Returns the updated record (None if unknown)."""
    rec = get_preset(pid)
    if not rec:
        return None
    limits = {}
    for m, v in _limits(rec).items():
        if v.get("override"):
            limits[m] = {"override": v["override"]}
    for m, f in facts.items():
        merged = {**limits.get(m, {}), **{k: n for k, n in f.items() if n}}
        if merged:
            limits[m] = merged
    if limits != _limits(rec):
        db.provider_limits_set(pid, limits)
    return {**rec, "modelLimits": limits}


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
