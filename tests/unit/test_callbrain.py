"""viewer.callbrain — the fast phone-call brain. The model is faked (a scripted
chat_completion_message), the tools run against in-memory data, so the whole
tool loop is exercised hermetically: transcript activity parsing, the spoken
run description, the board summary, and call_turn's dispatch + history."""
import json

import pytest

from viewer import callbrain


def _rec(kind, blocks):
    return json.dumps({"type": kind, "message": {"role": kind, "content": blocks}})


class TestTranscriptActivity:
    def test_latest_text_and_tool_win(self):
        lines = [
            _rec("assistant", [{"type": "text", "text": "Looking  now"}]),
            _rec("assistant", [{"type": "tool_use", "name": "Read", "input": {}}]),
            _rec("user", [{"type": "tool_result", "content": "ignored"}]),
            _rec("assistant", [{"type": "tool_use", "name": "Bash", "input": {}}]),
            "not json",
        ]
        assert callbrain.transcript_activity(lines) == {"text": "Looking now", "tool": "Bash"}

    def test_empty(self):
        assert callbrain.transcript_activity([]) == {"text": "", "tool": ""}


class TestDescribeRun:
    def test_no_job(self):
        assert "No request" in callbrain.describe_run(None, {"text": "", "tool": ""})

    def test_running_with_tool(self):
        s = callbrain.describe_run({"running": True, "started": 100}, {"text": "", "tool": "Grep"}, now=142)
        assert "42 seconds" in s and "Grep" in s

    def test_running_waiting_on_approval(self):
        s = callbrain.describe_run({"running": True, "started": 0, "pending_approvals": [{"id": 1}]},
                                   {"text": "", "tool": "Bash"}, now=5)
        assert "approval" in s

    def test_error(self):
        s = callbrain.describe_run({"running": False, "returncode": 1, "stderr": "boom"}, {"text": "", "tool": ""})
        assert s.startswith("The last request ended with an error") and "boom" in s

    def test_finished_answer_is_truncated(self):
        long = "word " * 300
        s = callbrain.describe_run({"running": False, "returncode": 0}, {"text": long, "tool": ""})
        assert s.startswith("Harman finished. word") and s.endswith("the rest is in the chat.")
        assert len(s) < callbrain.ANSWER_CHARS + 60

    def test_finished_no_text(self):
        s = callbrain.describe_run({"running": False, "returncode": 0}, {"text": "", "tool": ""})
        assert "wrote no answer" in s


class TestSummarizeBoard:
    cols = [{"id": 1, "name": "Todo", "position": 0}, {"id": 2, "name": "Doing", "position": 1},
            {"id": 3, "name": "Review", "position": 2}, {"id": 9, "name": "Done", "position": 7}]

    def test_counts_and_moving_titles(self):
        cards = [{"column_id": 1, "title": "a"}, {"column_id": 2, "title": "Fix login"},
                 {"column_id": 3, "title": "Ship build"}, {"column_id": 9, "title": "old"}]
        s = callbrain.summarize_board(self.cols, cards)
        assert s.startswith("Board: 1 in Todo, 1 in Doing, 1 in Review, 1 in Done.")
        assert "Doing: Fix login" in s and "Review: Ship build" in s and "old" not in s

    def test_more_suffix(self):
        cards = [{"column_id": 2, "title": f"t{i}"} for i in range(6)]
        assert "and 2 more" in callbrain.summarize_board(self.cols, cards, per_column=4)

    def test_empty(self):
        assert callbrain.summarize_board(self.cols, []) == "The board is empty."


def _tool_call(name, args, cid="c1"):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def test_parse_tool_calls_tolerates_bad_json():
    msg = {"tool_calls": [{"id": "x", "function": {"name": "ask_harman", "arguments": "{oops"}}]}
    assert callbrain.parse_tool_calls(msg) == [("ask_harman", {}, "x")]


class TestCallTurn:
    preset = {"baseUrl": "http://brain", "apiKey": "k", "model": "qwen"}

    def _script(self, monkeypatch, replies):
        seen = []

        def fake(base_url, api_key, payload, timeout=None):
            seen.append(json.loads(json.dumps(payload)))  # snapshot: call_turn mutates messages
            return replies.pop(0)
        monkeypatch.setattr(callbrain, "chat_completion_message", fake)
        return seen

    def test_no_brain_configured(self, monkeypatch):
        monkeypatch.setattr(callbrain, "brain_preset", lambda: None)
        with pytest.raises(RuntimeError):
            callbrain.call_turn("s", "/w", "acceptEdits", "hi", [])

    def test_chit_chat_no_tools(self, monkeypatch):
        seen = self._script(monkeypatch, [{"content": "Doing well, thanks."}])
        out = callbrain.call_turn("s", "/w", "acceptEdits", "how are you", [], preset=self.preset)
        assert out == {"reply": "Doing well, thanks.", "tools": [],
                       "history": [{"role": "user", "content": "how are you"},
                                   {"role": "assistant", "content": "Doing well, thanks."}]}
        payload = seen[0]
        assert payload["tools"] == callbrain.TOOLS
        assert payload["chat_template_kwargs"] == {"enable_thinking": False}
        assert payload["messages"][0]["role"] == "system"

    def test_tool_round_trip_and_history(self, monkeypatch):
        seen = self._script(monkeypatch, [
            {"content": None, "tool_calls": [_tool_call("ask_harman", {"question": "check my email"})]},
            {"content": "Started; I will let you know."},
        ])
        ran = []

        def runner(name, args, sid, cwd, mode):
            ran.append((name, args, sid, cwd, mode))
            return "Started. The work is running in the background."
        history = [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi"},
                   {"role": "system", "content": "injected — must be dropped"}]
        out = callbrain.call_turn("s1", "/w", "plan", "check my email", history,
                                  preset=self.preset, tool_runner=runner)
        assert ran == [("ask_harman", {"question": "check my email"}, "s1", "/w", "plan")]
        assert out["reply"] == "Started; I will let you know." and out["tools"] == ["ask_harman"]
        # Second model call carried the assistant tool_call + tool result, no injected system.
        roles = [m["role"] for m in seen[1]["messages"]]
        assert roles == ["system", "user", "assistant", "user", "assistant", "tool"]
        assert seen[1]["messages"][0]["content"] == callbrain.SYSTEM_PROMPT
        # Stored history keeps the tool exchange so the model sees how it acted before.
        assert [m["role"] for m in out["history"]] == ["user", "assistant", "user", "assistant", "tool", "assistant"]
        assert out["history"][-1] == {"role": "assistant", "content": "Started; I will let you know."}

    def test_tool_loop_is_bounded(self, monkeypatch):
        loop = {"content": "", "tool_calls": [_tool_call("check_harman", {})]}
        self._script(monkeypatch, [dict(loop) for _ in range(callbrain.MAX_TOOL_ROUNDS + 1)])
        out = callbrain.call_turn("s", "/w", "acceptEdits", "status?", [], preset=self.preset,
                                  tool_runner=lambda *a: "still working")
        assert len(out["tools"]) == callbrain.MAX_TOOL_ROUNDS + 1
        assert "say that again" in out["reply"]


def test_trim_history_cuts_on_a_user_turn():
    msgs = []
    for i in range(5):
        msgs += [{"role": "user", "content": f"q{i}"},
                 {"role": "assistant", "content": None, "tool_calls": [_tool_call("check_harman", {})]},
                 {"role": "tool", "tool_call_id": "c1", "content": "r"},
                 {"role": "assistant", "content": f"a{i}"}]
    out = callbrain.trim_history(msgs, limit=6)
    assert out[0] == {"role": "user", "content": "q4"} and len(out) == 4
    assert callbrain.trim_history(msgs[:3], limit=6) == msgs[:3]


class TestRunTool:
    def test_ask_harman_maps_start_turn_outcomes(self, monkeypatch):
        from viewer import turn
        results = iter([None, (409, "busy"), (400, "Provider gone")])
        monkeypatch.setattr(turn, "start_turn", lambda *a, **k: next(results))
        assert callbrain.run_tool("ask_harman", {"question": "x"}, "s", "/w", "m").startswith("Started")
        assert "busy" in callbrain.run_tool("ask_harman", {"question": "x"}, "s", "/w", "m")
        assert "Provider gone" in callbrain.run_tool("ask_harman", {"question": "x"}, "s", "/w", "m")
        assert callbrain.run_tool("ask_harman", {"question": "  "}, "s", "/w", "m") == "Nothing to ask."

    def test_check_harman_without_transcript(self, monkeypatch):
        monkeypatch.setattr(callbrain, "transcript_path", lambda sid: None)
        monkeypatch.setattr(callbrain, "CHAT_JOBS", {})
        assert "No request" in callbrain.run_tool("check_harman", {}, "s", "/w", "m")

    def test_board_status_unbound_session(self, monkeypatch):
        from viewer import db
        monkeypatch.setattr(db, "session_meta_get", lambda sid: {})
        assert "no board" in callbrain.run_tool("board_status", {}, "s", "/w", "m")

    def test_unknown_tool(self):
        assert "Unknown tool" in callbrain.run_tool("nope", {}, "s", "/w", "m")
