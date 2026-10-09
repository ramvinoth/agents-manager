"""The MCP principal's actor string (server._resolve_principal) — the name the
owner sees in approvals and audit rows:

  human   → user:<name>
  session → session:<label> (the live run's display name)
            or session:<short-id> when the label is
            unavailable (a run outliving a restart).

The engine supplies `label` as a per-run snapshot
(start_claude_run), so the auth path reads a dict, never the transcript.
"""
from viewer import server

SID = "65cf166a-e3e9-4b72-8a9e-15f8d8d2dd49"


class _Stub:
    """Only the two members _resolve_principal touches on self."""

    def __init__(self, user, sid, tok):
        self._user, self._sid, self._tok = user, sid, tok

    def current_user(self):
        return self._user

    def _mcp_credential(self):
        return (self._sid, self._tok)


class _Req:
    pass


def _resolve(monkeypatch, user, sid, tok, validate_result):
    monkeypatch.setattr(server, "validate_session_credential",
                        lambda s, t: validate_result)
    monkeypatch.setattr(server.db, "owner_role", lambda: "owner")
    return server.SessionViewerHandler._resolve_principal(
        _Stub(user, sid, tok), _Req())


class TestHuman:
    def test_actor_is_user_name(self, monkeypatch):
        p = _resolve(monkeypatch, {"username": "ram", "role": "owner"},
                     "", "", None)
        assert p["kind"] == "app"
        assert p["actor"] == "user:ram"
        assert p["session"] == ""


class TestMcpLevel:
    def test_level_still_the_only_gate_value(self, monkeypatch):
        p = _resolve(monkeypatch, None, SID, "tok", {"level": "lead", "label": "RSI"})
        assert p["level"] == "lead"
        assert p["human_role"] == "owner"


class TestMcpActor:
    def test_named_by_live_run_label(self, monkeypatch):
        p = _resolve(monkeypatch, None, SID, "tok",
                     {"level": "ic", "label": "RSI"})
        assert p["actor"] == "session:RSI"

    def test_no_label_falls_back_to_short_id(self, monkeypatch):
        p = _resolve(monkeypatch, None, SID, "tok",
                     {"level": "ic", "label": ""})
        assert p["actor"] == "session:65cf166a"

    def test_always_a_session_actor(self, monkeypatch):
        for variant in (None, {}, {"label": None}):
            p = _resolve(monkeypatch, None, SID, "tok",
                         dict(variant or {}, **{"level": "ic"}))
            assert p is not None
            assert p["actor"].startswith("session:"), variant


class TestInvalid:
    def test_bad_token_yields_no_principal(self, monkeypatch):
        assert _resolve(monkeypatch, None, SID, "bad", None) is None
