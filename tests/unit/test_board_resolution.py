"""The ONE board-resolution rule at the routes (viewer/routes/orchestrator.py).

A card (or a board view) belongs to a project: an explicit project wins, else
the session's bound project (kanbanProject in session_meta), else none. The
board READ, card CREATE and card DETAIL must all apply the same rule — the bug
being tested here is that they once disagreed: a card created from a
session-filtered board (no project named) was born with no project, and its
detail screen (which re-derived the board from the card's project alone) had
no columns to move it into — a dead card.

No Postgres: the db module is monkeypatched (test_drives.py pattern) and the
mixins are driven through a bare fake that captures what they would send.
"""
from types import SimpleNamespace

import pytest

from viewer.routes.orchestrator import OrchestratorMixin


class _FakeSelf(OrchestratorMixin):
    """The mixin minus the actions layer: writes are captured, not executed."""

    def __init__(self, body=None):
        self._body = body or {}
        self.sent = []        # (status, payload) from send_json
        self.intents = []     # (action, args) from _org_send

    def read_body(self):
        return self._body

    def send_json(self, payload, status=200):
        self.sent.append((status, payload))

    def _org_send(self, req, action, args):
        self.intents.append((action, args))


class _FakeDB:
    def __init__(self, meta=None, columns_by_project=None):
        self.meta = meta or {}
        self.columns_by_project = columns_by_project or {}
        self.columns_calls = []
        self.card = None

    def session_meta_get(self, sid):
        return dict(self.meta.get(sid) or {})

    def board_columns_list(self, project_id):
        self.columns_calls.append(project_id)
        return self.columns_by_project.get(project_id, [])

    def card_get(self, card_id):
        return dict(self.card) if self.card else None

    def card_comment_list(self, card_id):
        return []

    def card_deps_batch(self, ids):
        return {}


@pytest.fixture()
def db(monkeypatch):
    from viewer.routes import orchestrator
    fake = _FakeDB()
    monkeypatch.setattr(orchestrator, "db", fake)
    return fake


def _req(query=None, actor="ram"):
    return SimpleNamespace(query=query or {}, principal={
        "actor": actor, "human_role": "owner", "session_level": "", "session": ""})


META = {"s1": {"kanbanProject": "15"}, "s9": {}}  # s1 has a board, s9 does not
COLS = {15: [{"id": 38, "name": "Todo"}], 20: [{"id": 50, "name": "Todo"}]}


# ── card CREATE: born on the board it was seen on ────────────────────────────

def test_create_from_session_view_gets_the_sessions_project(db):
    db.meta = META
    s = _FakeSelf({"title": "x", "session": "s1"})  # no project named (mobile)
    s._p_org_cards(_req())
    assert s.intents[0][0] == "card_create"
    assert s.intents[0][1]["project_id"] == 15


def test_create_with_explicit_project_is_untouched(db):
    db.meta = META
    s = _FakeSelf({"title": "x", "session": "s1", "project_id": 20})
    s._p_org_cards(_req())
    assert s.intents[0][1]["project_id"] == 20


def test_create_with_no_context_stays_projectless(db):
    db.meta = META
    s = _FakeSelf({"title": "x", "session": "s9"})  # session has no bound project
    s._p_org_cards(_req())
    assert s.intents[0][1].get("project_id") is None


# ── board READ: the rule the board view applies ──────────────────────────────

def test_board_resolves_session_project(db):
    db.meta = META
    db.columns_by_project = COLS
    s = _FakeSelf()
    s._g_org_board(_req({"session": ["s1"]}))
    assert s.sent == [(200, {"columns": COLS[15]})]


def test_board_explicit_project_wins(db):
    db.meta = META
    db.columns_by_project = COLS
    s = _FakeSelf()
    s._g_org_board(_req({"project": ["20"], "session": ["s1"]}))
    assert s.sent == [(200, {"columns": COLS[20]})]


def test_board_with_no_resolvable_project_is_400(db):
    db.meta = META
    s = _FakeSelf()
    s._g_org_board(_req({}))
    assert s.sent[0][0] == 400


# ── card DETAIL: move options composed by the server ────────────────────────

def _detail(db, card):
    db.card = card
    db.columns_by_project = COLS
    s = _FakeSelf()
    s._g_org_card(_req({"id": [str(card["id"])]}))
    return s.sent[0][1]


def test_detail_card_with_project_gets_its_columns(db):
    db.meta = META
    out = _detail(db, {"id": 1, "project_id": 20, "session_id": "s1"})
    assert out["columns"] == COLS[20]
    assert out["card"]["project_id"] == 20


def test_detail_orphan_card_gets_its_sessions_board(db):
    db.meta = META
    out = _detail(db, {"id": 2, "project_id": None, "session_id": "s1"})
    assert out["columns"] == COLS[15]


def test_detail_truly_orphan_gets_empty_columns(db):
    db.meta = META
    out = _detail(db, {"id": 3, "project_id": None, "session_id": "s9"})
    assert out["columns"] == []
