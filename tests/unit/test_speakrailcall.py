"""orchestrator.speakrailcall — Speakrail LFM3 ASR + Breeze TTS as a calllive provider.

The pure state machine (SrAsrState) gets the adapter's turn frames and transcript
deltas; the two socket adapters get fake transports; one full-bridge smoke test
proves calllive drives the provider unchanged. The adapter's own wire (its three
probability patterns, its word timestamps) is exercised verbatim here, because
it is our own code on the box."""
import json
import queue
import threading
import urllib.error
import urllib.request

import pytest

from orchestrator import calllive, speakrailcall
from orchestrator.speakrailcall import SrAsrState, BreezeTtsSocket, SpeakrailAsrSocket
from orchestrator.speakrailcall import _SPEECH, _COMPLETE, _TRANS
from orchestrator.calllive import pack
from orchestrator.wsclient import OP_BINARY, OP_CLOSE, OP_TEXT
from test_calllive import FakeFish, FakePhone, wait_for


# ------------------------------------------------------------------ classify

def test_classify_the_three_patterns():
    assert speakrailcall.classify(_SPEECH) == "speech"
    assert speakrailcall.classify(_COMPLETE) == "complete"
    assert speakrailcall.classify(_TRANS) == "transient"


def test_classify_is_by_mass_not_exact_match():
    assert speakrailcall.classify([0.99, 0.1, 0, 0, 0, 0, 0, 0]) == "speech"
    assert speakrailcall.classify([0, 0.99, 0, 0, 0, 0.95, 0, 0]) == "complete"
    assert speakrailcall.classify([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]) == "transient"
    assert speakrailcall.classify([]) == "transient"


# ------------------------------------------------------------------ SrAsrState

def words(*specs, at=None):
    """(text, start, end) triples; `at` shifts every start."""
    if at is None:
        return [{"text": t, "start": s, "end": e} for t, s, e in specs]
    return [{"text": t, "start": s + at, "end": e + at} for t, s, e in specs]


def test_first_user_turn_committed():
    s = SrAsrState()
    assert s.on_frame(0, _SPEECH) == [{"type": "user_turn_taken", "turn_index": 1}]
    assert s.on_frame(80, _SPEECH) == []
    assert s.on_words(words(("show", 100, 300), ("me", 300, 500))) == []
    assert s.on_frame(640, _TRANS) == []
    assert s.on_frame(1280, _COMPLETE) == [
        {"type": "committed", "turn_index": 1, "text": "show me", "user_turn": True}]
    assert s.on_frame(1360, _SPEECH) == [
        {"type": "user_turn_taken", "turn_index": 2}]   # the next sentence is a new turn


def test_agent_voice_is_dropped_and_its_tail_filtered_by_time():
    s = SrAsrState()
    s.set_agent_speaking(True)
    assert s.on_frame(100, _SPEECH) == []
    assert s.on_words(words(("checking", 50, 200))) == []
    s.set_agent_speaking(False)
    assert s.on_frame(200, _TRANS) == []                # arms the leak window: until 500
    assert s.on_words(words(("checking", 350, 450))) == []   # the model's tail: dropped, no turn
    assert s.on_frame(640, _SPEECH) == [{"type": "user_turn_taken", "turn_index": 1}]
    s.on_words(words(("show", 600, 700), ("the", 700, 800), ("board", 800, 900)))
    assert s.on_frame(1280, _COMPLETE) == [
        {"type": "committed", "turn_index": 1, "text": "show the board", "user_turn": True}]


def test_continuous_speech_after_agent_stop_latches():
    s = SrAsrState()
    s.set_agent_speaking(True)
    s.set_agent_speaking(False)
    for i, t in enumerate(range(200, 600, 80)):         # ring-out, then the caller still talking
        acts = s.on_frame(t, _SPEECH)
        if i < 4:
            assert acts == []                           # the latch: 5 frames of continuous speech
        else:
            assert acts == [{"type": "user_turn_taken", "turn_index": 1}]
    s.on_words(words(("go", 520, 600)))                 # ends after the leak window (500)
    assert s.on_frame(800, _COMPLETE) == [
        {"type": "committed", "turn_index": 1, "text": "go", "user_turn": True}]


def test_latch_cleared_by_a_boundary_not_by_words():
    s = SrAsrState()
    s.set_agent_speaking(True)
    s.set_agent_speaking(False)
    s.on_frame(200, _SPEECH)
    assert s.on_words(words(("leak", 250, 350))) == []  # not settled: the word is dropped
    s.on_frame(400, _TRANS)
    assert s.on_frame(480, _SPEECH) == [                # one frame after a boundary opens at once
        {"type": "user_turn_taken", "turn_index": 1}]


def test_quiet_onset_below_the_vad_floor_opens_late():
    s = SrAsrState()
    acts = s.on_words(words(("hello", 100, 200)))       # no speech frame ever fired
    assert acts == [{"type": "user_turn_taken", "turn_index": 1}]
    assert s.on_frame(400, _COMPLETE) == [
        {"type": "committed", "turn_index": 1, "text": "hello", "user_turn": True}]


def test_silence_only_utterance_commits_nothing():
    s = SrAsrState()
    assert s.on_frame(0, _SPEECH) == [{"type": "user_turn_taken", "turn_index": 1}]
    assert s.on_frame(80, _TRANS) == []
    assert s.on_frame(640, _COMPLETE) == []
    assert s.on_frame(720, _SPEECH) == [{"type": "user_turn_taken", "turn_index": 2}]


def test_finish_commits_speech_still_open_when_the_session_ends():
    s = SrAsrState()
    s.on_frame(0, _SPEECH)
    s.on_words(words(("goodbye", 100, 400)))            # no VAD complete ever arrives
    assert s.finish() == [
        {"type": "committed", "turn_index": 1, "text": "goodbye", "user_turn": True}]
    assert s.finish() == []                             # nothing left to commit twice


def test_agent_turn_in_flight_kills_the_open_utterance():
    s = SrAsrState()
    assert s.on_frame(0, _SPEECH) == [{"type": "user_turn_taken", "turn_index": 1}]
    s.on_words(words(("stale", 100, 200)))
    s.set_agent_speaking(True)
    assert s.on_words(words(("still", 300, 400))) == []  # the utterance is dead
    s.set_agent_speaking(False)
    s.on_frame(500, _TRANS)                              # a second leak window (until 800)
    assert s.on_frame(580, _SPEECH) == [{"type": "user_turn_taken", "turn_index": 2}]
    s.on_words(words(("new", 820, 920)))
    assert s.on_frame(1100, _COMPLETE) == [
        {"type": "committed", "turn_index": 2, "text": "new", "user_turn": True}]


def test_agent_restart_reopens_the_leak():
    s = SrAsrState()
    s.set_agent_speaking(True)
    s.set_agent_speaking(False)
    s.on_frame(100, _TRANS)                              # first window: until 400
    s.on_frame(480, _SPEECH)
    s.on_words(words(("one", 480, 580)))
    assert s.on_frame(700, _COMPLETE) == [
        {"type": "committed", "turn_index": 1, "text": "one", "user_turn": True}]
    s.set_agent_speaking(True)
    assert s.on_words(words(("echo", 750, 850))) == []
    s.set_agent_speaking(False)
    s.on_frame(900, _TRANS)                             # a second window: until 1200
    s.on_frame(1200, _SPEECH)
    s.on_words(words(("two", 1200, 1300)))
    assert s.on_frame(1500, _COMPLETE) == [
        {"type": "committed", "turn_index": 2, "text": "two", "user_turn": True}]


def test_agent_stop_latches_after_duplicate_stops():
    s = SrAsrState()
    s.set_agent_speaking(True)
    s.set_agent_speaking(True)                          # duplicate signals are a no-op
    s.set_agent_speaking(False)
    s.set_agent_speaking(False)
    for i, t in enumerate(range(0, 400, 80)):
        acts = s.on_frame(t, _SPEECH)
        assert acts == ([] if i < 4 else [{"type": "user_turn_taken", "turn_index": 1}])
    s.on_words(words(("hi", 400, 500)))                 # ends after the window (300)
    assert s.on_frame(700, _COMPLETE) == [
        {"type": "committed", "turn_index": 1, "text": "hi", "user_turn": True}]


# ------------------------------------------------------------------ ASR socket

class _NullSock:
    def settimeout(self, t):
        pass


class FakeConn:
    """The LFM3 adapter end: a queue of adapter messages, sends recorded."""

    def __init__(self, messages=()):
        self.q = queue.Queue()
        for m in messages:
            self.q.put((OP_TEXT, json.dumps(m).encode()))
        self.sent_bytes = []
        self.sent_text = []
        self.closed = False
        self.timeout = None
        self.sock = _NullSock()

    def recv(self):
        try:
            return self.q.get(timeout=0.05)
        except queue.Empty:
            raise TimeoutError()

    def send_bytes(self, b):
        self.sent_bytes.append(b)

    def send_text(self, s):
        self.sent_text.append(s)

    def close(self):
        self.closed = True


def _mk_conn(messages=()):
    return FakeConn(messages)


def test_socket_translates_the_fish_dialect():
    c = _mk_conn()
    s = SpeakrailAsrSocket(c)
    s.send_bytes(pack({"type": "config", "context": {"history": []}}))
    s.send_bytes(pack({"type": "keepalive"}))
    s.send_bytes(pack({"type": "context_add", "items": []}))
    assert c.sent_bytes == [] and c.sent_text == []
    s.send_bytes(pack({"type": "audio", "data": b"\x01\x02"}))
    assert c.sent_bytes == [b"\x01\x02"]
    s.send_bytes(pack({"type": "agent_speaking", "speaking": True}))
    assert s.state.agent is True
    s.send_bytes(pack({"type": "audio_done"}))
    assert "input_audio.end" in c.sent_text[0]


def test_recv_normalizes_and_queues_events_in_order():
    c = _mk_conn([
        {"type": "session.created", "session_id": "x", "delay_ms": 960},
        {"type": "turn", "frame": 0, "t": 0, "p": _SPEECH},
        {"type": "transcript", "text": " hi", "words": [{"text": "hi", "start": 50, "end": 150}]},
        {"type": "turn", "frame": 10, "t": 800, "p": _COMPLETE},
    ])
    s = SpeakrailAsrSocket(c)
    op, payload = s.recv()                              # session.created is silent: it keeps reading
    ev = calllive.unpack(payload)
    assert op == OP_BINARY and ev == {"type": "user_turn_taken", "turn_index": 1}
    op, payload = s.recv()
    ev = calllive.unpack(payload)
    assert ev == {"type": "committed", "turn_index": 1, "text": "hi", "user_turn": True}
    with pytest.raises(TimeoutError):                   # the queue is dry: the socket timeout propagates
        s.recv()


def test_recv_passes_a_close_through():
    c = _mk_conn()
    c.q.put((OP_CLOSE, b"\x00\x0e"))
    s = SpeakrailAsrSocket(c)
    assert s.recv() == (OP_CLOSE, b"\x00\x0e")
    s.close()
    assert c.closed


def test_dial_dispatches_on_the_url_scheme(monkeypatch):
    sentinel = _mk_conn()
    monkeypatch.setattr("orchestrator.wsclient.dial", lambda url, headers=None: sentinel)
    a = speakrailcall.dial("ws://box:18191/v1/transcribe", {"Authorization": "Bearer t"})
    assert isinstance(a, SpeakrailAsrSocket) and a.conn is sentinel
    b = speakrailcall.dial("http://box:18191/v1/audio/speech", {"Authorization": "Bearer tok"})
    assert isinstance(b, BreezeTtsSocket) and b.token == "tok"


# ------------------------------------------------------------------ Breeze TTS

class FakeBreezeResp:
    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.closed = False

    def read(self, n):
        return self.chunks.pop(0) if self.chunks else b""

    def close(self):
        self.closed = True


def test_tts_stream_keeps_samples_whole(monkeypatch):
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        return FakeBreezeResp([b"ab", b"cde", b"fghij"])   # 2,3,5: odd boundaries everywhere

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    s = BreezeTtsSocket("http://box/speech", token="tok")
    s.send_bytes(pack({"event": "start"}))
    s.send_bytes(pack({"event": "text", "text": "hello"}))
    s.send_bytes(pack({"event": "flush"}))
    s.send_bytes(pack({"event": "stop"}))
    assert calls
    assert calls[0].get_header("Authorization") == "Bearer tok"
    assert json.loads(calls[0].data)["text"] == "hello"
    audio = []
    while True:
        op, payload = s.recv()
        ev = calllive.unpack(payload)
        if op == OP_CLOSE or ev.get("event") == "finish":
            break
        audio.append(ev["audio"])
    assert b"".join(audio) == b"abcdefghij"             # no sample split or lost
    s.close()
    assert s.done and s.recv() == (OP_CLOSE, b"")


def test_tts_barge_closes_the_request(monkeypatch):
    resp = FakeBreezeResp([b"ab", b"cd"])
    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=None: resp)
    s = BreezeTtsSocket("http://box/speech")
    s.send_bytes(pack({"event": "start"}))
    s.send_bytes(pack({"event": "text", "text": "long"}))
    s.send_bytes(pack({"event": "stop"}))
    op, _ = s.recv()
    assert op == OP_BINARY
    s.close()                                           # the barge: cut the request
    assert resp.closed
    assert s.recv() == (OP_CLOSE, b"")


def test_tts_409_is_the_killed_request_releasing(monkeypatch):
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(1)
        if len(calls) == 1:
            raise urllib.error.HTTPError("http://box/speech", 409, "busy", None, None)
        return FakeBreezeResp([b"ab"])

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    s = BreezeTtsSocket("http://box/speech")
    s.send_bytes(pack({"event": "start"}))
    s.send_bytes(pack({"event": "text", "text": "x"}))
    s.send_bytes(pack({"event": "stop"}))
    assert len(calls) == 2
    op, _ = s.recv()
    assert op == OP_BINARY


def test_tts_empty_text_sends_nothing(monkeypatch):
    def fake_urlopen(*a, **k):
        raise AssertionError("no request for empty text")

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    s = BreezeTtsSocket("http://box/speech")
    s.send_bytes(pack({"event": "start"}))
    s.send_bytes(pack({"event": "text", "text": ""}))
    s.send_bytes(pack({"event": "stop"}))
    assert s.recv() == (OP_CLOSE, b"")


# ------------------------------------------------------------------ full bridge

def test_bridge_speakrail_full_turn():
    adapter = _mk_conn()
    asr = SpeakrailAsrSocket(adapter)
    ttses = []

    def dial(url, headers):
        if url.startswith("ws"):
            return asr
        t = FakeFish([(OP_BINARY, pack({"event": "audio", "audio": b"PCM"})),
                      (OP_BINARY, pack({"event": "finish", "reason": "stop"}))])
        ttses.append(t)
        return t

    def brain(text, history, runner):
        return {"reply": "hello " + text,
                "history": history + [{"role": "user", "content": text},
                                      {"role": "assistant", "content": "hello " + text}]}

    phone = FakePhone()
    settings = {"key": "tok", "asr_url": "ws://box/asr", "tts_url": "http://box/tts",
                "tts_model": "", "voice_id": "", "provider": "speakrail"}
    th = threading.Thread(target=calllive.run_bridge,
                          args=(phone, "sid", None, [], settings),
                          kwargs={"dial": dial, "brain": brain, "speakable": lambda s: s},
                          daemon=True)
    th.start()
    assert wait_for(lambda: "ready" in phone.kinds())
    assert adapter.sent_bytes == []                    # the config frame is dropped for this dialect

    phone.inbox.put((OP_BINARY, b"\x01\x02"))          # mic audio rides the adapter's socket
    assert wait_for(lambda: adapter.sent_bytes == [b"\x01\x02"])

    adapter.q.put((OP_TEXT, json.dumps({"type": "session.created", "session_id": "s"}).encode()))
    for i in range(5):
        adapter.q.put((OP_TEXT, json.dumps({"type": "turn", "frame": i, "t": i * 80,
                                            "p": _SPEECH}).encode()))
    adapter.q.put((OP_TEXT, json.dumps({"type": "transcript", "text": " ram",
                                        "words": [{"text": "ram", "start": 400, "end": 700}]}).encode()))
    adapter.q.put((OP_TEXT, json.dumps({"type": "turn", "frame": 10, "t": 800,
                                        "p": _COMPLETE}).encode()))
    assert wait_for(lambda: "audio_end" in phone.kinds())
    assert wait_for(lambda: {"type": "heard", "text": "ram"} in phone.out)
    assert wait_for(lambda: {"type": "reply", "text": "hello ram"} in phone.out)
    assert phone.audio == [b"PCM"]
    assert wait_for(lambda: asr.state.agent is True)   # the agent's speech reaches the ASR state
    gen = [m for m in phone.out if m["type"] == "audio_end"][0]["gen"]
    phone.inbox.put((OP_TEXT, json.dumps({"type": "played", "gen": gen}).encode()))
    assert wait_for(lambda: asr.state.agent is False)
    phone.inbox.put((OP_TEXT, b'{"type":"stop"}'))
    th.join(5)
    assert not th.is_alive()
    assert any("input_audio.end" in t for t in adapter.sent_text)   # audio_done translated at close
    assert adapter.closed
    assert ttses[0].closed                                # the barge at end of call
