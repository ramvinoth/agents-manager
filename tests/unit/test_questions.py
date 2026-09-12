"""Unit tests for viewer.questions — the AskUserQuestion input parser, the
resume-message composer, and the interruption count.

`questions_from_input` runs inside a permission callback that a LIVE turn is
blocked on, so its contract is "never raise, return [] instead": a malformed
input must cost the user a card, not hang the turn.
"""
import pytest

from viewer import questions
from viewer.questions import answer_message, questions_from_input


Q = [{"header": "Drink", "question": "Tea or Coffee?", "options": [{"label": "Tea"}, {"label": "Coffee"}]}]


class TestQuestionsFromInput:
    def test_object_input(self):
        assert questions_from_input({"questions": Q}) == Q

    def test_json_string_input_is_parsed(self):
        assert len(questions_from_input('{"questions":[{"header":"X","options":[{"label":"A"}]}]}')) == 1

    def test_malformed_json_returns_empty_not_raise(self):
        assert questions_from_input("{not json") == []

    def test_missing_or_wrong_shaped_questions_key(self):
        assert questions_from_input({}) == []
        assert questions_from_input({"questions": "Tea?"}) == []
        assert questions_from_input(None) == []


class TestAnswerMessage:
    def test_single_pick(self):
        assert answer_message([{"header": "Drink"}], ["Coffee"]) == "My answer to your question — Drink: Coffee"

    def test_multi_question(self):
        msg = answer_message([{"header": "Drink"}, {"header": "Size"}], ["Tea", "Large"])
        assert "Drink: Tea" in msg and "Size: Large" in msg

    def test_falls_back_to_question_text_without_header(self):
        assert "Tea or Coffee?: Tea" in answer_message([{"question": "Tea or Coffee?"}], ["Tea"])

    def test_empty_picks(self):
        assert answer_message([{"header": "Drink"}], []) == "My answer to your question — (no selection)"

    def test_fewer_picks_than_questions_skips_the_unanswered(self):
        assert answer_message([{"header": "Drink"}, {"header": "Size"}], ["Tea"]) == \
            "My answer to your question — Drink: Tea"


class TestRecordCountsTheInterruption:
    """`record` is the ONE place a question becomes durable, so it is where the
    interruption is counted. Without that count §12.3's "interruptions fall as
    autonomy is earned" is an assertion nobody can check."""

    class FakeDB:
        def __init__(self, boom=False):
            self.rows, self.audit, self.boom = [], [], boom

        def pending_question_set(self, session_id, tool_use_id, qs, host="local"):
            self.rows.append((session_id, tool_use_id, qs, host))

        def audit_append(self, actor, action, target=None, outcome=""):
            if self.boom:
                raise RuntimeError("audit table gone")
            self.audit.append((actor, action, target, outcome))

    @pytest.fixture
    def fdb(self, monkeypatch):
        f = self.FakeDB()
        monkeypatch.setattr(questions, "db", f)
        return f

    def test_recording_a_question_appends_exactly_one_ask_owner_row(self, fdb):
        questions.record("sid1", {"tool_use_id": "t1", "questions": Q}, "tim-hetzner")
        assert len(fdb.audit) == 1
        actor, action, target, outcome = fdb.audit[0]
        assert (actor, action, outcome) == ("session:sid1", "ask_owner", "asked")
        assert target == {"session": "sid1", "host": "tim-hetzner", "questions": 1}

    def test_audit_records_shape_not_question_text(self, fdb):
        """audit_log is readable by anyone who can call /api/org/audit; a question
        body can quote the work, so only the count travels."""
        secret = [{"header": "Deploy", "question": "Ship acme-prod-secret?",
                   "options": [{"label": "Yes"}]}]
        questions.record("sid2", {"tool_use_id": "t2", "questions": secret})
        assert "acme-prod-secret" not in repr(fdb.audit)

    def test_audit_failure_never_loses_the_question(self, monkeypatch):
        """Bookkeeping must not outrank the user's question: the durable row is
        written first and an audit blow-up is swallowed."""
        f = self.FakeDB(boom=True)
        monkeypatch.setattr(questions, "db", f)
        questions.record("sid3", {"tool_use_id": "t3", "questions": Q})
        assert f.rows == [("sid3", "t3", Q, "local")]
