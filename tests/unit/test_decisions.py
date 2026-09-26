"""Durable question contracts. Unit tests never connect to a database."""
from contextlib import contextmanager

import pytest

from viewer import db


class RecordingCursor:
    def __init__(self, rows=()):
        self.rows = iter(rows)
        self.calls = []
        self.rowcount = 1

    def execute(self, sql, params=()):
        self.calls.append((sql, params))

    def fetchone(self):
        return next(self.rows, None)

    def fetchall(self):
        return list(self.rows)


@pytest.fixture
def cursor(monkeypatch):
    cur = RecordingCursor()

    @contextmanager
    def transaction():
        yield cur

    monkeypatch.setattr(db, "_db", transaction)
    return cur


def test_timeout_cleanup_requires_exact_request_identity(cursor):
    # Old session-only DELETE also erases a replacement question from a new run.
    db.pending_question_clear_exact("session", "tool-old", host="remote", run_id="run-old", revision=1)
    sql, params = cursor.calls[-1]
    for field in ("session_id", "tool_use_id", "host", "run_id", "revision"):
        assert f"{field} = %s" in sql
    assert params == ("session", "tool-old", "remote", "run-old", 1)


def test_answer_acceptance_is_durable_before_delivery():
    from viewer import decisions
    assert callable(decisions.accept_answer)
    assert callable(db.decision_answer_accept)
