"""Card 235: one open ask per card, and asks that run out of time.

Three layers, all without a database:
  - orchestrator.asks — the pure rules (when an ask opens, closes, is a second ask,
    has expired);
  - actions' card_move / card_comment / card_update — the handlers that apply
    them, with `expires_at` validation and the split warning;
  - decisions.open_decisions + board_wake.expire_asks — an expired ask leaves
    the queue at once, and its session is told exactly once.
"""
import time
from types import SimpleNamespace

import pytest

from orchestrator import actions, asks, board_wake, boardwatch, decisions, inbox, orglogic, push

NOW = 1_800_000_000.0


# ── orchestrator.asks: the pure rules ────────────────────────────────────────────

def test_decision_columns_match_by_name():
    assert asks.is_decision_column("Review") and asks.is_decision_column(" needs-info ")
    assert not asks.is_decision_column("Doing") and not asks.is_decision_column(None)


def test_parse_expiry_accepts_offsets_and_local_times():
    assert asks.parse_expiry(None, NOW) == (None, None)
    assert asks.parse_expiry("  ", NOW) == (None, None)
    assert asks.parse_expiry("2h", NOW) == (NOW + 7200, None)
    when, err = asks.parse_expiry("2027-03-01 09:00", NOW)
    assert err is None and when > NOW


def test_parse_expiry_refuses_garbage_and_the_past():
    assert asks.parse_expiry("next tuesday-ish", NOW)[1].startswith("bad expires_at")
    assert "past" in asks.parse_expiry("2020-01-01", NOW)[1]


def test_is_expired():
    assert asks.is_expired(NOW - 1, NOW) and asks.is_expired(NOW, NOW)
    assert not asks.is_expired(NOW + 1, NOW)
    assert not asks.is_expired(0, NOW) and not asks.is_expired(None, NOW)
    assert not asks.is_expired("junk", NOW)


def test_after_move_opens_only_for_an_agent_moving_into_a_decision_column():
    assert asks.after_move(True, True, NOW + 60, NOW) == (NOW, NOW + 60)
    assert asks.after_move(True, True, None, NOW) == (NOW, 0.0)
    assert asks.after_move(True, False, None, NOW) == (0.0, 0.0), "a human move ends the ask"
    assert asks.after_move(False, True, None, NOW) == (0.0, 0.0), "leaving the column ends it"


def test_after_comment_rules():
    open_ask = (NOW - 100, NOW + 500)
    # a human comment answers whatever was open
    assert asks.after_comment(open_ask, False, True, True, None, NOW) == ((0.0, 0.0), False)
    # outside a decision column a comment asks nothing
    assert asks.after_comment(open_ask, True, False, True, None, NOW) == (open_ask, False)
    # no open ask: the agent's comment opens one
    assert asks.after_comment((0, 0), True, True, False, NOW + 60, NOW) == ((NOW, NOW + 60), False)
    # the move raised the ask, this comment words it: the move's deadline holds
    assert asks.after_comment(open_ask, True, True, False, None, NOW) == (open_ask, False)
    # ...unless the comment gives its own
    assert asks.after_comment(open_ask, True, True, False, NOW + 9, NOW) == ((NOW - 100, NOW + 9), False)
    # already worded: this is a second ask — it becomes the newest, flagged
    assert asks.after_comment(open_ask, True, True, True, None, NOW) == ((NOW, 0.0), True)


def test_has_open_ask_text_counts_only_session_comments_since_the_ask():
    rows = [{"author": "session:a", "created_at": NOW - 10},
            {"author": "user:ram", "created_at": NOW + 5}]
    assert not asks.has_open_ask_text(rows, NOW), "older agent text, newer human text"
    assert asks.has_open_ask_text(rows + [{"author": "session:b", "created_at": NOW}], NOW)
    assert not asks.has_open_ask_text(rows, 0), "no open ask"


def test_expired_message_tells_the_session_what_to_do():
    msg = asks.expired_message({"id": 7, "title": "Renew"}, NOW)
    assert "card 7" in msg and "Renew" in msg
    assert "decide yourself, or re-ask with new facts" in msg


# ── the handlers ───────────────────────────────────────────────────────────

def _col(name, position, cid):
    return {"id": cid, "name": name, "position": position}


COLS = [_col(n, i, 10 + i) for i, n in enumerate(orglogic.PIPELINE_COLUMNS)]
COL = {c["name"].lower(): c["id"] for c in COLS}


class AskBoard:
    """The db surface card_move / card_comment / card_update touch."""

    def __init__(self, column="doing"):
        self.card = {"id": 42, "session_id": "sess-1", "project_id": 7,
                     "column_id": COL[column], "title": "Renew the lease",
                     "ask_since": 0.0, "ask_expires_at": 0.0}
        self.comments = []

    def card_get(self, card_id):
        return dict(self.card) if card_id == 42 else None

    def board_columns_list(self, project_id):
        return list(COLS)

    def card_last_move(self, card_id, seconds):
        return None

    def card_move(self, card_id, column_id, position=1.0):
        self.card.update(column_id=column_id, position=position)
        return dict(self.card)

    def card_update(self, card_id, **fields):
        self.card.update(fields)
        return dict(self.card)

    def card_ask_set(self, card_id, ask_since, ask_expires_at):
        self.card.update(ask_since=ask_since, ask_expires_at=ask_expires_at)

    def card_comment_list(self, card_id):
        return list(self.comments)

    def card_comment_add(self, card_id, author, body):
        row = {"id": len(self.comments) + 1, "card_id": card_id, "author": author,
               "body": body, "created_at": time.time()}
        self.comments.append(row)
        return row

    def card_mark_attention(self, card_id, by_own_session):
        pass

    def audit_append(self, *a):
        pass


@pytest.fixture
def board(monkeypatch):
    f = AskBoard()
    monkeypatch.setattr(actions, "db", f)
    monkeypatch.setattr(boardwatch, "schedule_wake", lambda card, event, origin: "bw42")
    monkeypatch.setattr(push, "notify_all", lambda *a, **k: None)
    return f


def _agent(action, args):
    return actions.execute(actions.intent(action, args, "session:bob"),
                           "owner", "ic", acting_session="sess-1")


def _human(action, args):
    return actions.execute(actions.intent(action, args, "user:ram"), "owner", "")


def test_agent_move_into_review_opens_a_timed_ask(board):
    resp, status = _agent("card_move", {"card_id": 42, "column_id": COL["review"],
                                        "expires_at": "2h"})
    assert status == 200 and resp["ask_since"] > 0
    assert board.card["ask_expires_at"] == pytest.approx(time.time() + 7200, abs=5)


def test_bad_expires_at_refuses_the_move(board):
    resp, _ = _agent("card_move", {"card_id": 42, "column_id": COL["review"],
                                   "expires_at": "soonish"})
    assert "bad expires_at" in resp["error"]
    assert board.card["column_id"] == COL["doing"], "a refused ask must not move the card"


def test_expires_at_outside_an_ask_is_refused(board):
    resp, _ = _agent("card_move", {"card_id": 42, "column_id": COL["todo"],
                                   "expires_at": "2h"})
    assert "only applies to an ask" in resp["error"]
    resp, _ = _human("card_move", {"card_id": 42, "column_id": COL["review"],
                                   "expires_at": "2h"})
    assert "only applies to an ask" in resp["error"], "the owner does not ask himself"


def test_one_card_one_ask_second_ask_is_told_to_split(board):
    _agent("card_move", {"card_id": 42, "column_id": COL["review"], "expires_at": "1d"})
    first, _ = _agent("card_comment", {"card_id": 42, "body": "Renew at the new rate?",
                                       "author": "session:bob"})
    assert "warning" not in first, "the first comment words the move's ask"
    deadline = board.card["ask_expires_at"]
    assert deadline > 0, "wording the ask keeps the move's deadline"
    second, _ = _agent("card_comment", {"card_id": 42, "body": "Also: switch insurers?",
                                        "author": "session:bob"})
    assert second["warning"] == asks.SPLIT_WARNING
    assert board.card["ask_expires_at"] == 0, "the newest ask carries its own (no) deadline"


def test_owner_answer_closes_the_ask_and_the_next_agent_comment_is_a_fresh_one(board):
    _agent("card_move", {"card_id": 42, "column_id": COL["review"]})
    _agent("card_comment", {"card_id": 42, "body": "Q1?", "author": "session:bob"})
    _human("card_comment", {"card_id": 42, "body": "yes", "author": "user:ram"})
    assert board.card["ask_since"] == 0
    resp, _ = _agent("card_comment", {"card_id": 42, "body": "Q2?", "author": "session:bob"})
    assert "warning" not in resp and board.card["ask_since"] > 0


def test_comment_expiry_outside_a_decision_column_is_refused(board):
    resp, _ = _agent("card_comment", {"card_id": 42, "body": "fyi", "expires_at": "1h",
                                      "author": "session:bob"})
    assert "only applies to an ask" in resp["error"]
    assert board.comments == [], "refused before anything was written"


def test_task_done_and_a_column_change_by_update_end_the_ask(board):
    _agent("card_move", {"card_id": 42, "column_id": COL["review"], "expires_at": "1h"})
    _human("card_update", {"card_id": 42, "column_id": COL["doing"]})
    assert (board.card["ask_since"], board.card["ask_expires_at"]) == (0, 0)
    _agent("card_move", {"card_id": 42, "column_id": COL["review"], "expires_at": "1h"})
    _agent("task_done", {"card_id": 42})
    assert (board.card["ask_since"], board.card["ask_expires_at"]) == (0, 0)


# ── the queue and the expiry pass ──────────────────────────────────────────

def _card_row(**kw):
    row = {"id": 53, "title": "Renew", "session_id": "sc", "project_id": 15,
           "updated_at": NOW - 900, "column_name": "Review", "waiting_since": NOW - 60,
           "ask": "Renew at the new rate?", "ask_expires_at": 0}
    row.update(kw)
    return row


def test_the_queue_shows_the_newest_ask_and_its_deadline():
    (d,) = decisions.open_decisions([], [], [], {}, NOW,
                                    card_rows=[_card_row(ask_expires_at=NOW + 60)])["decisions"]
    assert d["ask"] == "Renew at the new rate?" and d["expires_at"] == NOW + 60


def test_an_expired_ask_leaves_the_queue_even_before_the_pass_runs():
    assert decisions.open_decisions([], [], [], {}, NOW,
                                    card_rows=[_card_row(ask_expires_at=NOW - 1)])["decisions"] == []


class ExpiryDB:
    def __init__(self, rows):
        self.rows, self.asks, self.audit = rows, [], []

    def cards_asks_expired(self, now):
        return [r for r in self.rows if r["ask_since"] > 0 and 0 < r["ask_expires_at"] <= now]

    def card_ask_set(self, card_id, since, exp):
        self.asks.append((card_id, since, exp))
        for r in self.rows:
            if r["id"] == card_id:
                r.update(ask_since=since, ask_expires_at=exp)

    def audit_append(self, *a):
        self.audit.append(a)


@pytest.fixture
def expiry(monkeypatch):
    rows = [{"id": 1, "title": "Renew", "session_id": "sa", "ask_since": NOW - 900,
             "ask_expires_at": NOW - 5},
            {"id": 2, "title": "Later", "session_id": "sb", "ask_since": NOW - 900,
             "ask_expires_at": NOW + 900},
            {"id": 3, "title": "Orphan", "session_id": None, "ask_since": NOW - 900,
             "ask_expires_at": NOW - 5}]
    f = ExpiryDB(rows)
    sent = []
    monkeypatch.setattr(board_wake, "db", f)
    monkeypatch.setattr(board_wake, "_expiry_last", [0.0])
    monkeypatch.setattr(inbox, "deliver_message",
                        lambda st, sid, rt, rid, body, wake=True: sent.append((rid, body, wake)) or {"id": 1})
    return SimpleNamespace(db=f, sent=sent)


def test_expiry_pass_tells_each_session_once(expiry):
    assert board_wake.expire_asks(NOW, wake=False) == [1, 3]
    assert [(rid, wake) for rid, _, wake in expiry.sent] == [("sa", False)], \
        "only a card with a session is told; the resume follows the caller's gate"
    assert "re-ask with new facts" in expiry.sent[0][1]
    assert (1, 0, NOW - 5) in expiry.db.asks, "deadline kept so the queue keeps hiding it"
    assert board_wake.expire_asks(NOW + 60) == [], "never told twice"
    assert len(expiry.sent) == 1


def test_expiry_pass_is_throttled_to_the_tick_budget(expiry):
    board_wake.expire_asks(NOW)
    expiry.db.rows[1]["ask_expires_at"] = NOW + 1
    assert board_wake.expire_asks(NOW + 2) == [], "inside EXPIRY_INTERVAL: no pass"
    assert board_wake.expire_asks(NOW + board_wake.EXPIRY_INTERVAL + 2) == [2]


def test_a_failed_delivery_is_retried_on_the_next_pass(expiry, monkeypatch):
    monkeypatch.setattr(inbox, "deliver_message", lambda *a, **k: None)
    assert 1 not in board_wake.expire_asks(NOW)
    assert expiry.db.rows[0]["ask_since"] > 0, "still open: the next pass retries"
