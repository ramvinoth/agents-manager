"""deploy/gateway_keepalive.py: which requests get keep-alive, and the frames it writes.

The proxy itself runs on the GPU box (aiohttp); these are its pure decisions.
"""
import importlib.util
import json
import pathlib

_P = pathlib.Path(__file__).resolve().parents[2] / "deploy" / "gateway_keepalive.py"
_spec = importlib.util.spec_from_file_location("gateway_keepalive", _P)
ka = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ka)


def test_only_streaming_messages_posts_get_keepalive():
    body = json.dumps({"stream": True}).encode()
    assert ka.wants_keepalive("POST", "/v1/messages", body)
    assert ka.wants_keepalive("POST", "/upstream/qwen/v1/messages/", body)
    assert not ka.wants_keepalive("GET", "/v1/messages", body)
    assert not ka.wants_keepalive("POST", "/v1/messages/count_tokens", body)
    assert not ka.wants_keepalive("POST", "/v1/messages", b'{"stream": false}')
    assert not ka.wants_keepalive("POST", "/v1/messages", b'{"stream": "yes"}')
    assert not ka.wants_keepalive("POST", "/v1/messages", b"not json")
    assert not ka.wants_keepalive("POST", "/v1/messages", b"[1, 2]")


def test_pings_only_land_between_events():
    assert ka.at_boundary(b"data: {}\n\n", b"")
    assert ka.at_boundary(b"\n", b"x\n")            # boundary split across chunks
    assert ka.at_boundary(b"\r\n", b"x\r\n")
    assert not ka.at_boundary(b'data: {"te', b"")     # mid-event
    assert not ka.at_boundary(b"event: ping\n", b"")


def _frame(raw):
    head, data = raw.decode().split("\n", 1)
    assert head == "event: error" and raw.endswith(b"\n\n")
    return json.loads(data[len("data: "):].strip())


def test_error_frame_keeps_an_anthropic_error_from_the_gateway():
    body = json.dumps({"type": "error", "error": {"type": "invalid_request_error",
                                                   "message": "prompt is too long: 9 tokens > 8 maximum"}})
    got = _frame(ka.error_event(400, body.encode()))
    assert got == {"type": "error", "error": {"type": "invalid_request_error",
                                              "message": "prompt is too long: 9 tokens > 8 maximum"}}


def test_error_frame_wraps_anything_else():
    got = _frame(ka.error_event(503, b"<html>bad gateway</html>"))
    assert got["error"]["type"] == "overloaded_error"
    assert "503" in got["error"]["message"] and "bad gateway" in got["error"]["message"]
    assert _frame(ka.error_event(500, '{"error": "flat string"}'))["error"]["type"] == "api_error"
