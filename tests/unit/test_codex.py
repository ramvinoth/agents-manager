"""Unit tests for viewer.codex fork/restore cut-point logic. A mismatch here
truncates the LIVE rollout at the wrong place (data-loss risk), so lock the
raw-line hashing + user-text extraction."""
import json

from viewer import adapters
from viewer.codex import _codex_user_text, _split_codex


class TestCodexUserText:
    def test_string_content(self):
        assert _codex_user_text(json.dumps({"payload": {"content": "hello"}})) == "hello"

    def test_block_content_joined(self):
        raw = json.dumps({"payload": {"content": [{"text": "a"}, {"text": "b"}, {"notext": 1}]}})
        assert _codex_user_text(raw) == "a\nb"

    def test_malformed_returns_empty(self):
        assert _codex_user_text("not json") == ""
        assert _codex_user_text(json.dumps({"payload": {}})) == ""


class TestSplitCodex:
    def test_cut_found_returns_before_and_text(self):
        l1 = json.dumps({"payload": {"content": "first"}})
        l2 = json.dumps({"payload": {"content": "cut here"}})
        l3 = json.dumps({"payload": {"content": "after"}})
        cut = adapters._uuid(l2)          # the transcript uuid == md5(raw)[:20]
        before, text = _split_codex([l1, l2, l3], cut)
        assert before == [l1]
        assert text == "cut here"

    def test_cut_at_first_line(self):
        l1 = json.dumps({"payload": {"content": "cut"}})
        l2 = json.dumps({"payload": {"content": "after"}})
        before, text = _split_codex([l1, l2], adapters._uuid(l1))
        assert before == []
        assert text == "cut"

    def test_cut_not_found_returns_none(self):
        lines = [json.dumps({"payload": {"content": "x"}})]
        before, text = _split_codex(lines, "nonexistent-uuid-xyz")
        assert before is None
        assert text == ""
