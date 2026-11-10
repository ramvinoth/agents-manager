"""The owner's attention cap (viewer.queue): the owner sees at most `cap`
decisions at a time; the rest are held — open, never dropped, but silent (no
push, no badge) — and surface oldest first as slots free."""
import pytest

from viewer import inbox, queue

NOW = 1_000_000.0


def _item(ref, snoozed=0):
    return {"kind": "question", "tool_use_id": ref, "session": "s1",
            "summary": "x", "snoozed_until": snoozed}


def _row(ref, id, created, kind="question"):
    return {"id": id, "kind": kind, "ref_id": ref, "status": "sent",
            "snoozed_until": 0, "created_at": created, "body": "b",
            "sender_type": "session", "sender_id": "s1",
            "recipient_type": "user", "recipient_id": ""}


ITEMS = [_item(f"q{i}") for i in range(5)]          # oldest first
ROWS = [_row(f"q{i}", i + 1, 10 + i) for i in range(5)]


def test_visible_queue_shows_the_oldest_cap_and_counts_the_held():
    v = inbox.visible_queue(ITEMS, 3)
    assert [i["tool_use_id"] for i in v["decisions"]] == ["q0", "q1", "q2"]
    assert v["count"] == 3 and v["held"] == 2 and v["cap"] == 3


def test_a_snooze_frees_a_slot_for_the_next_held_item():
    items = [_item("q0", snoozed=NOW + 600)] + ITEMS[1:]
    v = inbox.visible_queue(items, 3)
    assert [i["tool_use_id"] for i in v["decisions"]] == ["q1", "q2", "q3"]
    assert v["held"] == 1


def test_no_cap_shows_everything():
    v = inbox.visible_queue(ITEMS)
    assert v["count"] == 5 and v["held"] == 0


def test_badge_counts_only_shown_decisions_but_every_message():
    msg = dict(_row("", 99, 1, kind="message"))
    assert inbox.unread_count(ROWS + [msg], ITEMS, NOW, cap=3) == 4
    assert inbox.unread_count(ROWS + [msg], ITEMS, NOW) == 6


def test_inbox_queue_and_decision_deck_show_the_same_few():
    q = inbox.action_queue(ROWS, ITEMS, NOW, cap=2)
    assert [r["ref_id"] for r in q["items"]] == ["q0", "q1"]
    assert q["count"] == 2 and q["held"] == 3


@pytest.fixture
def stored(monkeypatch):
    box = {}
    monkeypatch.setattr(queue.db, "setting_get", lambda k, d=None: box.get(k, d))
    monkeypatch.setattr(queue.db, "setting_set", lambda k, v: box.__setitem__(k, v))
    return box


def test_cap_defaults_to_three_and_tolerates_junk(stored):
    assert queue.cap() == 3
    stored["decision_queue"] = {"cap": "lots"}
    assert queue.cap() == 3
    stored["decision_queue"] = {"cap": 999}
    assert queue.cap() == queue.MAX_CAP
    stored["decision_queue"] = {"cap": 0}
    assert queue.cap() == 1


def test_set_cap_accepts_only_whole_numbers_in_range(stored):
    assert queue.set_cap(5) == 5 and queue.cap() == 5
    for bad in (0, 21, True, 2.5, "3", None):
        with pytest.raises(ValueError):
            queue.set_cap(bad)
    assert queue.cap() == 5


def _queue_of(monkeypatch, items, cap=3):
    monkeypatch.setattr(queue, "open_items", lambda: items)
    monkeypatch.setattr(queue, "cap", lambda: cap)


def test_admits_only_what_the_owner_sees(monkeypatch):
    _queue_of(monkeypatch, ITEMS)
    assert queue.admits("question", "q2")
    assert not queue.admits("question", "q3")
    assert "3 decisions at a time and 2 more" in queue.full_warning("question", "q4")
    assert queue.full_warning("question", "q0") == ""


def test_an_item_not_listed_yet_is_admitted_only_while_there_is_room(monkeypatch):
    _queue_of(monkeypatch, ITEMS[:2])
    assert queue.admits("card", "53")
    _queue_of(monkeypatch, ITEMS[:3])
    assert not queue.admits("card", "53")


def test_an_unreadable_queue_admits(monkeypatch):
    def boom():
        raise RuntimeError("db down")
    monkeypatch.setattr(queue, "open_items", boom)
    assert queue.admits("question", "q9")
    assert queue.full_warning("question", "q9") == ""
