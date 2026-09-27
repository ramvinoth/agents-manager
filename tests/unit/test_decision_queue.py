"""The cross-session decision queue (card #60) — the pure shaping and the
route that gathers the three EXISTING sources.

Architecture under test (card #60's gate): there is NO parallel store. The
queue is a read across the durable pending_questions / pending_plans tables
and the in-memory live approval registry — the same rows the thread screens
already render. So:

- decisions.open_decisions is pure (rows in, queue out): it takes whatever the
  route gathered and the current time; no db, no clock. It is tested here
  without a database, including malformed rows from a corrupt/legacy write —
  a bad row must cost a summary, not a 500.
- The route is tested with fakes standing in for those sources; it must pass
  the sessions' labels through (the queue names sessions, #59's label chain)
  and keep oldest-first order.
- Deciding an item is NOT this route's job: it only lists. The decision goes
  through the existing per-session routes (race-safe via the decisions gate),
  so the board never becomes a second approval system.
"""
import time

import pytest

from viewer import decisions
from viewer.routes.chat import ChatMixin

NOW = 1_000_000.0


def _q(sid, created, questions=None, host="local", tool="t1", run="run1", rev=1):
    return {"session_id": sid, "tool_use_id": tool,
            "questions": questions if questions is not None else [
                {"header": "Drink", "question": "Tea or Coffee?",
                 "options": [{"label": "Tea"}, {"label": "Coffee"}]}],
            "host": host, "run_id": run, "revision": rev, "created_at": created}


def _p(sid, created, plan="Do the migration in three steps", host="local"):
    return {"session_id": sid, "tool_use_id": "tp", "plan": plan,
            "host": host, "created_at": created}


def _a(sid, created, tool="Bash", preview="Approve Bash? — ls", host="local"):
    return {"session": sid, "host": host, "id": "pid1", "tool_name": tool,
            "preview": preview, "created": created}


class TestOpenDecisions:
    def test_empty_sources(self):
        assert decisions.open_decisions([], [], [], {}, NOW) == {
            "count": 0, "decisions": []}

    def test_none_sources_are_treated_as_empty(self):
        assert decisions.open_decisions(None, None, None, None, NOW)["count"] == 0

    def test_mix_sorted_oldest_first(self):
        items = decisions.open_decisions(
            [_q("s1", NOW - 100)], [_p("s2", NOW - 300)], [_a("s3", NOW - 50)], {}, NOW)
        assert items["count"] == 3
        assert [d["session"] for d in items["decisions"]] == ["s2", "s1", "s3"]
        assert [d["waiting_s"] for d in items["decisions"]] == [300, 100, 50]

    def test_question_shape_and_summary(self):
        (d,) = decisions.open_decisions(
            [_q("s1", NOW - 10, questions=[{"header": "H", "question": "Q" * 200}])],
            [], [], {"s1": "My session"}, NOW)["decisions"]
        assert d == {"kind": "question", "session": "s1", "host": "local",
                     "label": "My session", "waiting_s": 10, "summary": "Q" * 120,
                     "question_count": 1, "tool_use_id": "t1", "run_id": "run1",
                     "revision": 1}

    def test_malformed_question_rows_do_not_crash(self):
        items = decisions.open_decisions(
            [{"session_id": "a", "questions": None, "created_at": NOW - 10},
             {"session_id": "b", "questions": "junk", "created_at": NOW - 10},
             {"session_id": "c", "questions": [{"label": "x"}], "created_at": NOW - 10}],
            [], [], {}, NOW)
        assert items["count"] == 3
        assert all(d["summary"] == "" for d in items["decisions"])
        assert [d["question_count"] for d in items["decisions"]] == [0, 0, 1]
        # Identity survives even a malformed row — a late answer must still
        # be able to consume the exact durable row.
        assert items["decisions"][0]["session"] == "a"

    def test_plan_and_approval_shapes(self):
        items = decisions.open_decisions(
            [], [_p("s2", NOW - 30)],
            [_a("s3", NOW - 5, preview="Approve Bash? — git status")],
            {"s2": "Plan session"}, NOW)
        (plan, appr) = items["decisions"]
        assert plan == {"kind": "plan", "session": "s2", "host": "local",
                        "label": "Plan session", "waiting_s": 30,
                        "summary": "Do the migration in three steps",
                        "tool_use_id": "tp"}
        assert appr == {"kind": "approval", "session": "s3", "host": "local",
                        "label": "", "waiting_s": 5,
                        "summary": "Approve Bash? — git status",
                        "tool_name": "Bash", "id": "pid1"}

    def test_card_waits_from_its_last_write(self):
        (d,) = decisions.open_decisions([], [], [], {}, NOW, card_rows=[
            {"id": 7, "title": "T", "session_id": "", "column_name": "Needs-info",
             "waiting_since": NOW - 60}])["decisions"]
        assert d["waiting_s"] == 60 and d["label"] == "" and d["column"] == "Needs-info"

    def test_future_created_at_clamps_to_zero(self):
        (d,) = decisions.open_decisions([_q("s1", NOW + 500)], [], [], {}, NOW)["decisions"]
        assert d["waiting_s"] == 0

    def test_missing_created_at_counts_as_not_waiting(self):
        (d,) = decisions.open_decisions(
            [{"session_id": "s1", "questions": []}], [], [], {}, NOW)["decisions"]
        assert d["waiting_s"] == 0

    def test_summary_is_capped(self):
        (d,) = decisions.open_decisions(
            [], [_p("s1", NOW, plan="x" * 500)], [], {}, NOW)["decisions"]
        assert d["summary"] == "x" * 120

    def test_unknown_session_gets_no_label_not_a_crash(self):
        (d,) = decisions.open_decisions([], [_p("ghost", NOW)], [], {}, NOW)["decisions"]
        assert d["label"] == ""


class _Handler(ChatMixin):
    def __init__(self):
        self.sent = None

    def send_json(self, data, status=200):
        self.sent = (data, status)


class TestRoute:
    """The route gathers the three sources and passes labels through; the
    pure function does the shaping (covered above)."""

    def _fakes(self, monkeypatch, qrows, prows, arows, labeler=None, crows=(),
               inbox_rows=()):
        import viewer.db as vdb
        import viewer.questions as q
        import viewer.routes.inbox as vinbox
        monkeypatch.setattr(vdb, "cards_awaiting_owner", lambda: list(crows))
        monkeypatch.setattr(vdb, "inbox_decision_refs", lambda: list(inbox_rows))
        monkeypatch.setattr(q, "get_open_all", lambda: qrows)
        monkeypatch.setattr(q, "get_open_plan_all", lambda: prows)
        # The route (chat._g_decisions_open) delegates the gather to the inbox
        # module's open_decisions_items — patch the source names where THAT
        # module holds its references.
        monkeypatch.setattr(vinbox, "pending_approvals_all_public", lambda: arows)
        monkeypatch.setattr(vinbox, "_push_label",
                            labeler or (lambda sid, cwd="": ""))

    def test_lists_all_three_sources(self, monkeypatch):
        labels = {"sq": "Question chat", "sp": "Plan chat"}
        self._fakes(monkeypatch, [_q("sq", NOW - 100)], [_p("sp", NOW - 50)],
                    [_a("sa", NOW - 10)],
                    labeler=lambda sid, cwd="": labels.get(sid, ""))
        h = _Handler()
        h._g_decisions_open(None)
        payload, status = h.sent
        assert status == 200
        assert payload["count"] == 3
        assert [d["kind"] for d in payload["decisions"]] == [
            "question", "plan", "approval"]
        assert payload["decisions"][0]["label"] == "Question chat"
        assert payload["decisions"][1]["label"] == "Plan chat"
        assert payload["decisions"][2]["label"] == ""

    def test_a_card_parked_for_the_owner_is_a_decision(self, monkeypatch):
        """A card in Review/Needs-info is the fourth source: it lists with the
        card number AND title (readable cold), the column, and a `card` id a
        tap can open — and its session label resolves like the others."""
        self._fakes(monkeypatch, [], [], [],
                    labeler=lambda sid, cwd="": {"sc": "Worker"}.get(sid, ""),
                    crows=[{"id": 53, "title": "Phone calls", "session_id": "sc",
                            "project_id": 15, "updated_at": NOW - 900,
                            "column_name": "Review", "waiting_since": NOW - 60}])
        h = _Handler()
        h._g_decisions_open(None)
        (d,) = h.sent[0]["decisions"]
        d.pop("waiting_s")  # the route uses the real clock
        assert d == {"kind": "card", "session": "sc", "host": "local",
                     "label": "Worker", "summary": "#53 Phone calls",
                     "card": 53, "column": "Review",
                     "inbox_id": 0, "snoozed_until": 0}

    def test_a_snoozed_item_is_held_back_until_it_lapses(self, monkeypatch):
        """One snooze, every surface: the owner snoozed the plan in the Inbox
        (its inbox row is 'snoozed' with a future deadline), so the board
        queue must not show it either — while the lapsed snooze on the
        question is over and the question is back, carrying its inbox id so
        the cockpit can snooze it again."""
        far = time.time() + 3600
        self._fakes(monkeypatch, [_q("sq", NOW - 100, tool="tq")],
                    [_p("sp", NOW - 50)], [],
                    inbox_rows=[{"kind": "plan", "ref_id": "tp", "id": 7,
                                 "status": "snoozed", "snoozed_until": far},
                                {"kind": "question", "ref_id": "tq", "id": 8,
                                 "status": "snoozed", "snoozed_until": 5.0}])
        h = _Handler()
        h._g_decisions_open(None)
        payload, status = h.sent
        assert status == 200
        assert payload["count"] == 1
        (d,) = payload["decisions"]
        assert d["kind"] == "question" and d["inbox_id"] == 8 and d["snoozed_until"] == 0

    def test_empty_system_is_an_empty_queue(self, monkeypatch):
        self._fakes(monkeypatch, [], [], [])
        h = _Handler()
        h._g_decisions_open(None)
        assert h.sent == ({"count": 0, "decisions": []}, 200)

    def test_a_failing_label_lookup_degrades_to_empty_not_a_500(self, monkeypatch):
        def boom(sid, cwd=""):
            raise RuntimeError("db hiccup")
        self._fakes(monkeypatch, [_q("sq", NOW - 100)], [], [], labeler=boom)
        h = _Handler()
        h._g_decisions_open(None)
        assert h.sent[1] == 200
        assert h.sent[0]["count"] == 1
        assert h.sent[0]["decisions"][0]["label"] == ""
