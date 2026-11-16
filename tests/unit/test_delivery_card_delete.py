"""The card repository is the non-bypassable delivery deletion boundary."""

from orchestrator.board import repository
from orchestrator import actions
from orchestrator.shared import postgres


class _Cursor:
    def __init__(self, status, exists=True):
        self.status, self.exists = status, exists
        self.rowcount = 0
        self.calls = []
        self._next = None

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if "FROM delivery_schedules" in sql:
            self._next = {"status": self.status} if self.status else None
        elif sql.startswith("DELETE FROM cards"):
            self.rowcount = 1 if self.exists else 0

    def fetchone(self):
        return self._next


class _Connection:
    def __init__(self, cursor):
        self.cursor = cursor

    def __enter__(self):
        return self.cursor

    def __exit__(self, *exc):
        return False


def _delete(monkeypatch, status, exists=True):
    cur = _Cursor(status, exists)
    monkeypatch.setattr(postgres, "cursor", lambda: _Connection(cur))
    return repository.card_delete(42), cur


def test_active_delivery_schedule_blocks_card_delete(monkeypatch):
    outcome, cur = _delete(monkeypatch, "active")
    assert outcome == {"deleted": False, "blocked": "nonterminal_delivery_schedule"}
    assert not any(sql.startswith("DELETE FROM cards") for sql, _ in cur.calls)


def test_terminal_delivery_schedule_allows_confirmed_card_delete(monkeypatch):
    for status in ("completed", "cancelled", "archived"):
        outcome, cur = _delete(monkeypatch, status)
        assert outcome == {"deleted": True, "blocked": ""}
        assert any(sql.startswith("DELETE FROM cards") for sql, _ in cur.calls)


def test_unknown_card_is_not_reported_as_a_schedule_block(monkeypatch):
    outcome, _ = _delete(monkeypatch, None, exists=False)
    assert outcome == {"deleted": False, "blocked": ""}


def test_action_explains_the_required_terminal_step(monkeypatch):
    class FakeDb:
        def card_delete(self, card_id):
            return {"deleted": False, "blocked": "nonterminal_delivery_schedule"}

    monkeypatch.setattr(actions, "db", FakeDb())
    assert actions._card_delete({"card_id": 42}) == {
        "error": "this card has active delivery work — cancel or archive its delivery "
                 "schedule before deleting the card"
    }
