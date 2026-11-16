"""Delivery wake identity and adapter contracts."""

from orchestrator import delivery_wake


SCHEDULE = {
    "id": 8,
    "card_id": 42,
    "owner_session_id": "worker-1",
}
REMINDER = {
    "id": 71,
    "schedule_id": 8,
    "schedule_revision": 3,
    "reminder_kind": "due",
    "recipient_id": "worker-1",
}


def test_wake_identity_is_revision_bound_coalesced_and_does_not_expose_session_id():
    first = delivery_wake.wake_id(REMINDER)
    assert first == delivery_wake.wake_id(dict(REMINDER, id=72))
    assert first != delivery_wake.wake_id(dict(REMINDER, schedule_revision=4))
    assert first.startswith("dw:8:3:")
    assert "worker-1" not in first
    assert len(first) < 64


def test_queue_wake_uses_the_logical_identity(monkeypatch):
    calls = []
    monkeypatch.setattr(delivery_wake, "_session_running", lambda _session: False)
    monkeypatch.setattr(delivery_wake, "transcript_path", lambda _session: object())
    monkeypatch.setattr(delivery_wake.boardwatch, "schedule_once", lambda *args: calls.append(args))

    assert delivery_wake.schedule_delivery_wake(SCHEDULE, REMINDER) == (True, "agent_wake_queued")
    assert calls[0][0] == delivery_wake.wake_id(REMINDER)
    assert calls[0][1] == "worker-1"
    assert calls[0][-1] == delivery_wake.loops.AGENT_ORIGIN
