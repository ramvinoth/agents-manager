"""Question delivery races, without a database, subprocess or real wait."""
import threading

import pytest

from orchestrator import questions
from orchestrator.runtime import permissions


@pytest.fixture
def job(monkeypatch):
    row = {"running": True, "host": "local", "run_id": "run-1",
           "pending_approvals": []}
    monkeypatch.setattr(permissions, "CHAT_JOBS", {"question-session": row})
    monkeypatch.setattr(permissions, "QUESTION_TIMEOUT", 0)
    monkeypatch.setattr(questions, "record", lambda *a, **kw: None)
    monkeypatch.setattr("orchestrator.push.notify_all", lambda *a, **kw: None)
    return row


def test_timeout_preserves_durable_question(job, monkeypatch):
    cleared = []
    monkeypatch.setattr(questions, "clear", lambda *a, **kw: cleared.append(a))
    result = permissions._await_question_answer("question-session", {"questions": []}, "tool-1")
    assert result["behavior"] == "deny"
    assert cleared == [], "Timeout ends the live waiter, not the durable question"


def test_answer_is_first_writer_wins(job):
    entry = {"id": "waiter", "question": True, "tool_use_id": "tool-1",
             "answer": None, "event": threading.Event()}
    job["pending_approvals"].append(entry)
    assert permissions.answer_live_question("question-session", "first")
    assert not permissions.answer_live_question("question-session", "second")
    assert entry["answer"] == "first"


def test_timeout_cannot_clear_replacement_question(job, monkeypatch):
    durable = {"tool_use_id": "tool-1"}

    def record(*args, **kwargs):
        # A later source arrived after this waiter registered.
        durable["tool_use_id"] = "tool-2"

    monkeypatch.setattr(questions, "record", record)
    monkeypatch.setattr(questions, "clear", lambda *a, **kw: durable.clear())
    permissions._await_question_answer("question-session", {"questions": []}, "tool-1")
    assert durable == {"tool_use_id": "tool-2"}
