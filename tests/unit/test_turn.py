"""viewer.turn.start_turn — the single launch path shared by /api/chat and the
call brain. Every branch is exercised with the runners mocked out:
unusable AI selection (400), plain custom chat, agent-mode custom endpoint,
the normal Claude run, and the busy session (409)."""
import pytest

from viewer import ai, db, providers, turn, customrun


@pytest.fixture
def calls(monkeypatch):
    seen = {}
    monkeypatch.setattr(db, "session_meta_get", lambda sid: {"sid": sid})

    def claude(session_id, args, message, mode, cwd, model, host, provider_env=None, effort=None):
        seen["claude"] = dict(args=args, message=message, mode=mode, cwd=cwd, model=model,
                              host=host, provider_env=provider_env, effort=effort)
        return seen.get("claude_ok", True)

    def custom(session_id, preset_id, message, cwd, host, mode, model=None, preset=None):
        seen["custom"] = dict(preset_id=preset_id, message=message, cwd=cwd, host=host,
                              mode=mode, model=model, preset=preset)
        return seen.get("custom_ok", True)

    monkeypatch.setattr(turn, "start_claude_run", claude)
    monkeypatch.setattr(customrun, "start_custom_run", custom)
    monkeypatch.setattr(providers, "anthropic_env",
                        lambda pid, model=None, preset=None: {"ANTHROPIC_BASE_URL": pid, "model": model})
    return seen


def _resolved(**over):
    base = {"provider": "", "model": "", "effort": None, "convMode": "chat", "preset": None}
    base.update(over)
    return base


def test_unusable_selection_is_400(monkeypatch, calls):
    def boom(meta, model, host):
        raise ValueError("Provider p1 is gone")
    monkeypatch.setattr(ai, "resolve", boom)
    assert turn.start_turn("s1", "hi", "acceptEdits", "/tmp") == (400, "Provider p1 is gone")
    assert "claude" not in calls and "custom" not in calls


def test_plain_claude_run(monkeypatch, calls):
    monkeypatch.setattr(ai, "resolve", lambda meta, model, host: _resolved(model="opus", effort="high"))
    assert turn.start_turn("s1", "hi", "plan", "/w", model="opus") is None
    c = calls["claude"]
    assert c["args"] == ["--resume", "s1"]
    assert (c["message"], c["mode"], c["cwd"], c["model"], c["effort"]) == ("hi", "plan", "/w", "opus", "high")
    assert c["provider_env"] is None
    assert "custom" not in calls


def test_custom_chat_mode_uses_custom_runner_only(monkeypatch, calls):
    preset = {"baseUrl": "http://x"}
    monkeypatch.setattr(ai, "resolve",
                        lambda meta, model, host: _resolved(provider="p1", model="qwen", preset=preset))
    assert turn.start_turn("s1", "hi", "acceptEdits", "/w") is None
    c = calls["custom"]
    assert (c["preset_id"], c["model"], c["preset"], c["mode"]) == ("p1", "qwen", preset, "acceptEdits")
    assert "claude" not in calls


def test_custom_agent_mode_runs_claude_with_provider_env(monkeypatch, calls):
    monkeypatch.setattr(ai, "resolve",
                        lambda meta, model, host: _resolved(provider="p1", model="m", convMode="agent"))
    assert turn.start_turn("s1", "hi", "acceptEdits", "/w") is None
    c = calls["claude"]
    assert c["provider_env"] == {"ANTHROPIC_BASE_URL": "p1", "model": "m"}
    # The model rides in provider_env, not the CLI --model flag.
    assert c["model"] == ""
    assert "custom" not in calls


@pytest.mark.parametrize("branch", ["claude", "custom"])
def test_busy_session_is_409(monkeypatch, calls, branch):
    if branch == "claude":
        calls["claude_ok"] = False
        monkeypatch.setattr(ai, "resolve", lambda meta, model, host: _resolved())
    else:
        calls["custom_ok"] = False
        monkeypatch.setattr(ai, "resolve", lambda meta, model, host: _resolved(provider="p1"))
    status, text = turn.start_turn("s1", "hi", "acceptEdits", "/w")
    assert status == 409 and "already being processed" in text
