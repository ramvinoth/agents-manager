"""Focused contract tests for the side-effect-free executive briefing."""
from orchestrator import executive_briefing as briefing


def _schedule(ident, **extra):
    return {
        "id": ident, "card_id": ident + 100, "status": "planned",
        "priority": "normal", "starts_at": None, "due_at": float(ident),
        "owner_commitment": False, "revision": 1, **extra,
    }


def test_build_bounds_and_redacts_vendor_and_free_message_fields(monkeypatch):
    monkeypatch.setattr(briefing.delivery_repository, "schedule_list",
                        lambda project: [_schedule(i) for i in range(10, 0, -1)])

    class Gmail:
        def search(self, q, limit, timeout):
            assert (q, limit, timeout) == ("in:inbox is:unread", briefing.MAX_GMAIL_ITEMS,
                                           briefing.VENDOR_TIMEOUT)
            return {"messages": [{"id": "m1", "from": "sender@example.test",
                                  "subject": "Hello", "date": "today",
                                  "snippet": "private preview", "body": "never"}]}

    class Calendar:
        def events(self, start, end, q, calendar, limit, timeout):
            assert (limit, timeout) == (briefing.MAX_CALENDAR_ITEMS, briefing.VENDOR_TIMEOUT)
            return {"events": [{"id": "e1", "title": "Focus time", "start": "2026-01-01T10:00:00-08:00",
                                "end": "2026-01-01T11:00:00-08:00", "all_day": False,
                                "description": "private", "location": "private",
                                "attendees": ["private@example.test"]}]}

    def open_(service, op, **kwargs):
        assert op == "read"
        return (Gmail() if service == "google.gmail" else Calendar()), {"id": "c"}

    monkeypatch.setattr(briefing.service_access, "open_client", open_)
    answer = briefing.build(
        project_id=1,
        inbox_rows=[{"id": 1, "kind": "message", "body": "do not disclose", "created_at": 1}],
        decisions=[{"kind": "plan", "summary": "Approve work", "waiting_s": 5}],
        decision_cap=3,
    )

    assert answer["delivery"]["source"]["state"] == "available"
    assert [item["schedule_id"] for item in answer["delivery"]["items"]] == [1, 2, 3, 4, 5]
    assert answer["inbox"]["items"] == [{"id": 1, "kind": "message", "created_at": 1, "status": "sent"}]
    assert answer["decisions"]["visible"] == [{"kind": "plan", "summary": "Approve work", "waiting_s": 5}]
    assert answer["gmail"]["items"][0] == {"id": "m1", "from": "sender@example.test", "subject": "Hello", "date": "today"}
    event = answer["calendar"]["items"][0]
    assert set(event) == {"id", "title", "start", "end", "all_day"}
    assert "private" not in str(answer) and "do not disclose" not in str(answer)


def test_call_facts_exclude_source_titles_and_message_identifiers():
    facts = briefing.render_call_facts({
        "delivery": {"source": {"state": "available"}, "items": [
            {"card_id": 9, "due_at": 10, "priority": "high"}]},
        "inbox": {"source": {"state": "available"}, "items": [{"id": 88}]},
        "decisions": {"source": {"state": "available"}, "shown": 1, "held": 2},
        "gmail": {"source": {"state": "available"}, "items": [
            {"id": "m1", "from": "private@example.test", "subject": "Secret"}]},
        "calendar": {"source": {"state": "available"}, "items": [
            {"id": "e1", "title": "Private meeting"}]},
    })
    assert "card 9" in facts and "Gmail: 1 unread" in facts
    assert "private@example.test" not in facts
    assert "Secret" not in facts and "Private meeting" not in facts and "m1" not in facts


def test_vendor_or_delivery_failures_remain_explicit_not_empty_success(monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError("credential details must not leak")

    monkeypatch.setattr(briefing.delivery_repository, "schedule_list", fail)
    monkeypatch.setattr(briefing.service_access, "open_client", fail)
    answer = briefing.build(project_id=None, inbox_rows=[], decisions=[], decision_cap=3)

    for source in ("delivery", "gmail", "calendar"):
        assert answer[source]["source"] == {"state": "unavailable", "error": "RuntimeError"}
        assert answer[source]["items"] == []
    assert "credential" not in str(answer)


def test_current_uses_strict_decision_reader_without_inbox_materialization(monkeypatch):
    seen = {}
    monkeypatch.setattr(briefing.db, "inbox_list", lambda **kwargs: seen.setdefault("inbox", []))
    monkeypatch.setattr(briefing.queue, "cap", lambda: 3)

    def open_(**kwargs):
        seen.update(kwargs)
        return []

    monkeypatch.setattr(briefing.queue, "open_items", open_)
    monkeypatch.setattr(briefing.delivery_repository, "schedule_list", lambda project: [])
    monkeypatch.setattr(briefing.service_access, "open_client", lambda *a, **k: (_ for _ in ()).throw(RuntimeError()))
    briefing.current(project_id=1)
    assert seen == {"inbox": [], "materialize_missing_red": False}


def test_decision_cap_reports_held_without_queue_materialization(monkeypatch):
    monkeypatch.setattr(briefing.delivery_repository, "schedule_list", lambda project: [])
    monkeypatch.setattr(briefing.service_access, "open_client", lambda *a, **k: (_ for _ in ()).throw(RuntimeError()))
    decisions = [{"kind": "question", "summary": f"Question {i}", "waiting_s": i}
                 for i in range(4)]
    answer = briefing.build(project_id=None, inbox_rows=[], decisions=decisions, decision_cap=2)

    assert answer["decisions"]["shown"] == 2
    assert answer["decisions"]["held"] == 2
    assert len(answer["decisions"]["visible"]) == 2
