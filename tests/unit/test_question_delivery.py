"""Question delivery races, without a database, subprocess or real wait."""
import threading

import pytest

from viewer import engine, questions


@pytest.fixture
def job(monkeypatch):
    row = {"running": True, "host": "local", "run_id": "run-1",
           "pending_approvals": []}
    monkeypatch.setattr(engine, "CHAT_JOBS", {"question-session": row})
    monkeypatch.setattr(engine, "QUESTION_TIMEOUT", 0)
    monkeypatch.setattr(questions, "record", lambda *a, **kw: None)
    monkeypatch.setattr("viewer.push.notify_all", lambda *a, **kw: None)
    return row


def test_timeout_preserves_durable_question(job, monkeypatch):
    cleared = []
    monkeypatch.setattr(questions, "clear", lambda *a, **kw: cleared.append(a))
    result = engine._await_question_answer("question-session", {"questions": []}, "tool-1")
    assert result["behavior"] == "deny"
    assert cleared == [], "Timeout ends the live waiter, not the durable question"


def test_answer_is_first_writer_wins(job):
    entry = {"id": "waiter", "question": True, "tool_use_id": "tool-1",
             "answer": None, "event": threading.Event()}
    job["pending_approvals"].append(entry)
    assert engine.answer_live_question("question-session", "first")
    assert not engine.answer_live_question("question-session", "second")
    assert entry["answer"] == "first"


def test_timeout_cannot_clear_replacement_question(job, monkeypatch):
    durable = {"tool_use_id": "tool-1"}

    def record(*args, **kwargs):
        # A later source arrived after this waiter registered.
        durable["tool_use_id"] = "tool-2"

    monkeypatch.setattr(questions, "record", record)
    monkeypatch.setattr(questions, "clear", lambda *a, **kw: durable.clear())
    engine._await_question_answer("question-session", {"questions": []}, "tool-1")
    assert durable == {"tool_use_id": "tool-2"}
