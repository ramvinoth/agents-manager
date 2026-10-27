"""The human loop routes (POST /api/loops, /api/loops/edit) accept the same
schedule vocabulary as the gated agent action: cron, `at` (one-shot) or
interval — all resolved by loops.build_schedule, so the two entry points can
never disagree on what a valid schedule is or when it fires next.

The db is simulated with a dict store; nothing here touches Postgres.
"""
import pytest

from viewer import db
from viewer.routes.sessions import SessionsMixin

NOW = 1_700_000_000.0


class _Handler(SessionsMixin):
    def __init__(self, body, session_found=True):
        self._body = body
        self._session_found = session_found
        self.sent = None

    def read_body(self):
        return self._body

    def send_json(self, data, status=200):
        self.sent = (data, status)

    def resolve_session_quiet(self, rel):
        class _P:
            stem = "sess-1"
        return _P() if self._session_found else None


@pytest.fixture
def store(monkeypatch):
    rows = {}

    def upsert(lid, entry):
        rows[lid] = dict(entry)

    def update(lid, fields):
        if lid not in rows:
            return None
        rows[lid].update(fields)
        return dict(rows[lid])

    monkeypatch.setattr(db, "loop_upsert", upsert)
    monkeypatch.setattr(db, "loop_update", update)
    monkeypatch.setattr(db, "loop_get", lambda lid: dict(rows[lid]) if lid in rows else None)
    monkeypatch.setattr("viewer.routes.sessions.time.time", lambda: NOW)
    monkeypatch.setattr("viewer.loops.time.time", lambda: NOW)
    return rows


def _create(store, body):
    h = _Handler(body)
    h.handle_create_loop()
    data, status = h.sent
    assert status == 200, data
    return store[data["created"]], data


def test_create_once_at_relative_offset(store):
    row, data = _create(store, {"session": "s", "prompt": "ping", "at": "30m"})
    assert row["kind"] == "once"
    assert row["nextRun"] == NOW + 1800
    assert row["cron"] is None and row["interval"] == 0
    assert row["origin"] == "user"
    assert data["kind"] == "once" and data["nextRun"] == NOW + 1800


def test_create_recurring_interval_and_cron(store):
    row, data = _create(store, {"session": "s", "prompt": "p", "interval": "5m"})
    assert (row["kind"], row["interval"], row["nextRun"]) == ("recurring", 300, NOW + 300)
    row, data = _create(store, {"session": "s", "prompt": "p", "cron": "0 9 * * *"})
    assert row["kind"] == "recurring" and row["cron"] == "0 9 * * *" and row["interval"] == 0
    assert data["cron"] == "0 9 * * *"


def test_create_rejects_bad_at_and_missing_schedule(store):
    h = _Handler({"session": "s", "prompt": "p", "at": "tomorrowish"})
    h.handle_create_loop()
    assert h.sent[1] == 400 and "at" in h.sent[0]["error"]
    h = _Handler({"session": "s", "prompt": "p"})
    h.handle_create_loop()
    assert h.sent[1] == 400
    assert store == {}


def test_create_requires_prompt_and_session(store):
    h = _Handler({"session": "s", "prompt": "  ", "at": "1h"})
    h.handle_create_loop()
    assert h.sent[1] == 400
    h = _Handler({"session": "gone", "prompt": "p", "at": "1h"}, session_found=False)
    h.handle_create_loop()
    assert h.sent[1] == 404


def _edit(body):
    h = _Handler(body)
    h.handle_edit_loop()
    return h.sent


def test_edit_recurring_cron_to_once_clears_stale_cron(store):
    row, data = _create(store, {"session": "s", "prompt": "p", "cron": "0 9 * * *"})
    lid = data["created"]
    data, status = _edit({"id": lid, "at": "2h"})
    assert status == 200
    assert store[lid]["kind"] == "once"
    assert store[lid]["cron"] is None, "a stale cron would make the scheduler re-fire it"
    assert store[lid]["nextRun"] == NOW + 7200
    assert data["kind"] == "once" and data["cron"] is None


def test_edit_once_back_to_recurring_interval(store):
    row, data = _create(store, {"session": "s", "prompt": "p", "at": "1d"})
    lid = data["created"]
    data, status = _edit({"id": lid, "interval": "10m"})
    assert status == 200
    assert store[lid]["kind"] == "recurring"
    assert store[lid]["interval"] == 600 and store[lid]["nextRun"] == NOW + 600
    assert data["kind"] == "recurring"


def test_edit_once_back_to_recurring_cron(store):
    row, data = _create(store, {"session": "s", "prompt": "p", "at": "1d"})
    lid = data["created"]
    data, status = _edit({"id": lid, "cron": "*/15 * * * *"})
    assert status == 200
    assert store[lid]["kind"] == "recurring" and store[lid]["cron"] == "*/15 * * * *"
    assert store[lid]["interval"] == 0


def test_edit_interval_on_cron_loop_keeps_cron_unless_cleared(store):
    row, data = _create(store, {"session": "s", "prompt": "p", "cron": "0 9 * * *"})
    lid = data["created"]
    # Cron wins while it is set: an interval alone is a no-op on the schedule.
    _edit({"id": lid, "interval": "5m"})
    assert store[lid]["cron"] == "0 9 * * *" and store[lid]["interval"] == 0
    # Clearing cron in the same edit lets the interval take over.
    data, status = _edit({"id": lid, "cron": "", "interval": "5m"})
    assert status == 200
    assert store[lid]["cron"] is None and store[lid]["interval"] == 300
    assert store[lid]["nextRun"] == NOW + 300


def test_edit_non_schedule_fields_leave_schedule_alone(store):
    row, data = _create(store, {"session": "s", "prompt": "p", "at": "1h"})
    lid = data["created"]
    before = dict(store[lid])
    data, status = _edit({"id": lid, "prompt": "new", "enabled": False, "model": "m"})
    assert status == 200
    assert store[lid]["prompt"] == "new" and store[lid]["enabled"] is False
    for k in ("kind", "cron", "interval", "nextRun"):
        assert store[lid][k] == before[k]


def test_edit_rejects_bad_schedule_and_missing_loop(store):
    row, data = _create(store, {"session": "s", "prompt": "p", "at": "1h"})
    lid = data["created"]
    before = dict(store[lid])
    data, status = _edit({"id": lid, "at": "nope"})
    assert status == 400 and store[lid] == before
    data, status = _edit({"id": lid, "cron": "not a cron"})
    assert status == 400 and store[lid] == before
    data, status = _edit({"id": "missing", "at": "1h"})
    assert status == 404
