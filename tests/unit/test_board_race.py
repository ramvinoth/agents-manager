"""Race resilience of board writes — when a human and an agent edit the same card.

The incident (card 25, 2026-09-19): the owner dragged a card to a column, and an
agent `task_done` seconds later silently overwrote the move — the owner's
judgement was lost with no word. The rules this file pins down:

- a HUMAN's column write always lands (they are the decider);
- an AGENT may not move a card INTO or OUT OF a judgement column
  (Approved / Declined, by the board's name contract) — it comments instead;
- an AGENT may not move a card to a different column than one a different
  writer just moved it to (within _RECENT_MOVE_WINDOW) — it comments instead.

Everything faked: the guards are pure policy over the db primitives
(card_get / board_columns_list / card_last_move / card_move).
"""
import time

import pytest

from viewer import actions, boardwatch

NOW = time.time()
HUMAN, AGENT = ("owner", ""), ("owner", "ic")


CARD = {"id": 25, "session_id": "sess-9", "title": "life-dashboard refresh",
        "project_id": 16, "column_id": 101, "position": 1.0}

# Project 16's live columns (verified 2026-09-19) — the name contract matters:
# "Approved"/"Declined" are the judgement pair, "Done" is terminal.
COLS = [
    {"id": 42, "name": "Todo", "position": 0},
    {"id": 43, "name": "Doing", "position": 1},
    {"id": 44, "name": "Review", "position": 2},
    {"id": 98, "name": "Approved", "position": 3},
    {"id": 99, "name": "Declined", "position": 4},
    {"id": 100, "name": "Blocked", "position": 5},
    {"id": 101, "name": "Needs-info", "position": 6},
    {"id": 45, "name": "Done", "position": 7},
]


class FakeRaceBoard:
    def __init__(self, last_move=None):
        self.card = dict(CARD)
        # (column_id, epoch) of the last column-moving write — emulates the
        # audit-derived db.card_last_move, including its window filter.
        self.last_move = last_move
        self.moved = []

    def card_get(self, card_id):
        return dict(self.card) if self.card.get("id") == card_id else None

    def board_columns_list(self, project_id):
        return [dict(c) for c in COLS]

    def card_last_move(self, card_id, seconds):
        if self.last_move and (time.time() - self.last_move[1]) <= seconds:
            return self.last_move
        return None

    def card_move(self, card_id, column_id, position=1.0):
        self.moved.append((card_id, column_id))
        self.card["column_id"] = column_id
        return dict(self.card)

    def audit_append(self, *a):
        pass


@pytest.fixture
def fdb(monkeypatch):
    f = FakeRaceBoard()
    monkeypatch.setattr(actions, "db", f)
    # NOW is captured at import; the "Ns ago" text compares int(elapsed), so
    # a >1s gap between collection and this test flipped 20s into 21s.
    monkeypatch.setattr(time, "time", lambda: NOW)
    wakes = []
    monkeypatch.setattr(boardwatch, "schedule_wake",
                        lambda card, event, origin: (wakes.append((event, origin)) or "bw25"))
    return f


def _move(card_id, column_id, roles):
    return actions.execute(
        actions.intent("card_move", {"card_id": card_id, "column_id": column_id},
                       "sess-9" if roles is AGENT else "user:ram"),
        roles[0], roles[1])


def _done(card_id, roles):
    return actions.execute(
        actions.intent("task_done", {"card_id": card_id},
                       "sess-9" if roles is AGENT else "user:ram"),
        roles[0], roles[1])


# ── judgement columns are the owner's, structurally ─────────────────────────

def test_agent_cannot_move_into_approved(fdb):
    resp, status = _move(25, 98, AGENT)
    assert status == 200 and "owner's judgement" in resp["error"]
    assert fdb.moved == [], "the row must NOT be written"


def test_agent_cannot_move_into_declined(fdb):
    resp, _ = _move(25, 99, AGENT)
    assert "owner's judgement" in resp["error"] and fdb.moved == []


def test_human_can_move_into_approved(fdb):
    resp, status = _move(25, 98, HUMAN)
    assert status == 200 and "error" not in resp
    assert fdb.moved == [(25, 98)]


# ── the recency guard: no overwriting a fresh move by a different writer ────

def test_agent_move_refused_after_a_recent_other_move(fdb):
    fdb.last_move = (98, NOW - 20)  # the owner approved 20s ago
    resp, _ = _move(25, 45, AGENT)  # agent wants to drag it to Done
    assert fdb.moved == []
    assert "moved to 'Approved' 20s ago" in resp["error"]
    assert "different writer" in resp["error"]


def test_agent_move_same_column_is_allowed(fdb):
    fdb.last_move = (45, NOW - 20)
    resp, _ = _move(25, 45, AGENT)  # landing where it already sits: no clobber
    assert "error" not in resp and fdb.moved == [(25, 45)]


def test_agent_move_allowed_outside_the_window(fdb):
    fdb.last_move = (98, NOW - 300)
    resp, _ = _move(25, 45, AGENT)
    assert "error" not in resp and fdb.moved == [(25, 45)]


def test_human_move_is_never_blocked_by_the_recency_guard(fdb):
    fdb.last_move = (42, NOW - 10)
    resp, _ = _move(25, 98, HUMAN)
    assert "error" not in resp and fdb.moved == [(25, 98)]


# ── task_done: the exact path that clobbered card 25 ─────────────────────────

def test_task_done_refused_after_a_recent_other_move(fdb):
    fdb.last_move = (98, NOW - 15)  # the owner approved 15s ago
    resp, _ = _done(25, AGENT)
    assert fdb.moved == []
    assert "moved to 'Approved' 15s ago" in resp["error"]


def test_task_done_refused_after_a_recent_decline(fdb):
    fdb.last_move = (99, NOW - 10)  # the owner JUST declined — Done must not clobber it
    resp, _ = _done(25, AGENT)
    assert fdb.moved == []
    assert "moved to 'Declined' 10s ago" in resp["error"]


def test_task_done_normal_flow_still_works(fdb):
    resp, status = _done(25, AGENT)  # no fresh write: the wake's prescribed flow
    assert status == 200 and "error" not in resp
    assert fdb.moved == [(25, 45)], "Done resolves by name on the card's own board"
