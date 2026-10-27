"""Unit tests for the pure shaping logic in viewer/inbox.py:
- effective_status: a lapsed snooze reads 'sent' again (skipped is never dropped).
- open_ref_set: decision-queue items collapse to 'kind:ref' match keys.
- attach_state: a decision row is 'open' only while its durable source is open;
  message rows are never open.
- action_queue: open + not-snoozed, oldest first, with the total count.
- the cold-reader formatters: every body names sender, thing and what is asked.

No Postgres, no clock: time is injected, and the formatters take plain dicts.
"""

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


# ---- attach_snooze / visible_queue (one snooze, every surface) ---------------

def _item(kind, ref):
    key = inbox.REF_FIELD[kind]
    return {"kind": kind, "session": "s1", key: ref, "summary": "x"}


def test_attach_snooze_joins_inbox_id_and_live_snooze():
    items = [_item("question", "tq"), _item("card", 53), _item("approval", "a1")]
    rows = [{"kind": "question", "ref_id": "tq", "id": 7, "status": "snoozed",
             "snoozed_until": NOW + 60},
            {"kind": "card", "ref_id": "53", "id": 9, "status": "sent", "snoozed_until": 0}]
    out = inbox.attach_snooze(items, rows, NOW)
    assert [(i["inbox_id"], i["snoozed_until"]) for i in out] == [
        (7, NOW + 60),   # live snooze → held
        (9, 0),          # delivered, not snoozed
        (0, 0),          # no inbox row at all (delivery failed) → never snoozed
    ]


def test_attach_snooze_lapsed_snooze_is_over():
    (i,) = inbox.attach_snooze([_item("plan", "tp")],
                               [{"kind": "plan", "ref_id": "tp", "id": 3,
                                 "status": "snoozed", "snoozed_until": NOW - 1}], NOW)
    assert i["inbox_id"] == 3 and i["snoozed_until"] == 0


def test_attach_snooze_does_not_mutate_input():
    src = [_item("question", "tq")]
    inbox.attach_snooze(src, [], NOW)
    assert "inbox_id" not in src[0]


def test_visible_queue_hides_live_snoozes_but_attach_state_keeps_them_open():
    items = inbox.attach_snooze(
        [_item("question", "tq"), _item("plan", "tp")],
        [{"kind": "question", "ref_id": "tq", "id": 1, "status": "snoozed",
          "snoozed_until": NOW + 60}], NOW)
    shown = inbox.visible_queue(items)
    assert shown["count"] == 1 and shown["decisions"][0]["kind"] == "plan"
    # The snoozed question is deferred, not decided: its inbox row still reads open.
    (row,) = inbox.attach_state([_row("question", "tq", "snoozed", NOW + 60)], items, NOW)
    assert row["open"] is True and row["snoozed"] is True


def test_unread_count_skips_closed_decisions_and_read_rows():
    rows = [
        _row("message", None, "sent", id=1),
        _row("question", "q1", "sent", id=2),           # still open -> counts
        _row("question", "q2", "sent", id=3),           # answered -> history
        _row("card", "7", "read", id=4),                # read -> never counts
        _row("approval", "a1", "snoozed", snoozed_until=NOW - 1, id=5),  # lapsed + open
        _row("approval", "a2", "snoozed", snoozed_until=NOW + 60, id=6), # live snooze
    ]
    items = [_item("question", "q1"), _item("approval", "a1"), _item("approval", "a2")]
    assert inbox.unread_count(rows, items, NOW) == 3


def test_unread_count_only_counts_rows_addressed_to_the_owner():
    outgoing = dict(_row("message", None, "sent", id=1), sender_type="user",
                    recipient_type="session", recipient_id="s1")
    peer = dict(_row("message", None, "sent", id=2), recipient_type="session")
    assert inbox.unread_count([outgoing, peer, _row(id=3)], [], NOW) == 1


# ── deliver_message: the sender's ack never waits on the wake ─────────────

def test_deliver_returns_before_a_slow_wake(monkeypatch):
    import threading
    gate, woke = threading.Event(), threading.Event()
    monkeypatch.setattr(inbox.db, "inbox_create", lambda *a, **k: {"id": 1})
    monkeypatch.setattr(inbox.db, "audit_append", lambda *a, **k: None)
    monkeypatch.setattr(inbox, "session_project", lambda sid: None)
    monkeypatch.setattr(inbox, "_push_owner", lambda *a, **k: None)
    monkeypatch.setattr(inbox, "_label", lambda sid: "S")

    def slow_wake(sid, prompt):  # a resume that reads a huge transcript
        gate.wait(5)
        woke.set()
    monkeypatch.setattr(inbox, "_wake_session", slow_wake)

    assert inbox.deliver_message("user", "", "session", "s1", "hi") == {"id": 1}
    assert not woke.is_set()          # returned while the wake is still running
    gate.set()
    assert woke.wait(5)               # and the wake still happens


# ---- org Red approvals -------------------------------------------------------

def test_red_is_a_decision_kind_keyed_by_approval_id():
    assert "red" in inbox.DECISION_KINDS and "message" not in inbox.DECISION_KINDS
    assert inbox.decision_ref({"kind": "red", "id": "7"}) == "red:7"
    rows = inbox.attach_state([_row(kind="red", ref_id="7")], [{"kind": "red", "id": "7"}], NOW)
    assert rows[0]["open"] is True
    rows = inbox.attach_state([_row(kind="red", ref_id="7")], [], NOW)
    assert rows[0]["open"] is False


def test_red_and_tool_approval_refs_never_collide():
    items = [{"kind": "approval", "id": "3"}]
    rows = inbox.attach_state([_row(kind="red", ref_id="3")], items, NOW)
    assert rows[0]["open"] is False


def test_format_red_asks_first_and_names_cost_and_asker():
    body = inbox.format_red("Delete card", "#12 Fix login", "Deleted for good.", "session:Harman")
    first = body.splitlines()[0]
    assert first == "Approve or deny: Delete card: #12 Fix login"
    assert "session:Harman" in body and "Deleted for good." in body


def test_format_red_carries_the_askers_why_or_says_it_is_missing():
    body = inbox.format_red("Delete card", "#12", "Deleted for good.", "s", "it is a duplicate")
    lines = body.splitlines()
    assert lines[0] == "Approve or deny: Delete card: #12", "the ask stays first"
    assert "Why: it is a duplicate" in lines
    assert any(l.startswith("Why: no reason given") for l in
               inbox.format_red("Delete card", "#12", "", "s").splitlines())


def test_red_reason_folds_whitespace_caps_length_and_tolerates_junk():
    assert inbox.red_reason({"args": {"reason": " a\n  b "}}) == "a b"
    assert len(inbox.red_reason({"args": {"reason": "x" * 999}})) == 300
    assert inbox.red_reason({}) == inbox.red_reason(None) == ""


def test_red_subject_names_nothing_for_unknown_or_argless_actions():
    assert inbox.red_subject({"action": "restart_now", "args": {}}) == ""
    assert inbox.red_subject({}) == ""


def test_red_subject_names_a_level_in_words_not_its_key(monkeypatch):
    monkeypatch.setattr(inbox, "_label", lambda s: s)
    ask = lambda lv: inbox.red_subject({"action": "session_level_set",
                                        "args": {"session": "s1", "level": lv}})
    assert ask("ic") == "s1 → Own work", "the internal key never reaches the owner"
    assert ask("lead") == "s1 → Workspace"
    assert ask("") == "s1 → the agent it was started from"
