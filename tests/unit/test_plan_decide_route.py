"""A durable plan (ExitPlanMode) outlives its live waiter — a server restart or
QUESTION_TIMEOUT ends the blocked turn but the pending_plans row stays, and the
app keeps rendering Approve/Deny for it. Deciding it must then resume the
session with the decision, exactly like an answered-late question does."""
import pytest

from viewer import engine, questions
from viewer.routes import chat
from viewer.routes.chat import ChatMixin


class _Handler(ChatMixin):
    def __init__(self, body):
        self._body = body
        self.sent = None

    def read_body(self):
        return self._body

    def send_json(self, data, status=200):
        self.sent = (data, status)

    def resolve_session_quiet(self, rel):
        return None


@pytest.fixture
def durable_plan(monkeypatch):
    state = {"plan": {"tool_use_id": "tool-plan", "plan": "# Plan", "host": "local"},
             "resolved": [], "runs": []}
    monkeypatch.setattr(questions, "get_open_plan", lambda sid: state["plan"])

    def resolve_plan(sid, tool_use_id):
        if state["plan"] and state["plan"]["tool_use_id"] == tool_use_id:
            state["plan"] = None
            state["resolved"].append((sid, tool_use_id))
            return True
        return False

    monkeypatch.setattr(questions, "resolve_plan", resolve_plan)
    monkeypatch.setattr(engine, "decide_plan", lambda *a: False)
    monkeypatch.setattr(chat, "start_claude_run",
                        lambda sid, args, msg, mode, cwd, model, host:
                        state["runs"].append((sid, args, msg, mode, host)) or True)
    return state


def test_deny_without_live_waiter_resumes_with_feedback(durable_plan):
    h = _Handler({"session": "sess-plan", "decision": "deny", "feedback": "too broad"})
    h._p_chat_plan_decide(None)
    assert h.sent == ({"resumed": True, "session": "sess-plan"}, 200)
    assert durable_plan["resolved"] == [("sess-plan", "tool-plan")]
    (sid, args, msg, mode, host), = durable_plan["runs"]
    assert (sid, args, host) == ("sess-plan", ["--resume", "sess-plan"], "local")
    assert "too broad" in msg and "not approved" in msg


def test_approve_without_live_waiter_resumes_to_execute(durable_plan):
    h = _Handler({"session": "sess-plan", "decision": "approve"})
    h._p_chat_plan_decide(None)
    assert h.sent[1] == 200 and h.sent[0]["resumed"] is True
    (_, _, msg, _, _), = durable_plan["runs"]
    assert "approved" in msg.lower()


def test_second_device_deciding_the_same_plan_is_rejected(durable_plan, monkeypatch):
    # The row was read as open, but another device resolved it first.
    monkeypatch.setattr(questions, "resolve_plan", lambda sid, tid: False)
    h = _Handler({"session": "sess-plan", "decision": "deny"})
    h._p_chat_plan_decide(None)
    assert h.sent[1] == 409
    assert durable_plan["runs"] == []


def test_live_waiter_still_takes_the_fast_path(durable_plan, monkeypatch):
    monkeypatch.setattr(engine, "decide_plan", lambda *a: True)
    h = _Handler({"session": "sess-plan", "decision": "approve"})
    h._p_chat_plan_decide(None)
    assert h.sent == ({"decided": True, "session": "sess-plan"}, 200)
    assert durable_plan["runs"] == [] and durable_plan["resolved"] == []
