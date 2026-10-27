"""viewer.turn — start one turn in a local Claude-harness session.

The ONE place that turns "send this message to session X" into a running job:
resolve the session's AI selection (custom OpenAI-compatible provider in chat
mode, custom Anthropic-compatible endpoint in agent mode, or the normal Claude
run), then launch the matching runner. /api/chat and the call brain both go
through here so a call can never launch a session differently than the chat
composer would.
"""
from viewer import ai, db, providers
from viewer.engine import start_claude_run


def start_turn(session_id, message, mode, cwd, model="", host="local"):
    """Launch `message` as the next turn of `session_id`.

    Returns None when the run started, or an (http_status, error_text) pair the
    caller can surface: 400 for an unusable AI selection, 409 when the session
    already has a running job."""
    try:
        resolved = ai.resolve(db.session_meta_get(session_id) or {}, model, host)
    except ValueError as exc:
        return 400, str(exc)
    preset_id, model, effort = (resolved[k] for k in ("provider", "model", "effort"))
    busy = (409, "A message is already being processed for this session")
    provider_env = None
    if preset_id:
        if resolved["convMode"] == "agent":
            provider_env = providers.anthropic_env(preset_id, model=model, preset=resolved["preset"])
        else:
            from viewer.customrun import start_custom_run
            if not start_custom_run(session_id, preset_id, message, cwd, host, mode,
                                    model=model, preset=resolved["preset"]):
                return busy
            return None
    if not start_claude_run(session_id, ["--resume", session_id], message, mode, cwd,
                            "" if provider_env else model, host, provider_env=provider_env,
                            effort=effort):
        return busy
    return None
