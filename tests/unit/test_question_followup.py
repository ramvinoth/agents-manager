"""The follow-up half of the decision loop (card #61): the owner's own words
answer a durable question through the SAME race-safe path as a pick.

A follow-up is not a chat message — a chat message would queue behind the run
that is blocked on the question. It is an answer whose content is free text:
it consumes the exact pending row first-writer-wins (decisions.accept_answer),
then unblocks the live waiter or resumes the session, exactly like a pick.
"""
import pytest

from viewer import decisions, questions
from viewer.routes.chat import ChatMixin

PENDING = {"tool_use_id": "t1", "questions": [{"header": "Lane", "options": []}],
           "host": "local", "run_id": "r1", "revision": 2}


class _Handler(ChatMixin):
    def __init__(self, body):
        self._body = body
        self.sent = None
        self.resumed = None

    def read_body(self):
        return self._body

    def send_json(self, data, status=200):
        self.sent = (data, status)

    def _resume_with_reply(self, rel, sid, host, message, body):
        self.resumed = (sid, host, message)
        self.send_json({"resumed": True, "session": sid})


@pytest.fixture
def gate(monkeypatch):
    seen = {}
    monkeypatch.setattr(questions, "get_open", lambda sid: dict(PENDING) if sid == "s1" else None)

    def accept(sid, tool, message, host="local", run_id="", revision=0):
        seen["accept"] = (sid, tool, message, host, run_id, revision)
        return seen.get("accepted", True), seen.get("delivered", False)

    monkeypatch.setattr(decisions, "accept_answer", accept)
    return seen


def test_note_only_is_an_answer_through_the_gate(gate):
    h = _Handler({"session": "p/s1.jsonl", "picks": [], "note": "neither; ship both lanes"})
    h._p_chat_question_answer(None)
    sid, tool, message, host, run_id, revision = gate["accept"]
    assert (sid, tool, host, run_id, revision) == ("s1", "t1", "local", "r1", 2)
    assert message.endswith("none of the offered options; instead: neither; ship both lanes")
    assert h.resumed[0] == "s1" and h.sent == ({"resumed": True, "session": "s1"}, 200)


def test_pick_plus_note_carries_both(gate):
    gate["delivered"] = True
    h = _Handler({"session": "p/s1.jsonl", "picks": ["Needs-info"], "note": "and tell me when it lands"})
    h._p_chat_question_answer(None)
    message = gate["accept"][2]
    assert "Lane: Needs-info" in message and "Additional note: and tell me when it lands" in message
    assert h.sent == ({"answered": True, "session": "s1"}, 200)
    assert h.resumed is None


def test_nothing_to_say_is_rejected_before_the_gate(gate):
    h = _Handler({"session": "p/s1.jsonl", "picks": ["", ""], "note": "   "})
    h._p_chat_question_answer(None)
    assert h.sent[1] == 400 and "accept" not in gate


def test_lost_race_is_409_not_a_second_resume(gate):
    gate["accepted"] = False
    h = _Handler({"session": "p/s1.jsonl", "picks": [], "note": "late reply"})
    h._p_chat_question_answer(None)
    assert h.sent[1] == 409 and h.resumed is None
