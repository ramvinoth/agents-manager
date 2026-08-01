"""Unit tests for viewer.questions — the async AskUserQuestion detector and the
resume-message composer. detect_pending is the load-bearing pure function: a false
positive re-parks an answered question; a false negative drops a real one."""
from viewer.questions import answer_message, detect_pending


def _auq(tid, questions):
    return {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": tid, "name": "AskUserQuestion", "input": {"questions": questions}}]}}


def _result(tid, content, is_error=True):
    return {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": tid, "is_error": is_error, "content": content}]}}


def _human(text):
    return {"type": "user", "message": {"content": [{"type": "text", "text": text}]}}


Q = [{"header": "Drink", "question": "Tea or Coffee?", "options": [{"label": "Tea"}, {"label": "Coffee"}]}]


class TestDetectPending:
    def test_unanswered_question_is_pending(self):
        r = detect_pending([_auq("t1", Q), _result("t1", "Answer questions?")])
        assert r and r["tool_use_id"] == "t1" and len(r["questions"]) == 1

    def test_timeout_variant_is_pending(self):
        r = detect_pending([_auq("t1", Q), _result("t1", "No response (timed out)")])
        assert r is not None

    def test_answered_with_real_value_is_not_pending(self):
        # a non-error result carrying an actual answer must not be re-parked
        assert detect_pending([_auq("t2", Q), _result("t2", "The user answered: Tea", is_error=False)]) is None

    def test_human_message_after_result_clears_it(self):
        # user already answered (e.g. via a resumed run) -> no longer pending
        recs = [_auq("t1", Q), _result("t1", "Answer questions?"),
                _human("Drink: Tea"),
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "You chose Tea"}]}}]
        assert detect_pending(recs) is None

    def test_toolresult_after_does_not_clear_it(self):
        recs = [_auq("t1", Q), _result("t1", "Answer questions?"),
                {"type": "user", "message": {"content": [
                    {"type": "tool_result", "tool_use_id": "other", "content": "x"}]}}]
        assert detect_pending(recs) is not None

    def test_no_askuserquestion_returns_none(self):
        assert detect_pending([{"type": "assistant", "message": {"content": [
            {"type": "text", "text": "hi"}]}}]) is None

    def test_last_of_several_questions_wins(self):
        recs = [_auq("t1", Q), _result("t1", "Answer questions?"), _human("Tea"),
                _auq("t2", [{"header": "Deploy", "options": [{"label": "Prod"}]}]),
                _result("t2", "Answer questions?")]
        r = detect_pending(recs)
        assert r and r["tool_use_id"] == "t2"

    def test_json_string_input_is_parsed(self):
        rec = {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "t4", "name": "AskUserQuestion",
             "input": '{"questions":[{"header":"X","options":[{"label":"A"}]}]}'}]}}
        r = detect_pending([rec, _result("t4", "Answer questions?")])
        assert r and len(r["questions"]) == 1

    def test_missing_result_is_not_pending(self):
        # tool_use with no result yet (still streaming) -> not a finished pause
        assert detect_pending([_auq("t1", Q)]) is None


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


class TestReadTranscriptHostRouting:
    """read_transcript must route to the remote reader for non-local hosts, so a
    remote (SSH) session's question is detected — the bug where remote sessions
    were silently skipped."""

    def test_remote_host_uses_remote_reader(self, monkeypatch):
        import viewer.remote as remote
        calls = {}

        def fake_resolve(hid, sid):
            calls["resolve"] = (hid, sid)
            return {"found": True, "path": "projects/x/%s.jsonl" % sid}

        def fake_read(hid, rel, q):
            calls["read"] = (hid, rel, q)
            return {"lines": ['{"type":"user","message":{"content":"hi"}}']}

        monkeypatch.setattr(remote, "remote_resolve", fake_resolve)
        monkeypatch.setattr(remote, "remote_read_session", fake_read)
        from viewer.questions import read_transcript
        recs = read_transcript("sid123", host="tim-hetzner")
        assert calls["resolve"][0] == "tim-hetzner"
        assert calls["read"][0] == "tim-hetzner" and calls["read"][2] == {"tail": ["400"]}
        assert len(recs) == 1 and recs[0]["type"] == "user"

    def test_remote_failure_returns_empty_not_raise(self, monkeypatch):
        import viewer.remote as remote

        def boom(*a, **k):
            raise OSError("ssh down")

        monkeypatch.setattr(remote, "remote_resolve", boom)
        from viewer.questions import read_transcript
        assert read_transcript("sid", host="somehost") == []
