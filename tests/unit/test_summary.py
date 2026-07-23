"""Unit tests for engine.compute_session_summary — the shared local+remote stats
engine behind the Stats tab. Feed synthetic transcripts, lock the aggregates
(counts, tokens, tool tally, title/summaries, timeline downsampling)."""
import json

from viewer.engine import compute_session_summary


def _summary(objs, cwd="/tmp/proj"):
    return compute_session_summary([json.dumps(o) for o in objs], cwd)


class TestComputeSessionSummary:
    def test_counts_tokens_tools_models(self):
        objs = [
            {"type": "user", "timestamp": "2026-01-01T00:00:00Z", "message": {"content": "hi"}},
            {"type": "assistant", "timestamp": "2026-01-01T00:01:00Z", "message": {
                "model": "claude", "usage": {"input_tokens": 10, "output_tokens": 20},
                "content": [{"type": "text", "text": "hey"}, {"type": "tool_use", "name": "bash"}]}},
            {"type": "assistant", "timestamp": "2026-01-01T00:02:00Z", "message": {
                "model": "claude", "usage": {"input_tokens": 5, "output_tokens": 7},
                "content": [{"type": "tool_use", "name": "bash"}]}},
        ]
        d = _summary(objs)
        assert d["lines"] == 3
        assert d["userMessages"] == 1
        assert d["assistantMessages"] == 2
        assert d["totalInput"] == 15
        assert d["totalOutput"] == 27
        assert d["tools"] == {"bash": 2}
        assert d["models"] == ["claude"]
        assert d["startTime"] == "2026-01-01T00:00:00Z"
        assert d["endTime"] == "2026-01-01T00:02:00Z"
        assert d["cwd"] == "/tmp/proj"

    def test_tool_result_only_user_not_counted(self):
        objs = [
            {"type": "user", "message": {"content": [{"type": "tool_result", "content": "x"}]}},
            {"type": "user", "message": {"content": "real question"}},
        ]
        assert _summary(objs)["userMessages"] == 1

    def test_meta_user_skipped(self):
        assert _summary([{"type": "user", "isMeta": True, "message": {"content": "m"}}])["userMessages"] == 0

    def test_title_and_deduped_summaries(self):
        objs = [
            {"type": "custom-title", "customTitle": "My Session"},
            {"type": "summary", "summary": "s1"},
            {"type": "summary", "summary": "s1"},
            {"type": "summary", "summary": "s2"},
        ]
        d = _summary(objs)
        assert d["title"] == "My Session"
        assert d["summaries"] == ["s1", "s2"]

    def test_bad_lines_counted_but_skipped(self):
        d = compute_session_summary(
            ["not json", "{bad", json.dumps({"type": "user", "message": {"content": "ok"}})], "/x")
        assert d["lines"] == 3          # every physical line counts
        assert d["userMessages"] == 1   # only the parseable user message

    def test_synthetic_model_excluded(self):
        assert _summary([{"type": "assistant", "message": {"model": "<synthetic>", "content": []}}])["models"] == []

    def test_token_timeline_downsampled_and_total_preserved(self):
        objs = [{"type": "assistant", "message": {
            "usage": {"input_tokens": 1, "output_tokens": 1}, "content": []}} for _ in range(500)]
        d = _summary(objs)
        assert 0 < len(d["tokenTimeline"]) <= 240
        assert sum(b["input"] for b in d["tokenTimeline"]) == 500
        assert sum(b["output"] for b in d["tokenTimeline"]) == 500

    def test_empty(self):
        d = _summary([])
        assert d["lines"] == 0 and d["userMessages"] == 0 and d["tokenTimeline"] == []
