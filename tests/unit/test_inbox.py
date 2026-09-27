"""Unit tests for the pure shaping logic in viewer/inbox.py:
- effective_status: a lapsed snooze reads 'sent' again (skipped is never dropped).
- open_ref_set: decision-queue items collapse to 'kind:ref' match keys.
- attach_state: a decision row is 'open' only while its durable source is open;
  message rows are never open.
- action_queue: open + not-snoozed, oldest first, with the total count.
- the cold-reader formatters: every body names sender, thing and what is asked.

No Postgres, no clock: time is injected, and the formatters take plain dicts.
"""
import pytest

from viewer import inbox

NOW = 1_000_000.0


def _row(kind="message", ref_id="", status="sent", snoozed_until=0, id=1, created=10.0):
    return {"id": id, "kind": kind, "ref_id": ref_id, "status": status,
            "snoozed_until": snoozed_until, "created_at": created,
            "body": "b", "sender_type": "session", "sender_id": "s1",
            "recipient_type": "user", "recipient_id": ""}


# ---- effective_status --------------------------------------------------------

def test_snoozed_within_window_stays_snoozed():
    row = _row(status="snoozed", snoozed_until=NOW + 60)
    assert inbox.effective_status(row, NOW) == "snoozed"


def test_lapsed_snooze_resurfaces_as_sent():
    row = _row(status="snoozed", snoozed_until=NOW - 1)
    assert inbox.effective_status(row, NOW) == "sent"


def test_plain_statuses_pass_through():
    assert inbox.effective_status(_row(status="sent"), NOW) == "sent"
    assert inbox.effective_status(_row(status="read"), NOW) == "read"


# ---- open_ref_set ------------------------------------------------------------

def test_open_ref_set_maps_each_kind_to_its_source_ref():
    items = [
        {"kind": "question", "tool_use_id": "tq1"},
        {"kind": "plan", "tool_use_id": "tp1"},
        {"kind": "approval", "id": "a1"},
        {"kind": "card", "card": "42"},
        {"kind": "question", "tool_use_id": None},  # no ref -> dropped
    ]
    assert inbox.open_ref_set(items) == {"question:tq1", "plan:tp1",
                                        "approval:a1", "card:42"}


def test_open_ref_set_empty():
    assert inbox.open_ref_set(None) == set()
    assert inbox.open_ref_set([]) == set()


# ---- attach_state ------------------------------------------------------------

def test_decision_row_open_only_while_source_open():
    rows = [_row(kind="question", ref_id="tq1"), _row(kind="plan", ref_id="tp1")]
    out = inbox.attach_state(rows, [{"kind": "question", "tool_use_id": "tq1"}], NOW)
    assert out[0]["open"] is True
    assert out[1]["open"] is False  # its plan is no longer open


def test_decision_row_without_ref_never_open():
    out = inbox.attach_state([_row(kind="question", ref_id="")],
                             [], NOW)
    assert out[0]["open"] is False


def test_message_rows_are_never_open():
    out = inbox.attach_state([_row(kind="message")],
                             [{"kind": "question", "tool_use_id": "t"}], NOW)
    assert out[0]["open"] is None
    assert out[0]["snoozed"] is False


def test_snoozed_flag_follows_effective_status():
    rows = [_row(status="snoozed", snoozed_until=NOW + 999),
            _row(status="snoozed", snoozed_until=NOW - 5)]
    out = inbox.attach_state(rows, [], NOW)
    assert out[0]["snoozed"] is True
    assert out[1]["snoozed"] is False  # lapsed -> resurfaced


# ---- action_queue ------------------------------------------------------------

def test_action_queue_lists_open_unsnoozed_oldest_first_with_count():
    rows = [
        _row(kind="question", ref_id="tq2", created=30),
        _row(kind="question", ref_id="tq1", created=10),
        _row(kind="plan", ref_id="tp1", created=20),
        _row(kind="question", ref_id="tq3", status="snoozed",
             snoozed_until=NOW + 999, created=5),
        _row(kind="message", created=1),
    ]
    open_items = [{"kind": r["kind"], "tool_use_id": r["ref_id"]}
                  for r in rows[:3]]
    q = inbox.action_queue(rows, open_items, NOW)
    # the snoozed question and the free message stay out; count is the total
    assert q["count"] == 3
    assert [i["ref_id"] for i in q["items"]] == ["tq1", "tp1", "tq2"]


def test_action_queue_empty_when_nothing_open():
    q = inbox.action_queue([_row(kind="question", ref_id="tq1")], [], NOW)
    assert q["count"] == 0
    assert q["items"] == []


# ---- formatters (cold-reader standard) ---------------------------------------

def test_format_question_names_sender_and_options():
    qs = [{"question": "Which model?", "header": "Model",
           "options": [{"label": "A", "description": "fast"},
                       {"label": "B"}]}]
    body = inbox.format_question("Jarvis", qs)
    assert "Jarvis" in body
    assert "Which model?" in body
    assert "A — fast" in body and "B" in body


def test_format_question_multi_question_preface_only_first():
    qs = [{"question": "q1?", "options": [{"label": "a"}]},
          {"question": "q2?", "options": [{"label": "b"}]}]
    body = inbox.format_question("X", qs)
    assert body.count("What I need from you:") == 1
    assert "q1?" in body and "q2?" in body


def test_format_plan_truncates_long_bodies():
    body = inbox.format_plan("Jarvis", "p" * 5000)
    assert len(body) < 2200
    assert "awaiting your approval" in body


def test_format_approval_names_tool():
    body = inbox.format_approval("Worker", "Bash", "rm -rf /tmp/x")
    assert "Worker" in body
    assert "Bash" in body
    assert "rm -rf /tmp/x" in body


def test_format_card_carries_comment_verbatim():
    card = {"id": 92, "title": "Inbox feature", "column_name": "Review"}
    body = inbox.format_card(card, "Can you approve the mobile tab order?")
    assert 'Card 92 "Inbox feature" is in Review' in body
    assert "Can you approve the mobile tab order?" in body


def test_format_card_without_comment():
    card = {"id": 5, "title": "t"}
    body = inbox.format_card(card)
    assert "the call is yours" in body
    assert body.count("\n") <= 1  # no dangling context section
