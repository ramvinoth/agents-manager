"""Focused delivery runtime dispatch contracts, without a live scheduler thread."""
from types import SimpleNamespace

from orchestrator import delivery_policy as policy
from orchestrator.runtime import scheduler


SCHEDULE = {
    "id": 8,
    "card_id": 42,
    "owner_session_id": "worker-1",
    "status": "planned",
    "priority": "normal",
    "due_at": 200.0,
    "revision": 3,
}


def test_due_policy_materializes_owner_and_named_agent_once_due():
    specs = policy.reminder_specs(SCHEDULE, now=200.0)
    assert {(s["recipient_kind"], s["recipient_id"]) for s in specs} == {
        ("owner_push", ""), ("agent_wake", "worker-1"),
    }
    assert policy.reminder_specs(SCHEDULE, now=199.9) == ()
    assert policy.reminder_specs(dict(SCHEDULE, status="completed"), now=200.0) == ()


def test_paused_agent_delivery_is_suppressed_not_deferred():
    reminder = {"recipient_kind": "agent_wake"}
    assert policy.classify_delivery(
        SCHEDULE, reminder, now=200.0, autonomous=False,
        session_viable=True, session_running=False,
    ) == ("suppressed", "automation_paused")


def test_delivery_pass_recovers_before_materializing_and_claiming(monkeypatch):
    calls = []
    reminder = {"id": 71, "schedule_id": 8, "recipient_kind": "owner_push"}
    repo = SimpleNamespace(
        reminder_recover_expired_claims=lambda **kw: calls.append(("recover", kw)),
        reminders_materialize_due=lambda **kw: calls.append(("materialize", kw)) or [],
        reminders_claim_due=lambda **kw: calls.append(("claim", kw)) or [reminder],
    )
    monkeypatch.setattr("orchestrator.delivery_repository.reminder_recover_expired_claims", repo.reminder_recover_expired_claims)
    monkeypatch.setattr("orchestrator.delivery_repository.reminders_materialize_due", repo.reminders_materialize_due)
    monkeypatch.setattr("orchestrator.delivery_repository.reminders_claim_due", repo.reminders_claim_due)
    monkeypatch.setattr(scheduler, "_dispatch_delivery_reminder", lambda item, **kw: calls.append(("dispatch", item["id"])))
    monkeypatch.setattr(scheduler, "_delivery_autonomous", lambda: False)

    scheduler.delivery_pass(250.0)

    assert [entry[0] for entry in calls] == ["recover", "materialize", "claim", "dispatch"]


def test_agent_wake_is_not_queued_when_automation_is_paused(monkeypatch):
    finishes = []
    reminder = {"id": 71, "schedule_id": 8, "recipient_kind": "agent_wake", "recipient_id": "worker-1"}
    monkeypatch.setattr("orchestrator.delivery_repository.schedule_get", lambda _id: SCHEDULE)
    monkeypatch.setattr(
        "orchestrator.delivery_repository.reminder_finish",
        lambda _id, **kw: finishes.append(kw) or {"id": _id, "status": kw["outcome"]},
    )

    scheduler._dispatch_delivery_reminder(reminder, now=250.0, autonomous=False)

    assert finishes == [{"outcome": "suppressed", "error": "automation_paused", "now": 250.0}]


def test_owner_push_finalizes_a_durable_attempt(monkeypatch):
    finishes, pushes = [], []
    reminder = {"id": 71, "schedule_id": 8, "recipient_kind": "owner_push", "recipient_id": ""}
    monkeypatch.setattr("orchestrator.delivery_repository.schedule_get", lambda _id: SCHEDULE)
    monkeypatch.setattr(
        "orchestrator.delivery_repository.reminder_finish",
        lambda _id, **kw: finishes.append(kw) or {"id": _id, "status": kw["outcome"]},
    )
    monkeypatch.setattr("orchestrator.push.notify_delivery", lambda *a, **kw: pushes.append((a, kw)) or (True, False, "owner_attention"))

    scheduler._dispatch_delivery_reminder(reminder, now=250.0, autonomous=False)

    assert len(pushes) == 1
    assert finishes == [{"outcome": "delivered", "error": "owner_attention", "now": 250.0}]


def test_owner_push_failure_is_released_for_retry_with_a_sanitized_category(monkeypatch):
    retried = []
    reminder = {"id": 71, "schedule_id": 8, "recipient_kind": "owner_push", "recipient_id": ""}
    monkeypatch.setattr("orchestrator.delivery_repository.schedule_get", lambda _id: SCHEDULE)
    monkeypatch.setattr("orchestrator.push.notify_delivery", lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("network")))
    monkeypatch.setattr(
        "orchestrator.delivery_repository.reminder_retry_or_fail",
        lambda _id, **kw: retried.append(kw) or {"id": _id, "status": "pending"},
    )

    assert scheduler._dispatch_delivery_reminder(reminder, now=250.0, autonomous=False) == {
        "id": 71, "status": "pending"
    }
    assert retried == [{"error": "owner_push_dispatch_failed", "now": 250.0}]


def test_owner_push_permanent_non_delivery_is_suppressed_not_retried(monkeypatch):
    finishes = []
    reminder = {"id": 71, "schedule_id": 8, "recipient_kind": "owner_push", "recipient_id": ""}
    monkeypatch.setattr("orchestrator.delivery_repository.schedule_get", lambda _id: SCHEDULE)
    monkeypatch.setattr("orchestrator.push.notify_delivery", lambda *a, **kw: (False, False, "owner_push_unavailable"))
    monkeypatch.setattr("orchestrator.delivery_repository.reminder_finish",
                        lambda _id, **kw: finishes.append(kw) or {"id": _id, "status": kw["outcome"]})

    assert scheduler._dispatch_delivery_reminder(reminder, now=250.0, autonomous=False) == {
        "id": 71, "status": "suppressed"
    }
    assert finishes == [{"outcome": "suppressed", "error": "owner_push_unavailable", "now": 250.0}]


def test_wake_queue_failure_is_released_for_retry(monkeypatch):
    retried = []
    reminder = {"id": 71, "schedule_id": 8, "recipient_kind": "agent_wake", "recipient_id": "worker-1"}
    monkeypatch.setattr("orchestrator.delivery_repository.schedule_get", lambda _id: SCHEDULE)
    monkeypatch.setattr("orchestrator.config.transcript_path", lambda _id: object())
    monkeypatch.setattr("orchestrator.delivery_wake.schedule_delivery_wake",
                        lambda *_: (_ for _ in ()).throw(RuntimeError("queue unavailable")))
    monkeypatch.setattr(
        "orchestrator.delivery_repository.reminder_retry_or_fail",
        lambda _id, **kw: retried.append(kw) or {"id": _id, "status": "pending"},
    )

    assert scheduler._dispatch_delivery_reminder(reminder, now=250.0, autonomous=True) == {
        "id": 71, "status": "pending"
    }
    assert retried == [{"error": "agent_wake_dispatch_failed", "now": 250.0}]


def test_unknown_wake_adapter_false_result_is_released_for_retry(monkeypatch):
    retried = []
    reminder = {"id": 71, "schedule_id": 8, "recipient_kind": "agent_wake", "recipient_id": "worker-1"}
    monkeypatch.setattr("orchestrator.delivery_repository.schedule_get", lambda _id: SCHEDULE)
    monkeypatch.setattr("orchestrator.config.transcript_path", lambda _id: object())
    monkeypatch.setattr("orchestrator.delivery_wake.schedule_delivery_wake",
                        lambda *_: (False, "queue_unavailable"))
    monkeypatch.setattr(
        "orchestrator.delivery_repository.reminder_retry_or_fail",
        lambda _id, **kw: retried.append(kw) or {"id": _id, "status": "pending"},
    )

    assert scheduler._dispatch_delivery_reminder(reminder, now=250.0, autonomous=True) == {
        "id": 71, "status": "pending"
    }
    assert retried == [{"error": "agent_wake_dispatch_failed", "now": 250.0}]


def test_delivery_pass_continues_after_one_dispatch_failure(monkeypatch):
    calls = []
    reminders = [{"id": 71}, {"id": 72}]
    monkeypatch.setattr("orchestrator.delivery_repository.reminder_recover_expired_claims", lambda **kw: None)
    monkeypatch.setattr("orchestrator.delivery_repository.reminders_materialize_due", lambda **kw: None)
    monkeypatch.setattr("orchestrator.delivery_repository.reminders_claim_due", lambda **kw: reminders)
    monkeypatch.setattr(scheduler, "_delivery_autonomous", lambda: False)

    def dispatch(reminder, **_kw):
        calls.append(reminder["id"])
        if reminder["id"] == 71:
            raise RuntimeError("unexpected")

    retried = []
    monkeypatch.setattr(scheduler, "_dispatch_delivery_reminder", dispatch)
    monkeypatch.setattr("orchestrator.delivery_repository.reminder_retry_or_fail",
                        lambda reminder_id, **kw: retried.append((reminder_id, kw)))

    scheduler.delivery_pass(250.0)

    assert calls == [71, 72]
    assert retried == [(71, {"error": "delivery_dispatch_failed", "now": 250.0})]


def test_reschedule_race_becomes_cancelled_at_finish(monkeypatch):
    reminder = {"id": 71, "schedule_id": 8, "recipient_kind": "owner_push", "recipient_id": ""}
    monkeypatch.setattr("orchestrator.delivery_repository.schedule_get", lambda _id: SCHEDULE)
    monkeypatch.setattr("orchestrator.push.notify_delivery", lambda *a, **kw: (True, False, "owner_attention"))
    finished = []
    monkeypatch.setattr(
        "orchestrator.delivery_repository.reminder_finish",
        lambda _id, **kw: finished.append(kw) or {"id": _id, "status": "cancelled"},
    )

    assert scheduler._dispatch_delivery_reminder(reminder, now=250.0, autonomous=False) == {
        "id": 71, "status": "cancelled"
    }
    assert finished[0]["outcome"] == "delivered"
