"""The board's decision pipeline, tested end to end without a database.

Three layers of one contract (the one the system preamble states to every
session):

- orglogic.ensure_pipeline_columns — every board carries the default pipeline
  (Todo → Doing → Review → Approved → Declined → Blocked → Needs-info → Done);
  a column matched BY NAME takes the pipeline's canonical slot, custom columns
  are untouched.
- boardwatch.schedule_wake — an event on a card becomes AT MOST ONE one-shot
  wake for the card's own session; the wake's origin is the CAUSE (a human →
  'user', a foreign agent → 'harman').
- actions.execute's follow-up — which board events wake, which ones push the
  owner, and when the card's own session (the actor) is not woken.

db, boardwatch's loop store and push are all faked: the logic under test is
pure policy over a db it only calls, so no Postgres is needed (make unit).
"""
import time
from types import SimpleNamespace

import pytest

from viewer import actions, boardwatch, orglogic, push


def _col(name, position, cid):
    return {"id": cid, "name": name, "position": position}


FOUR_DEFAULTS = [_col("Todo", 0, 1), _col("Doing", 1, 2),
                 _col("Review", 2, 3), _col("Done", 3, 4)]


# ── orglogic.ensure_pipeline_columns: every board carries the pipeline ─────

def test_four_defaults_expand_to_the_full_pipeline():
    out = orglogic.ensure_pipeline_columns(FOUR_DEFAULTS)
    assert [c["name"] for c in out] == list(orglogic.PIPELINE_COLUMNS)
    by_name = {c["name"].lower(): c for c in out}
    # Matched columns keep their id but take the canonical position — Done
    # moves from 3 to the LAST slot so the name lookup and the position
    # fallback in project_columns agree on where task_done lands.
    assert by_name["todo"]["id"] == 1 and by_name["todo"]["position"] == 0
    assert by_name["doing"]["id"] == 2 and by_name["doing"]["position"] == 1
    assert by_name["review"]["id"] == 3 and by_name["review"]["position"] == 2
    assert by_name["done"]["id"] == 4 and by_name["done"]["position"] == 7
    # The decision columns are new, in order.
    for name, pos in (("approved", 3), ("declined", 4),
                      ("blocked", 5), ("needs-info", 6)):
        assert by_name[name]["id"] is None and by_name[name]["position"] == pos


def test_ensure_is_idempotent():
    once = orglogic.ensure_pipeline_columns(FOUR_DEFAULTS)
    again = orglogic.ensure_pipeline_columns(once)
    assert again == once, "feeding the plan back must not change it"


def test_matching_is_by_name_not_position_or_case():
    cols = [_col("todo", 9, 1), _col("DONE", 0, 4)]  # the owner shuffled them
    out = orglogic.ensure_pipeline_columns(cols)
    by_name = {c["name"].lower(): c for c in out}
    assert by_name["todo"]["id"] == 1 and by_name["todo"]["position"] == 0
    assert by_name["done"]["id"] == 4 and by_name["done"]["position"] == 7
    assert len(out) == len(orglogic.PIPELINE_COLUMNS)


def test_empty_board_gains_the_whole_pipeline():
    out = orglogic.ensure_pipeline_columns([])
    assert [c["name"] for c in out] == list(orglogic.PIPELINE_COLUMNS)
    assert all(c["id"] is None for c in out)


def test_custom_columns_pass_through_untouched():
    cols = FOUR_DEFAULTS + [_col("My stuff", 12, 9)]
    out = orglogic.ensure_pipeline_columns(cols)
    assert out[-1] == {"id": 9, "name": "My stuff", "position": 12}
    assert len(out) == len(orglogic.PIPELINE_COLUMNS) + 1


def test_duplicate_pipeline_names_match_only_the_first():
    cols = [_col("Done", 0, 1), _col("done", 3, 2)]
    out = orglogic.ensure_pipeline_columns(cols)
    done = [c for c in out if c["name"].lower() == "done"]
    assert [c["id"] for c in done] == [1], \
        "the duplicate stays out of the plan (untouched), not renamed"


# ── boardwatch: one one-shot wake per card, origin is the cause ─────────────

class FakeLoopStore:
    def __init__(self):
        self.loops = {}
        self.upserted = []
        self.updated = []

    def loop_get(self, lid):
        return self.loops.get(lid)

    def loop_upsert(self, lid, entry):
        self.loops[lid] = dict(entry, id=lid)
        self.upserted.append(lid)
        return self.loops[lid]

    def loop_update(self, lid, fields):
        row = self.loops.get(lid)
        if not row:
            return None
        row.update(fields)
        self.updated.append((lid, dict(fields)))
        return row

    def loop_delete(self, lid):
        return bool(self.loops.pop(lid, None))


@pytest.fixture
def floops(monkeypatch):
    f = FakeLoopStore()
    monkeypatch.setattr(boardwatch, "db", f)
    return f


CARD = {"id": 7, "session_id": "sess-9", "title": "Fix login"}


def test_a_card_with_no_session_gets_no_wake(floops):
    assert boardwatch.schedule_wake({"id": 7, "session_id": ""}, "moved", "user") is None
    assert floops.loops == {}


def test_a_blank_event_gets_no_wake(floops):
    assert boardwatch.schedule_wake(CARD, "   ", "user") is None
    assert floops.loops == {}


def test_first_event_creates_a_one_shot_wake(floops):
    lid = boardwatch.schedule_wake(CARD, "moved to 'Review' by user:ram", "user")
    assert lid == "bw7"
    row = floops.loops[lid]
    assert row["kind"] == "once" and row["origin"] == "user"
    assert row["session"] == "sess-9" and row["enabled"] is True
    now = time.time()
    assert now + 13 <= row["nextRun"] <= now + 17
    assert row["prompt"].startswith('[board-watch] Card 7 "Fix login"')
    assert "moved to 'Review' by user:ram" in row["prompt"]


def test_origin_is_passed_through_never_guessed(floops):
    boardwatch.schedule_wake(CARD, "updated by employee:bob", "harman")
    assert floops.loops["bw7"]["origin"] == "harman"


def test_events_on_one_card_coalesce_into_a_single_wake(floops):
    boardwatch.schedule_wake(CARD, "moved to 'Review'", "user")
    boardwatch.schedule_wake(CARD, 'new comment by user:ram: "go ahead"', "user")
    assert list(floops.loops) == ["bw7"], "never stack wakes for one card"
    assert floops.upserted == ["bw7"] and len(floops.updated) == 1
    row = floops.loops["bw7"]
    assert "new comment by user:ram" in row["prompt"]
    assert "moved to 'Review'" not in row["prompt"]
    assert row["kind"] == "once" and row["enabled"] is True


def test_cancel_wake_removes_only_that_card(floops):
    boardwatch.schedule_wake(CARD, "moved", "user")
    boardwatch.schedule_wake({"id": 8, "session_id": "s", "title": "t"},
                             "moved", "user")
    assert boardwatch.cancel_wake(7) is True
    assert boardwatch.cancel_wake(7) is False
    assert list(floops.loops) == ["bw8"]


# ── actions.execute: which board events wake the session, who is pushed ────

PIPELINE_COLS = [_col(n, i, 10 + i) for i, n in enumerate(orglogic.PIPELINE_COLUMNS)] \
    + [_col("Archive", len(orglogic.PIPELINE_COLUMNS), 90)]

BOARD_CARD = {"id": 42, "session_id": "sess-1", "project_id": 7,
              "column_id": 11, "title": "Fix login"}  # 11 = Doing


class FakeBoard:
    """The db surface the board handlers and the follow-up call."""

    def __init__(self, card=None, columns=()):
        self.card = card
        self.columns = list(columns)
        self.comments = []
        self.moves = []
        self.audit = []
        self.attention = []   # (card_id, by_own_session) — the sweep's ledger writes

    def card_get(self, card_id):
        return dict(self.card) if self.card and self.card.get("id") == card_id else None

    def card_mark_attention(self, card_id, by_own_session):
        self.attention.append((card_id, by_own_session))

    def board_columns_list(self, project_id):
        return list(self.columns)

    def card_move(self, card_id, column_id, position=1.0):
        self.moves.append((card_id, column_id, position))
        if self.card and self.card.get("id") == card_id:
            self.card = dict(self.card, column_id=column_id, position=position)
        return {"id": card_id, "column_id": column_id, "position": position}

    def card_last_move(self, card_id, seconds):
        return None  # this fake keeps no audit history — the recency guard is a no-op

    def card_comment_add(self, card_id, author, body):
        row = {"id": len(self.comments) + 1, "card_id": card_id,
               "author": author, "body": body}
        self.comments.append(row)
        return row

    def audit_append(self, actor, action, target=None, outcome=""):
        self.audit.append((actor, action, target, outcome))


@pytest.fixture
def board(monkeypatch):
    f = FakeBoard(BOARD_CARD, PIPELINE_COLS)
    monkeypatch.setattr(actions, "db", f)
    wakes, pushes = [], []

    def _wake(card, event, origin):
        wakes.append((dict(card), event, origin))
        return "bw42"

    def _push(title, body):
        pushes.append((title, body))

    monkeypatch.setattr(boardwatch, "schedule_wake", _wake)
    monkeypatch.setattr(push, "notify_all", _push)
    return SimpleNamespace(db=f, wakes=wakes, pushes=pushes)


def _it(action, args, actor="user:ram"):
    return actions.intent(action, args, actor)


def test_human_move_wakes_the_card_session_with_user_origin(board):
    resp, status = actions.execute(
        _it("card_move", {"card_id": 42, "column_id": 12}), "owner", "")
    assert status == 200 and resp["column_id"] == 12
    assert len(board.wakes) == 1
    card, event, origin = board.wakes[0]
    assert card["session_id"] == "sess-1"
    assert "moved to 'Review'" in event and "user:ram" in event
    assert origin == "user"
    assert board.pushes == [], "a human's own action does not push"


def test_agent_on_its_own_card_wakes_nothing(board):
    actions.execute(_it("card_move", {"card_id": 42, "column_id": 12},
                        "employee:bob"),
                    "owner", "ic", acting_session="sess-1")
    assert board.wakes == [] and board.pushes == []


def test_followup_keeps_the_sweep_ledger(board):
    """Regression: the 30-min sweep used to re-wake a session on its OWN status
    comment (the comment bumped updated_at, which read as "board changed"), so
    every open card's session was woken every 30 minutes forever. The ledger
    the sweep reads is written here: a foreign event marks the card as having
    news for its session; the session's own write clears it."""
    actions.execute(_it("card_comment", {"card_id": 42, "body": "go ahead"}),
                    "owner", "")
    actions.execute(_it("card_comment", {"card_id": 42, "body": "on it"},
                        "employee:bob"),
                    "owner", "ic", acting_session="sess-1")
    actions.execute(_it("card_comment", {"card_id": 42, "body": "any update?"},
                        "employee:eve"),
                    "owner", "ic", acting_session="sess-2")
    assert board.db.attention == [(42, False), (42, True), (42, False)], \
        "human → pending, own session → cleared, foreign agent → pending"


def test_foreign_agent_move_wakes_with_harman_origin(board):
    actions.execute(_it("card_move", {"card_id": 42, "column_id": 12},
                        "employee:bob"),
                    "owner", "ic", acting_session="sess-2")
    assert len(board.wakes) == 1
    _, event, origin = board.wakes[0]
    assert origin == "harman" and "employee:bob" in event
    assert board.pushes == []


def test_agent_comment_on_its_own_card_pushes_but_wakes_nothing(board):
    """A worker reporting on its own card must not wake itself (a loop), but the
    owner IS the audience for a status comment — the push fires regardless."""
    actions.execute(_it("card_comment",
                        {"card_id": 42, "body": "  Stuck on the API  ",
                         "author": "employee:bob"}, "employee:bob"),
                    "owner", "ic", acting_session="sess-1")
    assert board.wakes == []
    assert board.pushes == [("Board · Fix login", "employee:bob: Stuck on the API")]
    assert board.db.comments[0]["body"] == "Stuck on the API", "stored stripped"
    assert board.db.comments[0]["author"] == "employee:bob", "stamped, not forged"


def test_agent_comment_on_a_foreign_card_wakes_and_pushes(board):
    actions.execute(_it("card_comment", {"card_id": 42, "body": "needs your call",
                                          "author": "employee:bob"}, "employee:bob"),
                    "owner", "ic", acting_session="sess-2")
    assert len(board.wakes) == 1
    _, event, origin = board.wakes[0]
    assert origin == "harman"
    assert "new comment by employee:bob" in event
    assert board.pushes == [("Board · Fix login", "employee:bob: needs your call")]


def test_human_comment_wakes_without_push(board):
    actions.execute(_it("card_comment", {"card_id": 42, "body": "go ahead"}),
                    "owner", "")
    assert len(board.wakes) == 1 and board.wakes[0][2] == "user"
    assert board.pushes == []


def test_error_payload_gets_no_followup(monkeypatch):
    f = FakeBoard(None, PIPELINE_COLS)  # unknown card → handler errors
    monkeypatch.setattr(actions, "db", f)
    wakes = []
    monkeypatch.setattr(boardwatch, "schedule_wake",
                        lambda *a: (wakes.append(a) or "x"))
    resp, status = actions.execute(
        _it("card_comment", {"card_id": 999, "body": "hi"}), "owner", "")
    assert status == 200 and resp == {"error": "not found"}
    assert wakes == []


def test_long_comment_excerpts_in_the_wake_and_the_push(board):
    actions.execute(_it("card_comment", {"card_id": 42, "body": "x" * 250,
                                          "author": "employee:bob"}, "employee:bob"),
                    "owner", "ic", acting_session="sess-2")
    _, event, _ = board.wakes[0]
    assert "…" in event and len(event) < 260
    assert len(board.pushes[0][1]) <= 300


def test_task_done_lands_on_the_named_done_column_and_wakes(board):
    resp, status = actions.execute(_it("task_done", {"card_id": 42}), "owner", "")
    assert status == 200
    assert board.db.moves == [(42, 17, 1.0)], \
        "Done is resolved BY NAME (id 17) even though a custom column is last"
    assert len(board.wakes) == 1
    assert "marked done by user:ram" in board.wakes[0][1]
    assert board.wakes[0][2] == "user"
