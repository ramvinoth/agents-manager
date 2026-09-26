"""Hermetic tests for the Nemotron voicechat proxy: the pure adapter
(viewer.nemotron) in isolation, and the route handlers (viewer.routes.voice's
VoiceMixin) exercised directly against fakes — no real subprocess, no real
GPU/FastAPI service, no DB, no production writes.

Run with:  /usr/bin/python3 -m pytest tests/unit/test_nemotron.py -v
"""
import json
import subprocess
import sys
import threading
import types
from pathlib import Path

import pytest

from viewer import nemotron
from viewer.routes.voice import VoiceMixin


# ===================== viewer.nemotron: pure adapter =====================

def test_disabled_by_default(monkeypatch):
    monkeypatch.setattr(nemotron, "NEMOTRON_URL", "")
    monkeypatch.setattr(nemotron, "NEMOTRON_TOKEN_FILE", None)
    assert nemotron.enabled() is False
    assert nemotron.status() == {"enabled": False, "installed": False,
                                  "ready": False, "busy": False}


def test_status_requires_both_url_and_token_file(monkeypatch):
    monkeypatch.setattr(nemotron, "NEMOTRON_URL", "http://gpu.example:8098")
    monkeypatch.setattr(nemotron, "NEMOTRON_TOKEN_FILE", None)
    assert nemotron.enabled() is False


def test_sanitize_event_strips_private_fields_and_control_tokens():
    raw = {"kind": "turn_end", "text": "</s><s>Hello there<pad>",
           "path": "/Users/ram/.claude/x", "audio": "server-only", "cwd": "/tmp"}
    clean = nemotron.sanitize_event(raw)
    assert clean == {"kind": "turn_end", "text": "Hello there"}


def test_sanitize_event_rejects_non_dict():
    assert nemotron.sanitize_event("not a dict") == {"kind": "error", "message": "malformed event"}


def test_slot_is_single(monkeypatch):
    monkeypatch.setattr(nemotron, "_slot_taken", False)
    assert nemotron.try_acquire_slot() is True
    assert nemotron.try_acquire_slot() is False
    nemotron.release_slot()
    assert nemotron.try_acquire_slot() is True
    nemotron.release_slot()


def test_convert_to_wav16k_rejects_empty():
    with pytest.raises(nemotron.NemotronError):
        nemotron.convert_to_wav16k(b"")


def test_convert_to_wav16k_rejects_oversized(monkeypatch):
    monkeypatch.setattr(nemotron, "MAX_UPLOAD_BYTES", 4)
    with pytest.raises(nemotron.NemotronError):
        nemotron.convert_to_wav16k(b"12345")


class _FakeProc:
    """Stands in for subprocess.Popen so convert_to_wav16k's cancellation path
    can be tested without a real ffmpeg binary or real timing. convert_to_wav16k
    now writes its output to a real temp file (the last argv element) rather
    than stdout — see nemotron.convert_to_wav16k's docstring for why a pipe's
    non-seekability made the WAV header lie about frame count — so this fake
    writes there too. `communicate()` blocks for real (on an Event) until
    `kill()` fires, instead of raising TimeoutExpired immediately: raising
    up front let the old test claim to prove the cancel-during-conversion
    path while never actually exercising it — `cancel()` was never given a
    chance to run before the fake had already decided the answer was
    "timed out"."""
    def __init__(self, argv, hang=False):
        self.out_path = argv[-1]
        self.hang = hang
        self.killed = False
        self.returncode = 0
        self._killed_event = threading.Event()

    def communicate(self, input=None, timeout=None):
        if self.hang:
            # Block until kill() is called (simulating a real subprocess that
            # doesn't exit until signalled) or until the caller's own
            # subprocess.TimeoutExpired timeout would fire.
            if not self._killed_event.wait(timeout):
                raise subprocess.TimeoutExpired(cmd="ffmpeg", timeout=timeout)
            return None, None
        Path(self.out_path).write_bytes(b"RIFF....WAVEfake")
        return None, None

    def kill(self):
        self.killed = True
        self._killed_event.set()

    def wait(self):
        return 0


def test_convert_to_wav16k_happy_path(monkeypatch):
    monkeypatch.setattr(subprocess, "Popen", lambda argv, **k: _FakeProc(argv))
    out = nemotron.convert_to_wav16k(b"fake-m4a-bytes")
    assert out == b"RIFF....WAVEfake"


def test_convert_to_wav16k_cancel_kills_subprocess(monkeypatch):
    holder = {}
    monkeypatch.setattr(subprocess, "Popen",
                        lambda argv, **k: holder.setdefault("proc", _FakeProc(argv, hang=True)))
    monkeypatch.setattr(nemotron, "CANCEL_POLL", 0.01)
    with pytest.raises(nemotron.NemotronError, match="cancelled"):
        nemotron.convert_to_wav16k(b"fake-m4a-bytes", cancel=lambda: True)
    assert holder["proc"].killed is True



# ===================== route handlers: fakes, no real server =====================

class _FakeWS:
    """A scripted client-facing WSServer stand-in: recv() plays back a fixed
    script of (opcode, payload) frames, then a close; sent frames are captured
    for assertion."""
    def __init__(self, script):
        self._script = list(script)
        self.sent_text = []
        self.sent_bytes = []
        self.closed = False

    def recv(self):
        if not self._script:
            return 0x8, b""
        return self._script.pop(0)

    def send_text(self, data):
        self.sent_text.append(json.loads(data))

    def send_bytes(self, data):
        self.sent_bytes.append(data)

    def close(self):
        self.closed = True


class _FakeUpstream:
    """A scripted _UpstreamWS stand-in for the GPU service side."""
    def __init__(self, events):
        self._events = list(events)
        self.sent = []
        self.closed = False

    def send_bytes(self, data):
        self.sent.append(data)

    def recv(self):
        if not self._events:
            raise nemotron.NemotronError("no more events")
        return self._events.pop(0)

    def close(self):
        self.closed = True


class _Handler(VoiceMixin):
    def __init__(self, principal, query, ws=None, resolved_path="ok"):
        self._principal_val = principal
        self._query = query
        self._ws = ws
        self._resolved_path = resolved_path
        self.sent = None

    def send_json(self, data, status=200):
        self.sent = (data, status)

    def resolve_session_quiet(self, rel):
        return self._resolved_path


class _Req:
    def __init__(self, principal, query):
        self.principal = principal
        self.query = query


def _install_fake_ws_upgrade(monkeypatch, ws):
    fake_module = types.SimpleNamespace(WSServer=types.SimpleNamespace(upgrade=lambda handler: ws))
    monkeypatch.setitem(sys.modules, "viewer.browser", fake_module)


def test_status_route_reports_disabled(monkeypatch):
    monkeypatch.setattr(nemotron, "status", lambda: {"enabled": False, "installed": False,
                                                       "ready": False, "busy": False})
    h = _Handler(principal={"kind": "app"}, query={})
    h._g_voice_nemotron_status(None)
    assert h.sent == ({"enabled": False, "installed": False, "ready": False, "busy": False}, 200)


def test_status_route_surfaces_nemotron_error_as_502(monkeypatch):
    def _boom():
        raise nemotron.NemotronError("gpu box unreachable")
    monkeypatch.setattr(nemotron, "status", _boom)
    h = _Handler(principal={"kind": "app"}, query={})
    h._g_voice_nemotron_status(None)
    assert h.sent[1] == 502
    assert "gpu box unreachable" in h.sent[0]["error"]


def test_ws_route_denies_non_app_principal(monkeypatch):
    """An MCP agent session principal must never be able to place a live call —
    per-caller authorization beyond plain path traversal."""
    h = _Handler(principal={"kind": "mcp"}, query={"path": ["sess"]})
    req = _Req(principal={"kind": "mcp"}, query={"path": ["sess"]})
    h._g_voice_nemotron_ws(req)
    assert h.sent[1] == 403


def test_ws_route_denies_unresolvable_session(monkeypatch):
    h = _Handler(principal={"kind": "app"}, query={"path": ["../etc/passwd"]},
                 resolved_path=None)
    req = _Req(principal={"kind": "app"}, query={"path": ["../etc/passwd"]})
    h._g_voice_nemotron_ws(req)
    assert h.sent[1] == 404


def test_ws_route_refuses_when_disabled(monkeypatch):
    monkeypatch.setattr(nemotron, "enabled", lambda: False)
    h = _Handler(principal={"kind": "app"}, query={"path": ["sess"]})
    req = _Req(principal={"kind": "app"}, query={"path": ["sess"]})
    h._g_voice_nemotron_ws(req)
    assert h.sent[1] == 502


def test_ws_route_second_caller_gets_busy_and_closes(monkeypatch):
    monkeypatch.setattr(nemotron, "enabled", lambda: True)
    monkeypatch.setattr(nemotron, "try_acquire_slot", lambda: False)
    monkeypatch.setattr(nemotron, "release_slot", lambda: None)
    ws = _FakeWS(script=[])
    _install_fake_ws_upgrade(monkeypatch, ws)
    h = _Handler(principal={"kind": "app"}, query={"path": ["sess"]})
    req = _Req(principal={"kind": "app"}, query={"path": ["sess"]})
    h._g_voice_nemotron_ws(req)
    assert ws.sent_text == [{"kind": "error", "message": "busy"}]
    assert ws.closed is True


def test_ws_route_forwards_one_turn_binary_then_turn_end(monkeypatch):
    """The core wire-order contract: reply audio arrives before its turn_end
    JSON, exactly mirroring the GPU service's own send order."""
    monkeypatch.setattr(nemotron, "enabled", lambda: True)
    monkeypatch.setattr(nemotron, "try_acquire_slot", lambda: True)
    released = []
    monkeypatch.setattr(nemotron, "release_slot", lambda: released.append(True))
    monkeypatch.setattr(nemotron, "convert_to_wav16k", lambda payload, cancel=None: b"WAVDATA")
    upstream = _FakeUpstream(events=[
        (0x1, json.dumps({"kind": "ready"}).encode()),
        (0x2, b"REPLYAUDIO"),
        (0x1, json.dumps({"kind": "turn_end", "text": "hi"}).encode()),
    ])
    monkeypatch.setattr(nemotron, "open_upstream", lambda: upstream)
    ws = _FakeWS(script=[(0x2, b"clientm4a"), (0x8, b"")])
    _install_fake_ws_upgrade(monkeypatch, ws)

    h = _Handler(principal={"kind": "app"}, query={"path": ["sess"]})
    req = _Req(principal={"kind": "app"}, query={"path": ["sess"]})
    h._g_voice_nemotron_ws(req)

    assert ws.sent_bytes == [b"REPLYAUDIO"]
    assert ws.sent_text == [{"kind": "ready"}, {"kind": "turn_end", "text": "hi"}]
    assert upstream.sent == [b"WAVDATA"]
    assert upstream.closed is True
    assert ws.closed is True
    assert released == [True]


def test_ws_route_fails_closed_on_tool_call(monkeypatch):
    """Even if a future service bug forwarded a tool_call, the viewer must
    never execute or relay it — it becomes a plain error instead."""
    monkeypatch.setattr(nemotron, "enabled", lambda: True)
    monkeypatch.setattr(nemotron, "try_acquire_slot", lambda: True)
    monkeypatch.setattr(nemotron, "release_slot", lambda: None)
    monkeypatch.setattr(nemotron, "convert_to_wav16k", lambda payload, cancel=None: b"WAVDATA")
    upstream = _FakeUpstream(events=[
        (0x1, json.dumps({"kind": "ready"}).encode()),
        (0x1, json.dumps({"kind": "tool_call", "text": "rm -rf /"}).encode()),
    ])
    monkeypatch.setattr(nemotron, "open_upstream", lambda: upstream)
    ws = _FakeWS(script=[(0x2, b"clientm4a"), (0x8, b"")])
    _install_fake_ws_upgrade(monkeypatch, ws)

    h = _Handler(principal={"kind": "app"}, query={"path": ["sess"]})
    req = _Req(principal={"kind": "app"}, query={"path": ["sess"]})
    h._g_voice_nemotron_ws(req)

    assert ws.sent_text == [{"kind": "ready"}, {"kind": "error", "message": "tool calls are not supported"}]
    assert ws.sent_bytes == []


def test_ws_route_relays_ready_before_reading_client_audio(monkeypatch):
    """The model loads per call. A correct phone waits for `ready` before it
    sends audio, so the route must relay ready FIRST — reading the client
    first would deadlock both sides. A load failure ends the call with the
    service's own error and never consumes client audio."""
    monkeypatch.setattr(nemotron, "enabled", lambda: True)
    monkeypatch.setattr(nemotron, "try_acquire_slot", lambda: True)
    monkeypatch.setattr(nemotron, "release_slot", lambda: None)
    converted = []
    monkeypatch.setattr(nemotron, "convert_to_wav16k",
                        lambda payload, cancel=None: converted.append(payload) or b"WAV")
    upstream = _FakeUpstream(events=[
        (0x1, json.dumps({"kind": "error", "message": "model failed to load"}).encode()),
    ])
    monkeypatch.setattr(nemotron, "open_upstream", lambda: upstream)
    ws = _FakeWS(script=[(0x2, b"clientm4a"), (0x8, b"")])
    _install_fake_ws_upgrade(monkeypatch, ws)

    h = _Handler(principal={"kind": "app"}, query={"path": ["sess"]})
    h._g_voice_nemotron_ws(_Req(principal={"kind": "app"}, query={"path": ["sess"]}))

    assert ws.sent_text == [{"kind": "error", "message": "model failed to load"}]
    assert converted == []
    assert upstream.sent == []
    assert ws.closed is True


def test_ws_route_never_calls_legacy_stt_tts(monkeypatch):
    """Proves there is no silent fallback: the legacy viewer.voice functions
    must receive zero calls anywhere on the Nemotron path."""
    from viewer import voice as legacy_voice
    calls = []
    monkeypatch.setattr(legacy_voice, "segment",
                        lambda *a, **k: calls.append("segment") or {})
    monkeypatch.setattr(legacy_voice, "wakeguard",
                        lambda *a, **k: calls.append("wakeguard") or {})

    monkeypatch.setattr(nemotron, "enabled", lambda: True)
    monkeypatch.setattr(nemotron, "try_acquire_slot", lambda: True)
    monkeypatch.setattr(nemotron, "release_slot", lambda: None)
    monkeypatch.setattr(nemotron, "convert_to_wav16k", lambda payload, cancel=None: b"WAVDATA")
    upstream = _FakeUpstream(events=[
        (0x2, b"REPLYAUDIO"),
        (0x1, json.dumps({"kind": "turn_end", "text": "hi"}).encode()),
    ])
    monkeypatch.setattr(nemotron, "open_upstream", lambda: upstream)
    ws = _FakeWS(script=[(0x2, b"clientm4a"), (0x8, b"")])
    _install_fake_ws_upgrade(monkeypatch, ws)

    h = _Handler(principal={"kind": "app"}, query={"path": ["sess"]})
    req = _Req(principal={"kind": "app"}, query={"path": ["sess"]})
    h._g_voice_nemotron_ws(req)

    assert calls == []


def test_ws_route_upstream_open_failure_reports_error_and_releases_slot(monkeypatch):
    monkeypatch.setattr(nemotron, "enabled", lambda: True)
    monkeypatch.setattr(nemotron, "try_acquire_slot", lambda: True)
    released = []
    monkeypatch.setattr(nemotron, "release_slot", lambda: released.append(True))

    def _boom():
        raise nemotron.NemotronError("Nemotron service unreachable: refused")
    monkeypatch.setattr(nemotron, "open_upstream", _boom)
    ws = _FakeWS(script=[])
    _install_fake_ws_upgrade(monkeypatch, ws)

    h = _Handler(principal={"kind": "app"}, query={"path": ["sess"]})
    req = _Req(principal={"kind": "app"}, query={"path": ["sess"]})
    h._g_voice_nemotron_ws(req)

    assert ws.sent_text == [{"kind": "error", "message": "Nemotron service unreachable: refused"}]
    assert released == [True]
    assert ws.closed is True
