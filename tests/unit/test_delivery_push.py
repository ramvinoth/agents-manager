"""Synchronous APNs acceptance boundary for durable delivery reminders."""

from orchestrator import push


def _configured(monkeypatch, tokens, responses):
    monkeypatch.setattr(push, "_configured", lambda: True)
    monkeypatch.setattr(push.db, "all_push_tokens", lambda: tokens)
    monkeypatch.setattr(push, "_auth_jwt", lambda: "token")
    monkeypatch.setattr(push, "_send_one", lambda *_args: responses.pop(0))


def test_accepted_apns_submission_is_advisory_not_device_receipt(monkeypatch):
    _configured(monkeypatch, ["device-a"], [(True, "")])

    assert push.notify_delivery("title", "body", {"card": 42}) == (
        True, False, "owner_attention",
    )


def test_transient_apns_failure_is_retryable(monkeypatch):
    _configured(monkeypatch, ["device-a"], [(False, "500")])

    assert push.notify_delivery("title", "body") == (
        False, True, "owner_push_dispatch_failed",
    )


def test_dead_or_missing_device_is_final_and_does_not_create_retry_backlog(monkeypatch):
    removed = []
    _configured(monkeypatch, ["device-a"], [(False, "BadDeviceToken")])
    monkeypatch.setattr(push.db, "remove_push_token", lambda token: removed.append(token))

    assert push.notify_delivery("title", "body") == (
        False, False, "owner_push_unavailable",
    )
    assert removed == ["device-a"]


def test_one_accepted_device_stops_after_an_earlier_transient_failure(monkeypatch):
    _configured(monkeypatch, ["device-a", "device-b"], [(False, "500"), (True, "")])

    assert push.notify_delivery("title", "body") == (
        True, False, "owner_attention",
    )
