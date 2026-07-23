"""Unit tests for viewer.adapters — the raw-agent-JSONL -> Claude-schema
normalizers (a silent format drift here empties transcripts) and the
path-traversal guard on resolve_agent_session."""
import json

from viewer import adapters
from viewer.adapters import (
    _codex_line, _copilot_line, _pi_line, normalize_lines, resolve_agent_session,
)


def _n(fn, d):
    """Run a normalizer on a dict, returning the parsed result (or None)."""
    r = fn(d, json.dumps(d))
    return json.loads(r) if r is not None else None


class TestCopilotNormaliser:
    def test_user_message(self):
        o = _n(_copilot_line, {"type": "user.message", "id": "u1", "timestamp": 1,
                               "data": {"content": "hi"}})
        assert o["type"] == "user" and o["message"]["content"] == "hi" and o["uuid"] == "u1"

    def test_empty_user_dropped(self):
        assert _n(_copilot_line, {"type": "user.message", "data": {"content": ""}}) is None

    def test_assistant_text_thinking_model_usage(self):
        o = _n(_copilot_line, {"type": "assistant.message", "id": "a1", "data": {
            "content": "hello", "reasoningText": "hmm", "model": "haiku-4.5", "outputTokens": 5}})
        blocks = o["message"]["content"]
        assert blocks[0] == {"type": "thinking", "thinking": "hmm"}
        assert blocks[1] == {"type": "text", "text": "hello"}
        assert o["message"]["model"] == "haiku-4.5"
        assert o["message"]["usage"]["output_tokens"] == 5

    def test_tool_start_and_complete(self):
        start = _n(_copilot_line, {"type": "tool.execution_start", "id": "s", "data": {
            "toolCallId": "t1", "toolName": "bash", "arguments": {"command": "ls"}}})
        tu = start["message"]["content"][0]
        assert start["type"] == "assistant"
        assert tu == {"type": "tool_use", "id": "t1", "name": "bash", "input": {"command": "ls"}}
        comp = _n(_copilot_line, {"type": "tool.execution_complete", "id": "c", "data": {
            "toolCallId": "t1", "result": {"content": "out"}}})
        tr = comp["message"]["content"][0]
        assert comp["type"] == "user"
        assert tr["type"] == "tool_result" and tr["tool_use_id"] == "t1" and tr["content"] == "out"

    def test_non_transcript_type_dropped(self):
        assert _n(_copilot_line, {"type": "session.start", "data": {}}) is None


class TestCodexNormaliser:
    def test_user_message(self):
        o = _n(_codex_line, {"type": "response_item", "timestamp": 1,
                             "payload": {"type": "message", "role": "user", "content": "do it"}})
        assert o["type"] == "user" and o["message"]["content"] == "do it"

    def test_meta_prefixed_user_dropped(self):
        assert _n(_codex_line, {"type": "response_item", "payload": {
            "type": "message", "role": "user", "content": "<user_instructions>x"}}) is None

    def test_developer_role_dropped(self):
        assert _n(_codex_line, {"type": "response_item", "payload": {
            "type": "message", "role": "developer", "content": "x"}}) is None

    def test_function_call_parses_arguments(self):
        o = _n(_codex_line, {"type": "response_item", "payload": {
            "type": "function_call", "name": "shell", "call_id": "c1",
            "arguments": '{"cmd": "ls"}'}})
        tu = o["message"]["content"][0]
        assert tu["name"] == "shell" and tu["id"] == "c1" and tu["input"] == {"cmd": "ls"}

    def test_non_response_item_dropped(self):
        assert _n(_codex_line, {"type": "event_msg"}) is None


class TestPiNormaliser:
    def test_user(self):
        o = _n(_pi_line, {"type": "message", "id": "p1", "message": {
            "role": "user", "content": [{"type": "text", "text": "hey"}]}})
        assert o["type"] == "user" and o["uuid"] == "p1"

    def test_assistant_text_and_toolcall(self):
        o = _n(_pi_line, {"type": "message", "message": {"role": "assistant", "content": [
            {"type": "text", "text": "ok"},
            {"type": "toolCall", "id": "t", "name": "read", "arguments": {"p": "x"}}]}})
        blocks = o["message"]["content"]
        assert blocks[0]["type"] == "text"
        assert blocks[1] == {"type": "tool_use", "id": "t", "name": "read", "input": {"p": "x"}}

    def test_tool_result(self):
        o = _n(_pi_line, {"type": "message", "message": {"role": "toolResult",
                          "toolCallId": "t", "content": [{"type": "text", "text": "res"}]}})
        tr = o["message"]["content"][0]
        assert tr["tool_use_id"] == "t" and tr["content"] == "res"

    def test_empty_assistant_dropped(self):
        assert _n(_pi_line, {"type": "message", "message": {"role": "assistant", "content": []}}) is None


class TestNormalizeLines:
    def test_claude_and_unknown_passthrough(self):
        lines = ['{"type":"user"}', "not json"]
        assert normalize_lines("claude", lines) == lines
        assert normalize_lines("mystery-agent", lines) == lines

    def test_copilot_maps_and_skips_garbage(self):
        lines = [
            json.dumps({"type": "session.start", "data": {}}),
            json.dumps({"type": "user.message", "id": "u", "data": {"content": "hi"}}),
            "garbage-not-json",
        ]
        out = normalize_lines("copilot", lines)
        assert len(out) == 1
        assert json.loads(out[0])["message"]["content"] == "hi"


class TestResolveAgentSessionGuard:
    def test_traversal_rejected(self):
        assert resolve_agent_session("codex", "../../etc/passwd") is None
        assert resolve_agent_session("codex", "../../../../etc/passwd") is None

    def test_nonexistent_in_root_returns_none(self):
        assert resolve_agent_session("codex", "definitely-not-a-real-session.jsonl") is None

    def test_valid_file_resolves(self, tmp_path, monkeypatch):
        root = tmp_path / "sessions"
        root.mkdir()
        f = root / "s.jsonl"
        f.write_text("x")
        monkeypatch.setattr(adapters, "_root", lambda a: root.resolve())
        assert resolve_agent_session("codex", "s.jsonl") == f.resolve()

    def test_escape_outside_root_rejected(self, tmp_path, monkeypatch):
        root = tmp_path / "sessions"
        root.mkdir()
        (tmp_path / "secret.txt").write_text("x")
        monkeypatch.setattr(adapters, "_root", lambda a: root.resolve())
        assert resolve_agent_session("codex", "../secret.txt") is None
