"""Unit tests for viewer.mcp_probe pure helpers.

Pure only: no network, no subprocess. The transport dispatch itself is verified
against real servers by hand (see the plan's verification section) — what is
worth pinning here is the parsing, because that is where a wrong answer would be
silent: a working server rendered as broken, or an auth prompt rendered as a
crash.
"""
from viewer.mcp_probe import (
    STATE_AUTH, STATE_FAILED, STATE_OK,
    _auth_hint, _infer_transport, _parse_frame, _rpc_error, _server_info,
    _stdio_command, _tail, _tool_rows, probe,
)


class TestInferTransport:
    def test_explicit_type_wins(self):
        assert _infer_transport({"type": "http", "url": "x"}) == "http"
        assert _infer_transport({"type": "sse", "url": "x"}) == "sse"
        assert _infer_transport({"type": "stdio", "command": "x"}) == "stdio"

    def test_streamable_http_normalised(self):
        assert _infer_transport({"type": "streamable-http", "url": "x"}) == "http"

    def test_url_implies_http(self):
        assert _infer_transport({"url": "https://example/mcp"}) == "http"

    def test_default_is_stdio(self):
        assert _infer_transport({"command": "npx"}) == "stdio"
        assert _infer_transport({}) == "stdio"

    def test_unknown_type_falls_back_to_shape(self):
        assert _infer_transport({"type": "weird", "url": "x"}) == "http"
        assert _infer_transport({"type": "weird", "command": "x"}) == "stdio"


class TestParseFrame:
    def test_plain_json(self):
        assert _parse_frame("application/json", '{"id":1}') == {"id": 1}

    def test_sse_data_line(self):
        # Measured shape: a real server answers text/event-stream with the
        # JSON-RPC payload on a data: line. Reading only plain JSON would make
        # every such server look broken.
        raw = 'event: message\ndata: {"result":{"tools":[]}}\n\n'
        assert _parse_frame("text/event-stream", raw) == {"result": {"tools": []}}

    def test_sse_skips_non_json_data_lines(self):
        raw = "data: ping\ndata: {\"id\":7}\n"
        assert _parse_frame("text/event-stream", raw) == {"id": 7}

    def test_content_type_with_charset(self):
        raw = 'data: {"id":3}\n'
        assert _parse_frame("text/event-stream; charset=utf-8", raw) == {"id": 3}

    def test_unparseable_is_empty_not_raised(self):
        assert _parse_frame("application/json", "<html>nope</html>") == {}
        assert _parse_frame("text/event-stream", "event: end\n") == {}
        assert _parse_frame(None, "") == {}


class TestToolRows:
    def test_name_and_description(self):
        rows = _tool_rows({"tools": [{"name": "search", "description": "Find things"}]})
        assert rows == [{"name": "search", "description": "Find things"}]

    def test_drops_unusable_entries(self):
        rows = _tool_rows({"tools": ["str", {"description": "no name"}, {"name": ""}, 3]})
        assert rows == []

    def test_missing_description_becomes_empty(self):
        assert _tool_rows({"tools": [{"name": "t"}]}) == [{"name": "t", "description": ""}]

    def test_long_description_clipped(self):
        rows = _tool_rows({"tools": [{"name": "t", "description": "x" * 5000}]})
        assert len(rows[0]["description"]) == 400

    def test_no_tools_key(self):
        assert _tool_rows({}) == []
        assert _tool_rows({"tools": "nope"}) == []
        assert _tool_rows(None) == []


class TestServerInfo:
    def test_reads_name_and_version(self):
        assert _server_info({"serverInfo": {"name": "Phoenix", "version": "1.0.0"}}) == {
            "name": "Phoenix", "version": "1.0.0"}

    def test_missing_or_wrong_shape(self):
        assert _server_info({}) == {}
        assert _server_info({"serverInfo": "x"}) == {}
        assert _server_info(None) == {}


class TestAuthHint:
    def test_extracts_resource_metadata_url(self):
        # The one genuinely actionable part of a 401 challenge.
        ch = 'Bearer resource_metadata="https://x.example/.well-known/oauth-protected-resource"'
        assert _auth_hint(ch) == "https://x.example/.well-known/oauth-protected-resource"

    def test_falls_back_to_raw_challenge(self):
        assert _auth_hint("Bearer realm=x") == "Bearer realm=x"
        assert _auth_hint("") == ""
        assert _auth_hint(None) == ""


class TestStdioCommand:
    def test_joins_and_quotes(self):
        assert _stdio_command({"command": "npx", "args": ["-y", "some-server"]}) == \
            "npx -y some-server"

    def test_quotes_spaces(self):
        cmd = _stdio_command({"command": "/opt/my dir/bin", "args": ["a b"]})
        assert cmd == "'/opt/my dir/bin' 'a b'"

    def test_non_string_args_coerced(self):
        assert _stdio_command({"command": "x", "args": [1, True]}) == "x 1 True"

    def test_empty(self):
        assert _stdio_command({}) == ""


class TestMisc:
    def test_rpc_error_message(self):
        assert _rpc_error({"message": "Method not found", "code": -32601}) == \
            "Method not found (code -32601)"
        assert _rpc_error("plain") == "plain"

    def test_tail_keeps_the_end(self):
        # Failures put the useful line last; clipping must not drop it.
        assert _tail("a" * 50 + "ERROR HERE", limit=10) == "ERROR HERE"
        assert _tail("  short  ") == "short"
        assert _tail(None) == ""


class TestProbeGuards:
    """probe() must never raise, and must never touch the network/process table
    for a config it cannot use."""

    def test_non_dict_config(self):
        r = probe("x", "not-a-dict")
        assert r["state"] == STATE_FAILED
        assert "not an object" in r["error"]

    def test_stdio_without_command(self):
        r = probe("x", {"command": ""})
        assert r["state"] == STATE_FAILED
        assert "No command" in r["error"]

    def test_http_without_url(self):
        r = probe("x", {"type": "http"})
        assert r["state"] == STATE_FAILED
        assert "No url" in r["error"]

    def test_result_shape_is_always_complete(self):
        # The UI reads every key unconditionally; a missing one is a crash.
        r = probe("x", {})
        for k in ("name", "transport", "state", "error", "detail", "tools",
                  "server", "elapsed_ms"):
            assert k in r
        assert r["state"] in (STATE_OK, STATE_AUTH, STATE_FAILED)
