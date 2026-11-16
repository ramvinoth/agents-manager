"""Repository-level delivery schedule invariants without a live database."""

from orchestrator import delivery_repository as repository
from orchestrator.shared import postgres


SCHEDULE = {
    "id": 8,
    "card_id": 42,
    "project_id": 7,
    "owner_session_id": "s1",
    "status": "planned",
    "priority": "normal",
    "starts_at": 100.0,
    "due_at": 200.0,
    "timezone": "America/Los_Angeles",
    "all_day": False,
    "estimated_duration_sec": 60,
    "owner_commitment": False,
    "revision": 3,
    "external_link": {},
    "created_by": "user",
    "created_at": 1.0,
    "updated_at": 1.0,
    "completed_at": None,
    "cancelled_at": None,
    "archived_reason": "",
}


class _Cursor:
    def __init__(self, row=SCHEDULE):
        self.row = row
        self.calls = []
        self._reply = None

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if ("SELECT * FROM delivery_schedules WHERE id" in sql
                or "SELECT * FROM delivery_schedules WHERE card_id" in sql):
            self._reply = self.row
        elif sql.startswith("UPDATE delivery_schedules SET"):
            self._reply = dict(self.row, due_at=params.get("due_at", self.row["due_at"]),
                               revision=params["revision"], updated_at=params["updated_at"])
        else:
            self._reply = None

    def fetchone(self):
        return self._reply


class _Connection:
    def __init__(self, cur):
        self.cur = cur

    def __enter__(self):
        return self.cur

    def __exit__(self, *exc):
        return False


def test_stale_revision_returns_current_schedule_without_writing(monkeypatch):
    cur = _Cursor()
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))
    result = repository.schedule_update(8, 2, {"due_at": 240.0}, actor="user")
    assert result == {"conflict": True, "schedule": SCHEDULE}
    assert not any(sql.startswith("UPDATE delivery_schedules SET") for sql, _ in cur.calls)


def test_reschedule_cancels_only_older_pending_deliveries(monkeypatch):
    cur = _Cursor()
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))
    monkeypatch.setattr(postgres, "now", lambda: 250.0)
    result = repository.schedule_update(8, 3, {"due_at": 240.0}, actor="user")
    assert result["revision"] == 4 and result["due_at"] == 240.0
    sql, params = next((sql, params) for sql, params in cur.calls
                       if sql.startswith("UPDATE delivery_reminder_deliveries"))
    assert "schedule_revision < %s" in sql
    assert params == (250.0, 8, 4)


def test_owner_commitment_never_accepts_an_agent_timing_write(monkeypatch):
    cur = _Cursor(dict(SCHEDULE, owner_commitment=True))
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))
    result = repository.schedule_update(8, 3, {"due_at": 240.0}, actor="session:a", actor_kind="agent",
                                        reason="calendar conflict")
    assert result == {"error": "owner commitment changes require an owner action; record a proposal instead"}
    assert not any(sql.startswith("UPDATE delivery_schedules SET") for sql, _ in cur.calls)


def test_owner_commitment_proposal_appends_history_without_updating_schedule(monkeypatch):
    cur = _Cursor(dict(SCHEDULE, owner_commitment=True))
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))
    monkeypatch.setattr(postgres, "now", lambda: 250.0)

    result = repository.schedule_propose(
        8, {"due_at": 240.0}, actor="session:planner", reason="blocked by dependency",
        correlation_id="risk-8",
    )

    assert result == {
        "schedule": dict(SCHEDULE, owner_commitment=True),
        "proposed_changes": {"due_at": 240.0},
        "revision": 3,
    }
    assert not any(sql.startswith("UPDATE delivery_schedules SET") for sql, _ in cur.calls)
    event_sql, event_params = next((sql, params) for sql, params in cur.calls
                                   if sql.startswith("INSERT INTO delivery_schedule_events"))
    assert event_params[2] == "proposed"
    assert event_params[5] == 3
    assert event_params[6] == "blocked by dependency"
    assert event_params[9] == "risk-8"


def test_stale_proposal_revision_returns_current_schedule_without_history(monkeypatch):
    cur = _Cursor(dict(SCHEDULE, owner_commitment=True))
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))

    result = repository.schedule_propose(
        8, {"due_at": 240.0}, actor="session:planner", reason="blocked by dependency",
        expected_revision=2,
    )

    assert result == {"conflict": True, "schedule": dict(SCHEDULE, owner_commitment=True)}
    assert not any(sql.startswith("INSERT INTO delivery_schedule_events") for sql, _ in cur.calls)


def test_proposal_rejects_unknown_fields_without_writing_history(monkeypatch):
    cur = _Cursor(dict(SCHEDULE, owner_commitment=True))
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))

    assert repository.schedule_propose(8, {"forged": True}, actor="session:planner", reason="x") == {
        "error": "proposal contains unknown delivery fields"
    }
    assert not any(sql.startswith("INSERT INTO delivery_schedule_events") for sql, _ in cur.calls)


def test_recovery_replaces_terminal_plan_with_a_new_revision(monkeypatch):
    cur = _Cursor(dict(SCHEDULE, status="cancelled", revision=5, cancelled_at=200.0))
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))
    monkeypatch.setattr(postgres, "now", lambda: 250.0)

    result = repository.schedule_recover(
        8, 5, {"status": "planned", "due_at": 300.0}, actor="user:owner",
        reason="Owner reopened with a new deadline")

    assert result["revision"] == 6
    update_sql, update_params = next((sql, params) for sql, params in cur.calls
                                      if sql.startswith("UPDATE delivery_schedules SET"))
    assert update_params["status"] == "planned"
    assert update_params["completed_at"] is None and update_params["cancelled_at"] is None
    event_sql, event_params = next((sql, params) for sql, params in cur.calls
                                   if sql.startswith("INSERT INTO delivery_schedule_events"))
    assert event_params[2] == "recovered"


def test_card_completion_advances_schedule_and_cancels_active_reminders(monkeypatch):
    class Cur:
        def __init__(self):
            self.calls = []
            self._reply = None

        def execute(self, sql, params=()):
            self.calls.append((sql, params))
            if "SELECT * FROM delivery_schedules WHERE card_id" in sql:
                self._reply = SCHEDULE
            elif sql.startswith("UPDATE delivery_schedules SET status = 'completed'"):
                self._reply = dict(SCHEDULE, status="completed", revision=4,
                                   updated_at=250.0, completed_at=250.0)
            else:
                self._reply = None

        def fetchone(self):
            return self._reply

    cur = Cur()
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))
    monkeypatch.setattr(postgres, "now", lambda: 250.0)

    completed = repository.schedule_complete_for_card(
        42, actor="session:worker", reason="card moved to Done")

    assert completed["status"] == "completed" and completed["revision"] == 4
    event_sql, event_params = next((sql, params) for sql, params in cur.calls
                                   if sql.startswith("INSERT INTO delivery_schedule_events"))
    assert event_params[2] == "completed"
    assert event_params[3] == "session:worker"
    assert event_params[5] == 4
    assert event_params[6] == "card moved to Done"
    assert '"source":"card_done"' in event_params[10]
    reminder_sql, reminder_params = next((sql, params) for sql, params in cur.calls
                                         if sql.startswith("UPDATE delivery_reminder_deliveries"))
    assert "status IN ('pending', 'claimed')" in reminder_sql
    assert reminder_params == (250.0, 8)


def test_card_completion_leaves_terminal_schedule_unchanged(monkeypatch):
    cur = _Cursor(dict(SCHEDULE, status="cancelled", revision=5))
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))

    result = repository.schedule_complete_for_card(42, actor="session:worker")

    assert result == dict(SCHEDULE, status="cancelled", revision=5)
    assert not any(sql.startswith("UPDATE delivery_schedules SET") for sql, _ in cur.calls)
    assert not any(sql.startswith("UPDATE delivery_reminder_deliveries") for sql, _ in cur.calls)


def test_card_completion_with_no_schedule_is_a_noop(monkeypatch):
    cur = _Cursor(None)
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))

    assert repository.schedule_complete_for_card(42, actor="session:worker") is None
    assert not any(sql.startswith("UPDATE delivery_schedules SET") for sql, _ in cur.calls)


def test_due_scan_skips_fully_materialized_schedules_without_hiding_partial_work(monkeypatch):
    class Cur:
        def __init__(self):
            self.calls = []

        def execute(self, sql, params=()):
            self.calls.append((sql, params))

        def fetchall(self):
            return [SCHEDULE]

    cur = Cur()
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))

    assert repository.schedules_due_for_reminders(now=250.0, limit=7) == [SCHEDULE]
    sql, params = cur.calls[0]
    assert "NOT EXISTS" in sql
    assert "recipient_kind = 'owner_push'" in sql
    assert "recipient_kind = 'agent_wake'" in sql
    assert "r.recipient_id = BTRIM(s.owner_session_id)" in sql
    assert params == (250.0, 7)


def test_reminder_key_is_stable_for_retries_and_distinct_by_revision():
    first = repository._reminder_key(8, 3, "due", "owner", "")
    assert first == repository._reminder_key(8, 3, "due", "owner", "")
    assert first != repository._reminder_key(8, 4, "due", "owner", "")


def test_reminder_recovery_rechecks_terminal_and_stale_schedule(monkeypatch):
    class Cur:
        rowcount = 2
        calls = []

        def execute(self, sql, params=()):
            self.calls.append((sql, params))

    cur = Cur()
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))
    assert repository.reminder_recover_expired_claims(now=250.0) == 2
    sql, params = cur.calls[0]
    assert "r.schedule_revision <> s.revision" in sql
    assert "'cancelled'" in sql
    assert "next_attempt_at" in sql
    assert params == (250.0, 250.0, 250.0)


def test_retry_failure_releases_current_claim_with_bounded_sanitized_metadata(monkeypatch):
    claimed = {
        "id": 71, "status": "claimed", "schedule_id": 8, "schedule_revision": 3,
        "schedule_row_id": 8, "schedule_card_id": 42, "current_revision": 3,
        "schedule_status": "planned", "attempts": 1,
    }

    class Cur:
        def __init__(self):
            self.calls = []
            self._reply = None

        def execute(self, sql, params=()):
            self.calls.append((sql, params))
            if sql.startswith("SELECT r.*, s.id AS schedule_row_id"):
                self._reply = claimed
            elif sql.startswith("UPDATE delivery_reminder_deliveries"):
                self._reply = {"id": 71, "status": params[0], "next_attempt_at": params[1]}
            else:
                self._reply = None

        def fetchone(self):
            return self._reply

    cur = Cur()
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))
    monkeypatch.setattr(postgres, "now", lambda: 250.0)

    assert repository.reminder_retry_or_fail(71, error="owner_push_dispatch_failed", now=250.0) == {
        "id": 71, "status": "pending", "next_attempt_at": 265.0,
    }
    update_sql, update_params = next((sql, params) for sql, params in cur.calls
                                      if sql.startswith("UPDATE delivery_reminder_deliveries"))
    assert update_params == ("pending", 265.0, "owner_push_dispatch_failed", 250.0, 71)
    event_sql, event_params = next((sql, params) for sql, params in cur.calls
                                    if sql.startswith("INSERT INTO delivery_schedule_events"))
    assert event_params[0:3] == (8, 42, "reminder_retry_scheduled")
    assert '"attempts":1' in event_params[-1]
    assert '"next_attempt_at":265.0' in event_params[-1]


def test_retry_failure_exhaustion_and_stale_schedule_are_terminal(monkeypatch):
    def run(row):
        class Cur:
            def __init__(self):
                self.calls = []
                self._reply = None

            def execute(self, sql, params=()):
                self.calls.append((sql, params))
                if sql.startswith("SELECT r.*, s.id AS schedule_row_id"):
                    self._reply = row
                elif sql.startswith("UPDATE delivery_reminder_deliveries"):
                    self._reply = {"id": 71, "status": params[0]}
                else:
                    self._reply = None

            def fetchone(self):
                return self._reply

        cur = Cur()
        monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))
        result = repository.reminder_retry_or_fail(71, error="unexpected detail\nsecret", now=250.0)
        update = next(params for sql, params in cur.calls if sql.startswith("UPDATE delivery_reminder_deliveries"))
        event = next(params for sql, params in cur.calls if sql.startswith("INSERT INTO delivery_schedule_events"))
        return result, update, event

    exhausted = {
        "id": 71, "status": "claimed", "schedule_id": 8, "schedule_revision": 3,
        "schedule_row_id": 8, "schedule_card_id": 42, "current_revision": 3,
        "schedule_status": "planned", "attempts": 3,
    }
    result, update, event = run(exhausted)
    assert result == {"id": 71, "status": "failed"}
    assert update[0:3] == ("failed", None, "dispatch_failed")
    assert event[2] == "reminder_failed"

    stale = dict(exhausted, current_revision=4, attempts=1)
    result, update, event = run(stale)
    assert result == {"id": 71, "status": "cancelled"}
    assert update[0] == "cancelled"
    assert event[2] == "reminder_cancelled"


def test_claim_query_uses_next_attempt_and_deterministic_priority_order(monkeypatch):
    class Cur:
        def __init__(self):
            self.calls = []

        def execute(self, sql, params=()):
            self.calls.append((sql, params))

        def fetchall(self):
            return []

    cur = Cur()
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))
    assert repository.reminders_claim_due(now=250.0, lease_seconds=60, limit=20) == []
    sql, params = cur.calls[0]
    assert "COALESCE(r.next_attempt_at, r.due_at) <= %s" in sql
    assert "CASE s.priority" in sql
    assert "LIMIT %s FOR UPDATE OF r SKIP LOCKED" in sql
    assert params == (250.0, 20, 310.0, 250.0)


def test_reminder_finish_cancels_claim_when_schedule_became_stale(monkeypatch):
    stale = {
        "id": 71, "status": "claimed", "schedule_revision": 3,
        "current_revision": 4, "schedule_status": "planned",
    }

    class Cur:
        def __init__(self):
            self.calls = []
            self._reply = None

        def execute(self, sql, params=()):
            self.calls.append((sql, params))
            if sql.startswith("SELECT r.*, s.revision"):
                self._reply = stale
            elif sql.startswith("UPDATE delivery_reminder_deliveries"):
                self._reply = {"id": 71, "status": params[0]}

        def fetchone(self):
            return self._reply

    cur = Cur()
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))
    result = repository.reminder_finish(71, outcome="delivered", now=250.0)
    assert result == {"id": 71, "status": "cancelled"}
    _, params = next((sql, params) for sql, params in cur.calls if sql.startswith("UPDATE delivery_reminder_deliveries"))
    assert params[0] == "cancelled"
