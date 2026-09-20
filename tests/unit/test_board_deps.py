"""card_deps + the autonomous sweep — the rest of the decision-pipeline contract.

test_board_pipeline covers orglogic.ensure_pipeline_columns, boardwatch's
wake coalescing/origin, and the move/comment/task_done follow-ups. This file
covers what that file does not:

- db: a card can never depend on itself; the dep's `done` flag follows the
  board's name contract (column named "done", case-insensitive).
- board_wake: the 30-min sweep wakes only when the board actually changed
  (a clean board costs nothing), never a running session, always harman-origin;
  an open question wakes the sessions that own open cards — never the source.
- actions: adding/removing a dependency wakes the card with the WHY text.

Everything faked: the logic under test is pure policy over db/boardwatch,
so no Postgres and no scheduler are needed.
"""
from types import SimpleNamespace

import pytest

from viewer import actions, board_wake, boardwatch, db, loops
from viewer.config import CHAT_JOBS, CHAT_LOCK


# ── db: dependency edges ──────────────────────────────────────────────────

def test_a_card_cannot_depend_on_itself():
    # Pure guard, runs before any SQL — calling it needs no db at all.
    assert db.card_dep_add(5, 5) == {"error": "a card cannot depend on itself"}


def test_deps_batch_done_follows_the_name_contract(monkeypatch):
    rows = [
        {"card_id": 1, "id": 2, "title": "B", "column_name": "Done"},
        {"card_id": 1, "id": 3, "title": "C", "column_name": "TODO"},
        {"card_id": 1, "id": 4, "title": "D", "column_name": None},
    ]

    class Cur:
        def execute(self, sql, params=()):
            self._rows = rows

        def fetchall(self):
            return self._rows

    class Conn:
        def __enter__(self):
            return Cur()

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(db, "_db", lambda: Conn())
    out = db.card_deps_batch([1])
    by_id = {d["id"]: d for d in out[1]}
    assert by_id[2]["done"] is True, "'Done' matches by name, case-insensitive"
    assert by_id[3]["done"] is False and by_id[4]["done"] is False


# ── boardwatch: the coalesce path must track the LATEST cause ─────────────

def test_coalesced_wake_updates_origin_to_the_latest_cause(monkeypatch):
    """Regression: the update path used to drop `origin`, so a human comment
    merged into an agent-caused pending wake kept origin='harman' and never
    fired in 'user' mode (and vice versa). The mode filter acts on the latest
    cause, so the patch must carry it."""

    class One:
        def __init__(self):
            self.row = {"id": "bw7", "prompt": "old", "origin": loops.AGENT_ORIGIN,
                        "kind": "once", "enabled": True, "nextRun": 0}

        def loop_get(self, lid):
            return self.row

        def loop_update(self, lid, fields):
            self.row.update(fields)
            return self.row

    s = One()
    monkeypatch.setattr(boardwatch, "db", s)
    boardwatch.schedule_wake(
        {"id": 7, "session_id": "sess-9", "title": "Fix login"},
        "new comment by user:ram: 'go ahead'", loops.USER_ORIGIN)
    assert s.row["origin"] == loops.USER_ORIGIN, \
        "a human's event coalesced over an agent's wake must fire in 'user' mode"


# ── board_wake: the 30-minute sweep ────────────────────────────────────────

OPEN_CARD = {"id": 7, "session_id": "sess-9", "title": "Fix login",
             "project_id": 16, "column_id": 101}


class FakeWakeDb:
    def __init__(self, changed=False, stamp=0.0):
        self.changed = changed
        self.stamp = stamp
        self.audit = []

    def setting_get(self, key, default=None):
        return self.stamp

    def setting_set(self, key, value):
        self.stamp = value

    def board_changed_since(self, since):
        return (self.changed, "2 card(s) changed") if self.changed else (False, "")

    def card_list(self):
        return [dict(OPEN_CARD)]

    def board_columns_list(self, project_id):
        return [{"id": 101, "name": "Review", "position": 2}]

    def card_deps_batch(self, ids):
        return {7: [{"id": 3, "title": "Buy the gap data", "column_name": "Todo",
                    "done": False}]} if 7 in ids else {}

    def audit_append(self, *a):
        self.audit.append(a)


@pytest.fixture
def fdb(monkeypatch):
    f = FakeWakeDb()
    monkeypatch.setattr(board_wake, "db", f)
    wakes = []
    monkeypatch.setattr(boardwatch, "schedule_wake",
                        lambda card, event, origin: (wakes.append((card, event, origin)) or "bw7"))
    return SimpleNamespace(db=f, wakes=wakes)


@pytest.fixture(autouse=True)
def _no_running_sessions():
    with CHAT_LOCK:
        CHAT_JOBS.clear()
    yield
    with CHAT_LOCK:
        CHAT_JOBS.clear()


def test_sweep_is_noop_inside_the_interval(fdb):
    fdb.db.stamp = 1e9  # stamped 10s ago
    assert board_wake.sweep() == []
    assert fdb.wakes == [], "nothing to say → no tokens spent"


def test_sweep_no_change_no_wake(fdb):
    fdb.db.stamp = 0  # long ago, but...
    fdb.db.changed = False
    assert board_wake.sweep() == []
    assert fdb.wakes == []
    assert fdb.db.stamp > 0, "the stamp moves even when nothing changed"


def test_sweep_wakes_open_card_with_harman_origin_and_deps(fdb):
    fdb.db.stamp = 0
    fdb.db.changed = True
    fired = board_wake.sweep()
    assert fired == ["sess-9"]
    card, event, origin = fdb.wakes[0]
    assert origin == loops.AGENT_ORIGIN, "autonomous wakes are harman-origin"
    assert card["session_id"] == "sess-9"
    assert "board sweep" in event and "2 card(s) changed" in event
    assert 'card 3 "Buy the gap data" (NOT done, in Todo)' in event
    assert len(fdb.db.audit) == 1, "every sweep wake is audited"


def test_sweep_never_wakes_a_running_session(fdb):
    with CHAT_LOCK:
        CHAT_JOBS[OPEN_CARD["session_id"]] = {"running": True}
    fdb.db.stamp = 0
    fdb.db.changed = True
    assert board_wake.sweep() == [], "a running session is already awake"
    assert fdb.wakes == []


def test_sweep_caps_the_number_of_wakes(monkeypatch):
    f = FakeWakeDb(changed=True)
    f.card_list = lambda: [
        {"id": i, "session_id": f"sess-{i}", "title": f"t{i}",
         "project_id": 16, "column_id": 101} for i in range(6)]
    monkeypatch.setattr(board_wake, "db", f)
    monkeypatch.setattr(boardwatch, "schedule_wake",
                        lambda card, event, origin: "bw")
    assert len(board_wake.sweep()) <= 3


# ── board_wake: other sessions' open questions ────────────────────────────

def test_open_question_wakes_open_card_sessions_never_the_source(monkeypatch):
    f = FakeWakeDb()
    f.card_list = lambda: [
        {"id": 1, "session_id": "sess-A", "title": "a", "project_id": 16, "column_id": 101},
        {"id": 2, "session_id": "sess-B", "title": "b", "project_id": 16, "column_id": 101},
    ]
    f.card_deps_batch = lambda ids: {}
    monkeypatch.setattr(board_wake, "db", f)
    wakes = []
    monkeypatch.setattr(boardwatch, "schedule_wake",
                        lambda card, event, origin: (wakes.append((card, event)) or "bw"))
    fired = board_wake.wake_on_open_question("sess-B", "which provider?")
    assert fired == ["sess-A"], "the source is the one waiting, not the one to answer"
    assert "sess-B" in wakes[0][1] and "which provider?" in wakes[0][1]


# ── actions: the dep handlers wake with the WHY text ──────────────────────

DEP_CARD = {"id": 42, "session_id": "sess-1", "project_id": 16,
            "column_id": 11, "title": "Fix login"}
DEP_REF = {"id": 43, "session_id": "sess-2", "project_id": 16,
           "column_id": 12, "title": "Buy the gap data"}


class FakeDepBoard:
    def __init__(self):
        self.cards = {42: dict(DEP_CARD), 43: dict(DEP_REF)}
        self.audit = []

    def card_get(self, card_id):
        c = self.cards.get(card_id)
        return dict(c) if c else None

    def card_dep_add(self, card_id, depends_on, created_by=""):
        return {"id": 1, "card_id": card_id, "depends_on": depends_on}

    def card_dep_remove(self, card_id, depends_on):
        return True

    def audit_append(self, *a):
        self.audit.append(a)


@pytest.fixture
def depboard(monkeypatch):
    f = FakeDepBoard()
    monkeypatch.setattr(actions, "db", f)
    wakes = []
    monkeypatch.setattr(boardwatch, "schedule_wake",
                        lambda card, event, origin: (wakes.append((card, event, origin)) or "bw42"))
    return SimpleNamespace(db=f, wakes=wakes)


def test_dep_add_wake_says_blocked(
        depboard):
    resp, status = actions.execute(
        actions.intent("card_dep_add",
                       {"card_id": 42, "depends_on": 43,
                        "created_by": "user:ram"}, "user:ram"),
        "owner", "")
    assert status == 200 and resp["card_id"] == 42
    _, event, origin = depboard.wakes[0]
    assert origin == loops.USER_ORIGIN
    assert 'card 43 "Buy the gap data"' in event
    assert "blocked until it reaches Done" in event


def test_dep_remove_wake_says_may_proceed(depboard):
    actions.execute(
        actions.intent("card_dep_remove",
                       {"card_id": 42, "depends_on": 43}, "user:ram"),
        "owner", "")
    _, event, _ = depboard.wakes[0]
    assert "removed by user:ram" in event and "may be able to proceed" in event


def test_move_to_a_column_on_another_board_is_refused(
        monkeypatch):
    """Regression: a drag from one project's board onto another project's
    column used to write the row anyway — the card then vanished from its own
    board. (Card 25 was parked in foreign column 43 on 2026-09-19 this way.)"""
    f = FakeDepBoard()
    f.board_columns_list = lambda pid: [
        {"id": 42, "name": "Todo", "position": 0},
        {"id": 45, "name": "Done", "position": 1}]  # this card's board (p16)

    def _move(card_id, column_id, position=1.0):
        return {"moved": True, "column_id": column_id}

    f.card_move = _move
    monkeypatch.setattr(actions, "db", f)
    resp, status = actions.execute(
        actions.intent("card_move", {"card_id": 42, "column_id": 43},
                       "user:ram"), "owner", "")
    assert resp == {"error": "column 43 is not on this card's board"}
    assert status == 200, "a refused drag is a 200-with-error, like every other board handler"


def test_move_within_its_own_board_still_works(monkeypatch):
    f = FakeDepBoard()
    f.board_columns_list = lambda pid: [
        {"id": 42, "name": "Todo", "position": 0},
        {"id": 45, "name": "Done", "position": 1}]
    f.card_move = lambda card_id, column_id, position=1.0: \
        {"id": card_id, "column_id": column_id}
    monkeypatch.setattr(actions, "db", f)
    resp, status = actions.execute(
        actions.intent("card_move", {"card_id": 42, "column_id": 45},
                       "user:ram"), "owner", "")
    assert status == 200 and resp["column_id"] == 45


def test_dep_add_on_a_unknown_card_errors_without_waking(
        monkeypatch):
    f = FakeDepBoard()
    f.cards.pop(42)
    monkeypatch.setattr(actions, "db", f)
    wakes = []
    monkeypatch.setattr(boardwatch, "schedule_wake",
                        lambda *a: (wakes.append(a) or "bw"))
    resp, status = actions.execute(
        actions.intent("card_dep_add", {"card_id": 42, "depends_on": 43},
                       "user:ram"), "owner", "")
    assert status == 200 and resp == {"error": "not found"}
    assert wakes == []
