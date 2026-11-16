"""Single-use, caller-bound confirmation records for consequential Call mode."""
from contextlib import contextmanager

from orchestrator import call_commands
from orchestrator.shared import postgres


COMMAND = {
    "id": "confirm-1",
    "caller": "user:owner",
    "call_session_id": "work-session",
    "operation": "calendar.create",
    "arguments": {"title": "Focus"},
    "source_state": {"calendar": "primary"},
    "correlation_id": "call-1",
    "status": "pending",
    "created_at": 100.0,
    "expires_at": 220.0,
    "resolved_at": None,
}


class Cursor:
    def __init__(self, row=None):
        self.row = row
        self.calls = []
        self.rowcount = 1
        self._reply = None

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if sql.startswith("SELECT * FROM call_pending_commands"):
            self._reply = self.row
        elif "RETURNING *" in sql:
            self._reply = self.row
        else:
            self._reply = None

    def fetchone(self):
        return self._reply


@contextmanager
def use_cursor(cur):
    yield cur


def test_prepare_binds_server_identity_and_supersedes_only_same_call(monkeypatch):
    cur = Cursor(COMMAND)
    monkeypatch.setattr(postgres, "cursor", lambda: use_cursor(cur))
    monkeypatch.setattr(postgres, "now", lambda: 100.0)
    monkeypatch.setattr(call_commands.secrets, "token_urlsafe", lambda _: "confirm-1")

    saved = call_commands.prepare(
        caller="user:owner", call_session_id="work-session", operation="calendar.create",
        arguments={"title": "Focus"}, source_state={"calendar": "primary"},
        ttl_seconds=120, correlation_id="call-1",
    )

    assert saved["id"] == "confirm-1"
    supersede_sql, supersede_params = cur.calls[0]
    assert "status = 'superseded'" in supersede_sql
    assert supersede_params == (100.0, "user:owner", "work-session")
    insert_sql, insert_params = cur.calls[1]
    assert "INSERT INTO call_pending_commands" in insert_sql
    assert insert_params[-2:] == (100.0, 220.0)
    assert '"title":"Focus"' in insert_params[4]


def test_prepare_rejects_unbounded_or_ambiguous_data(monkeypatch):
    monkeypatch.setattr(postgres, "cursor", lambda: (_ for _ in ()).throw(AssertionError("must not write")))

    for kwargs, expected in (
        ({"caller": "", "call_session_id": "s", "operation": "calendar.create"}, "caller and call session"),
        ({"caller": "u", "call_session_id": "s", "operation": "x" * 81}, "operation is required"),
        ({"caller": "u", "call_session_id": "s", "operation": "x", "ttl_seconds": 301}, "expiry"),
    ):
        try:
            call_commands.prepare(arguments={}, source_state={}, **kwargs)
        except ValueError as exc:
            assert expected in str(exc)
        else:
            raise AssertionError("prepare must reject invalid confirmation data")


def test_get_pending_hides_other_caller_and_nonpending_rows(monkeypatch):
    cur = Cursor(COMMAND)
    monkeypatch.setattr(postgres, "cursor", lambda: use_cursor(cur))

    assert call_commands.get_pending("confirm-1", caller="user:other", call_session_id="work-session") is None
    assert call_commands.get_pending("confirm-1", caller="user:owner", call_session_id="work-session") == COMMAND
    cur.row = dict(COMMAND, status="consumed")
    assert call_commands.get_pending("confirm-1", caller="user:owner", call_session_id="work-session") is None


def test_consume_is_single_use_and_returns_the_stored_normalized_command(monkeypatch):
    cur = Cursor(COMMAND)
    monkeypatch.setattr(postgres, "cursor", lambda: use_cursor(cur))
    monkeypatch.setattr(postgres, "now", lambda: 110.0)

    result = call_commands.consume(
        "confirm-1", caller="user:owner", call_session_id="work-session",
        current_source_state={"calendar": "primary"},
    )

    assert result == {"command": COMMAND}
    consume_sql, consume_params = cur.calls[-1]
    assert "status = 'consumed'" in consume_sql
    assert consume_params == (110.0, "confirm-1")


def test_consume_rejects_caller_or_call_session_mismatch_without_leaking_command(monkeypatch):
    cur = Cursor(COMMAND)
    monkeypatch.setattr(postgres, "cursor", lambda: use_cursor(cur))
    monkeypatch.setattr(postgres, "now", lambda: 110.0)

    result = call_commands.consume(
        "confirm-1", caller="user:other", call_session_id="work-session",
        current_source_state={"calendar": "primary"},
    )

    assert result == {"error": "confirmation is unavailable"}
    assert len(cur.calls) == 1


def test_consume_rejects_expired_confirmation_and_marks_it_terminal(monkeypatch):
    cur = Cursor(dict(COMMAND, expires_at=100.0))
    monkeypatch.setattr(postgres, "cursor", lambda: use_cursor(cur))
    monkeypatch.setattr(postgres, "now", lambda: 100.0)

    result = call_commands.consume(
        "confirm-1", caller="user:owner", call_session_id="work-session",
        current_source_state={"calendar": "primary"},
    )

    assert result == {"error": "confirmation expired"}
    assert "status = 'expired'" in cur.calls[-1][0]


def test_consume_rejects_stale_source_revision_before_operation_executes(monkeypatch):
    cur = Cursor(dict(COMMAND, source_state={"schedule_id": 8, "revision": 3}))
    monkeypatch.setattr(postgres, "cursor", lambda: use_cursor(cur))
    monkeypatch.setattr(postgres, "now", lambda: 110.0)

    result = call_commands.consume(
        "confirm-1", caller="user:owner", call_session_id="work-session",
        current_source_state={"schedule_id": 8, "revision": 4},
    )

    assert result == {"error": "the item changed; please ask again"}
    assert "status = 'stale'" in cur.calls[-1][0]


def test_consume_never_reuses_already_resolved_confirmation(monkeypatch):
    cur = Cursor(dict(COMMAND, status="consumed", resolved_at=105.0))
    monkeypatch.setattr(postgres, "cursor", lambda: use_cursor(cur))
    monkeypatch.setattr(postgres, "now", lambda: 110.0)

    result = call_commands.consume(
        "confirm-1", caller="user:owner", call_session_id="work-session",
        current_source_state={"calendar": "primary"},
    )

    assert result == {"error": "confirmation was already used or replaced"}
    assert len(cur.calls) == 1
