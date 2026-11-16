"""Delivery HTTP routes stay thin and use the central action gate.

These tests drive the route mixin directly with a fake database.  They cover the
public contract without duplicating repository policy: reads expose schedule
truth/history, while writes create an action intent for ``actions.execute``.
"""
from types import SimpleNamespace

import pytest

from orchestrator.routes.orchestrator import OrchestratorMixin


class _FakeSelf(OrchestratorMixin):
    def __init__(self, body=None):
        self._body = body or {}
        self.sent = []
        self.intents = []

    def read_body(self):
        return self._body

    def send_json(self, payload, status=200):
        self.sent.append((status, payload))

    def _org_send(self, req, action, args):
        self.intents.append((action, args))


class _FakeDB:
    def __init__(self):
        self.by_id = {}
        self.by_card = {}
        self.events = {}
        self.list_calls = []

    def schedule_get(self, schedule_id):
        return self.by_id.get(schedule_id)

    def schedule_for_card(self, card_id):
        return self.by_card.get(card_id)

    def schedule_events(self, schedule_id):
        return self.events.get(schedule_id, [])

    def schedule_list(self, project_id=None, *, include_terminal=False):
        self.list_calls.append((project_id, include_terminal))
        return [s for s in self.by_id.values()
                if project_id is None or s["project_id"] == project_id]


@pytest.fixture()
def db(monkeypatch):
    from orchestrator.routes import orchestrator
    fake = _FakeDB()
    monkeypatch.setattr(orchestrator, "db", fake)
    return fake


def _req(query=None):
    return SimpleNamespace(
        query=query or {},
        principal={"actor": "owner", "human_role": "owner", "session_level": "", "session": ""},
    )


def _schedule(schedule_id=7, card_id=12, project_id=3):
    return {
        "id": schedule_id,
        "card_id": card_id,
        "project_id": project_id,
        "status": "planned",
        "revision": 1,
    }


@pytest.mark.parametrize("query", ({}, {"id": ["7"], "card_id": ["12"]}))
def test_delivery_schedule_requires_exactly_one_identifier(db, query):
    route = _FakeSelf()

    route._g_delivery_schedule(_req(query))

    assert route.sent == [(400, {"error": "provide exactly one of id or card_id"})]


@pytest.mark.parametrize("query", ({"id": ["bad"]}, {"card_id": ["bad"]}))
def test_delivery_schedule_rejects_non_integer_identifier(db, query):
    route = _FakeSelf()

    route._g_delivery_schedule(_req(query))

    assert route.sent == [(400, {"error": "id or card_id must be an integer"})]


def test_delivery_schedule_reads_by_schedule_id_with_history(db):
    schedule = _schedule()
    db.by_id[schedule["id"]] = schedule
    db.events[schedule["id"]] = [{"event_type": "created"}]
    route = _FakeSelf()

    route._g_delivery_schedule(_req({"id": ["7"]}))

    assert route.sent == [(200, {"schedule": schedule, "events": [{"event_type": "created"}]})]


def test_delivery_schedule_reads_by_card_id_with_history(db):
    schedule = _schedule()
    db.by_card[schedule["card_id"]] = schedule
    db.events[schedule["id"]] = [{"event_type": "rescheduled"}]
    route = _FakeSelf()

    route._g_delivery_schedule(_req({"card_id": ["12"]}))

    assert route.sent == [(200, {"schedule": schedule, "events": [{"event_type": "rescheduled"}]})]


def test_delivery_schedule_returns_not_found(db):
    route = _FakeSelf()

    route._g_delivery_schedule(_req({"id": ["7"]}))

    assert route.sent == [(404, {"error": "not found"})]


def test_delivery_schedules_filters_by_project_and_terminal_flag(db):
    first, second = _schedule(), _schedule(schedule_id=8, card_id=13, project_id=4)
    db.by_id = {first["id"]: first, second["id"]: second}
    route = _FakeSelf()

    route._g_delivery_schedules(_req({"project": ["3"], "include_terminal": ["true"]}))

    assert route.sent == [(200, {"schedules": [first]})]
    assert db.list_calls == [(3, True)]


def test_delivery_schedules_rejects_non_integer_project(db):
    route = _FakeSelf()

    route._g_delivery_schedules(_req({"project": ["bad"]}))

    assert route.sent == [(400, {"error": "project must be an integer"})]


def test_delivery_schedule_create_sends_only_the_create_intent(db):
    body = {"card_id": 12, "schedule": {"timezone": "America/Los_Angeles"}, "reason": "Plan delivery"}
    route = _FakeSelf(body)

    route._p_delivery_schedules(_req())

    assert route.intents == [("delivery_schedule_create", body)]


def test_delivery_schedule_update_sends_compare_and_swap_intent(db):
    body = {
        "schedule_id": 7,
        "expected_revision": 2,
        "changes": {"due_at": 1_800_000_000.0},
        "reason": "Move after dependency review",
        "event_type": "rescheduled",
        "correlation_id": "calendar-drag-7",
    }
    route = _FakeSelf(body)

    route._p_delivery_schedule_update(_req())

    assert route.intents == [("delivery_schedule_update", body)]


def test_delivery_schedule_lifecycle_routes_send_only_named_intents(db):
    cases = (
        ("_p_delivery_schedule_cancel", "delivery_schedule_cancel", {
            "schedule_id": 7, "expected_revision": 2, "reason": "Work no longer needed",
        }),
        ("_p_delivery_schedule_archive", "delivery_schedule_archive", {
            "schedule_id": 7, "expected_revision": 3, "reason": "Keep the completed record",
        }),
        ("_p_delivery_schedule_recover", "delivery_schedule_recover", {
            "schedule_id": 7, "expected_revision": 3,
            "changes": {"status": "planned", "due_at": 1_800_000_000.0},
            "reason": "New owner-approved delivery window",
        }),
    )
    for method, action, body in cases:
        route = _FakeSelf(body)
        getattr(route, method)(_req())
        assert route.intents == [(action, body)]


def test_delivery_schedule_proposal_sends_revision_without_apply_action(db):
    body = {
        "schedule_id": 7,
        "expected_revision": 3,
        "changes": {"due_at": 1_800_000_000.0},
        "reason": "Dependency will miss the owner commitment",
        "correlation_id": "risk-7",
    }
    route = _FakeSelf(body)

    route._p_delivery_schedule_propose(_req())

    assert route.intents == [("delivery_schedule_propose", body)]
