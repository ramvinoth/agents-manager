"""card_deps + the autonomous sweep — the rest of the decision-pipeline contract.

test_board_pipeline covers orglogic.ensure_pipeline_columns, boardwatch's
wake coalescing/origin, and the move/comment/task_done follow-ups. This file
covers what that file does not:

- db: a card can never depend on itself; the dep's `done` flag follows the
  board's name contract (column named "done", case-insensitive).
- board_wake: the 30-min sweep wakes only cards carrying an UNANSWERED
  foreign event (someone other than the card's session acted last — a board
  where every session has answered costs nothing), never a running session,
  never a session the scheduler could not resume (no transcript), always
  harman-origin, and walks the pending cards round-robin so the per-sweep cap
  reaches every one; an open question wakes the sessions that own open cards
  — never the source.
- actions: the follow-up stamps that ledger — a foreign write marks the card,
  the card's own session writing clears it (the regression that made the
  sweep wake sessions on their own "nothing new" comments forever).
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
PENDING_CARD = dict(OPEN_CARD, column_name="Review", attention_since=1e9)


class FakeWakeDb:
    """`pending` is what cards_needing_attention would return: open cards with
    an unanswered foreign event, oldest first, each carrying column_name."""

    def __init__(self, pending=(), stamp=0.0):
        self.pending = [dict(c) for c in pending]
        self.settings = {board_wake._SETTINGS_KEY: stamp}
        self.audit = []

    @property
    def stamp(self):
        return self.settings[board_wake._SETTINGS_KEY]

    @stamp.setter
    def stamp(self, value):
        self.settings[board_wake._SETTINGS_KEY] = value

    def setting_get(self, key, default=None):
        return self.settings.get(key, default)

    def setting_set(self, key, value):
        self.settings[key] = value

    def cards_needing_attention(self):
        return [dict(c) for c in self.pending]

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


@pytest.fixture(autouse=True)
def _every_session_has_a_transcript(monkeypatch):
    """The sweep only wakes sessions the scheduler can resume — ones with a
    transcript on disk. Fake sessions have none, so pretend they all do; the
    test for the skip rule overrides this with a set of resumable ids."""
    monkeypatch.setattr(board_wake, "transcript_path", lambda sid: f"/x/{sid}.jsonl")


def _resumable(monkeypatch, *sids):
    monkeypatch.setattr(board_wake, "transcript_path",
                        lambda sid: f"/x/{sid}.jsonl" if sid in sids else None)


def test_sweep_is_noop_inside_the_interval(fdb):
    fdb.db.stamp = 1e9  # stamped 10s ago
    assert board_wake.sweep() == []
    assert fdb.wakes == [], "nothing to say → no tokens spent"


def test_sweep_nothing_pending_no_wake(fdb):
    fdb.db.stamp = 0  # long ago, but every session has answered its board
    assert board_wake.sweep() == []
    assert fdb.wakes == []
    assert fdb.db.stamp > 0, "the stamp moves even when nothing is pending"


def test_sweep_wakes_pending_card_with_harman_origin_and_deps(fdb):
    fdb.db.stamp = 0
    fdb.db.pending = [PENDING_CARD]
    fired = board_wake.sweep()
    assert fired == ["sess-9"]
    card, event, origin = fdb.wakes[0]
    assert origin == loops.AGENT_ORIGIN, "autonomous wakes are harman-origin"
    assert card["session_id"] == "sess-9"
    assert "board sweep" in event and "someone else acted on this card" in event
    assert "you are in 'Review'" in event
    assert 'card 3 "Buy the gap data" (NOT done, in Todo)' in event
    assert len(fdb.db.audit) == 1, "every sweep wake is audited"


def test_sweep_never_wakes_a_running_session(fdb):
    with CHAT_LOCK:
        CHAT_JOBS[OPEN_CARD["session_id"]] = {"running": True}
    fdb.db.stamp = 0
    fdb.db.pending = [PENDING_CARD]
    assert board_wake.sweep() == [], "a running session is already awake"
    assert fdb.wakes == []


def _six_card_board(monkeypatch):
    f = FakeWakeDb(pending=[
        {"id": i, "session_id": f"sess-{i}", "title": f"t{i}", "project_id": 16,
         "column_id": 101, "column_name": "Doing", "attention_since": 1e9 + i}
        for i in range(6)])
    monkeypatch.setattr(board_wake, "db", f)
    monkeypatch.setattr(boardwatch, "schedule_wake",
                        lambda card, event, origin: "bw")
    return f


def test_sweep_caps_the_number_of_wakes(monkeypatch):
    _six_card_board(monkeypatch)
    assert len(board_wake.sweep()) <= 3


def test_sweep_round_robins_so_the_cap_reaches_every_card(monkeypatch):
    """Regression: the sweep always started from the top of the board, so with
    a cap of 3 the same three lowest cards were woken every 30 minutes (cards
    12/14/19 got 11 wakes each over two days on the live board) while every
    other open card was never swept. The cursor (settings store, survives a
    restart) makes successive sweeps walk every pending card — a woken
    session that does not answer stays pending, so oldest-first alone would
    re-wake the same three."""
    f = _six_card_board(monkeypatch)
    assert board_wake.sweep() == ["sess-0", "sess-1", "sess-2"]
    assert f.settings[board_wake._CURSOR_KEY] == 2
    f.stamp = 0
    assert board_wake.sweep() == ["sess-3", "sess-4", "sess-5"]
    f.stamp = 0
    assert board_wake.sweep() == ["sess-0", "sess-1", "sess-2"], "wraps around"


def test_sweep_cursor_pointing_at_a_deleted_card_starts_from_the_top(monkeypatch):
    f = _six_card_board(monkeypatch)
    f.settings[board_wake._CURSOR_KEY] = 999
    assert board_wake.sweep() == ["sess-0", "sess-1", "sess-2"]


def test_sweep_skips_sessions_the_scheduler_cannot_resume(monkeypatch):
    """Regression: a card whose session has no transcript (a test fixture's
    session, a session whose file was pruned) was woken every sweep; the
    scheduler then failed each wake as "did not start" — and each such card
    burned one of the three capped slots, starving real cards. Those cards
    are skipped and the slot goes to the next resumable one."""
    f = _six_card_board(monkeypatch)
    _resumable(monkeypatch, "sess-1", "sess-3", "sess-4", "sess-5")
    assert board_wake.sweep() == ["sess-1", "sess-3", "sess-4"]
    assert [a[2]["card"] for a in f.audit] == [1, 3, 4], "no audit row for a wake that was never queued"


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

    def card_mark_attention(self, card_id, by_own_session):
        pass  # the sweep ledger — covered in test_board_pipeline

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
    # The move wakes the card's session; actions swallows wake failures, so
    # without this fake the real boardwatch.db.loop_upsert would run.
    wakes = []
    monkeypatch.setattr(boardwatch, "schedule_wake",
                        lambda card, event, origin: wakes.append((card["id"], event, origin)))
    resp, status = actions.execute(
        actions.intent("card_move", {"card_id": 42, "column_id": 45},
                       "user:ram"), "owner", "")
    assert status == 200 and resp["column_id"] == 45
    assert wakes and wakes[0][0] == 42 and wakes[0][2] == loops.USER_ORIGIN


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
