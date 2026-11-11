"""Fish call engine: the turn-taking state machine and a fake-Fish bridge."""

import json
import queue
import threading
import time

from orchestrator import fishcall
from orchestrator.fishcall import NeedsCommit, TurnTaker, pack, unpack
from orchestrator.wsclient import OP_BINARY, OP_CLOSE, OP_TEXT


# ------------------------------------------------------------ TurnTaker

def test_eager_then_same_commit_speaks_the_ready_reply():
    t = TurnTaker()
    assert t.on_asr({"type": "eager_end_of_turn", "turn_index": 0, "text": "hi"}) == [("think", 0, "hi", True)]
    assert t.brain_done(0, "hi", "hello") == []          # not committed yet: hold it
    acts = t.on_asr({"type": "committed", "turn_index": 0, "text": "hi"})
    assert acts == [("heard", "hi"), ("speak", 0, "hello")]
    assert t.speaking


def test_commit_before_brain_finishes_waits_for_it():
    t = TurnTaker()
    t.on_asr({"type": "eager_end_of_turn", "turn_index": 0, "text": "hi"})
    assert t.on_asr({"type": "committed", "turn_index": 0, "text": "hi"}) == [("heard", "hi")]
    assert t.brain_done(0, "hi", "hello") == [("speak", 0, "hello")]


def test_commit_with_different_words_rethinks():
    t = TurnTaker()
    t.on_asr({"type": "eager_end_of_turn", "turn_index": 0, "text": "show me"})
    acts = t.on_asr({"type": "committed", "turn_index": 0, "text": "show me the board"})
    assert acts == [("heard", "show me the board"), ("cancel", 0), ("think", 0, "show me the board", False)]
    assert t.brain_done(0, "show me", "stale") == []     # the eager answer is dropped
    assert t.brain_done(0, "show me the board", "fresh") == [("speak", 0, "fresh")]


def test_resumed_turn_drops_the_speculative_answer():
    t = TurnTaker()
    t.on_asr({"type": "eager_end_of_turn", "turn_index": 0, "text": "so"})
    assert t.on_asr({"type": "turn_resumed", "turn_index": 0}) == [("cancel", 0)]
    assert t.brain_done(0, "so", "x") == []
    assert t.on_asr({"type": "turn_resumed", "turn_index": 0}) == []


def test_new_turn_while_speaking_is_a_barge():
    t = TurnTaker()
    t.on_asr({"type": "committed", "turn_index": 0, "text": "hi"})
    t.brain_done(0, "hi", "hello")
    assert t.on_asr({"type": "user_turn_taken", "turn_index": 1}) == [("barge",)]
    assert not t.speaking
    assert t.on_asr({"type": "user_turn_taken", "turn_index": 1}) == []


def test_old_turn_reply_is_stale_once_a_new_turn_starts():
    t = TurnTaker()
    t.on_asr({"type": "committed", "turn_index": 0, "text": "one"})
    t.on_asr({"type": "user_turn_taken", "turn_index": 1})
    assert t.brain_done(0, "one", "late") == []


def test_ignored_events():
    t = TurnTaker()
    for ev in ({"type": "committed", "turn_index": 0, "text": "um", "user_turn": False},
               {"type": "committed", "turn_index": 0, "text": "  "},
               {"type": "user_backchannel"}, {"type": "speech_start"}, {"type": "progress"}):
        assert t.on_asr(ev) == []


def test_deferred_eager_reruns_after_commit():
    t = TurnTaker()
    t.on_asr({"type": "eager_end_of_turn", "turn_index": 0, "text": "approve it"})
    assert t.brain_deferred(0, "approve it") == []       # not committed: commit will ask again
    assert t.on_asr({"type": "committed", "turn_index": 0, "text": "approve it"}) == [
        ("heard", "approve it"), ("think", 0, "approve it", False)]
    t2 = TurnTaker()
    t2.on_asr({"type": "eager_end_of_turn", "turn_index": 0, "text": "approve it"})
    t2.on_asr({"type": "committed", "turn_index": 0, "text": "approve it"})
    assert t2.brain_deferred(0, "approve it") == [("think", 0, "approve it", False)]


def test_asr_config_trims_history_and_keeps_known_fields():
    hist = [{"role": "user", "content": "x" * 3000}, {"role": "tool", "content": "no"},
            {"role": "assistant", "content": "ok"}] + [{"role": "user", "content": str(i)} for i in range(40)]
    cfg = fishcall.asr_config(hist)
    assert set(cfg) == {"type", "audio", "turn_detection", "results", "context"}
    assert len(cfg["context"]["history"]) == 32
    assert all(set(m) == {"role", "text"} for m in cfg["context"]["history"])
    assert len(fishcall.asr_config(hist[:1])["context"]["history"][0]["text"]) == 2000


def test_msgpack_round_trip_keeps_bytes():
    assert unpack(pack({"type": "audio", "data": b"\x00\x01"})) == {"type": "audio", "data": b"\x00\x01"}


# ------------------------------------------------------------ fake sockets

class FakeSock:
    def settimeout(self, t):
        pass


class FakeFish:
    """A Fish client socket: frames scripted by the test, sends recorded."""

    def __init__(self, frames=()):
        self.inbox = queue.Queue()
        for f in frames:
            self.inbox.put(f)
        self.sent = []
        self.closed = False
        self.sock = FakeSock()

    def push(self, ev):
        self.inbox.put((OP_BINARY, pack(ev)))

    def recv(self):
        while True:
            if self.closed:
                raise OSError("closed")
            try:
                return self.inbox.get(timeout=0.05)
            except queue.Empty:
                continue

    def send_bytes(self, b):
        self.sent.append(unpack(b))

    def close(self, code=1000):
        self.closed = True


class FakePhone:
    def __init__(self):
        self.inbox = queue.Queue()
        self.out = []
        self.audio = []

    def recv(self):
        return self.inbox.get(timeout=5)

    def send_text(self, s):
        self.out.append(json.loads(s))

    def send_bytes(self, b):
        self.audio.append(b)

    def close(self):
        pass

    def kinds(self):
        return [m["type"] for m in self.out]


def wait_for(cond, timeout=3):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


def make_bridge(brain, tts_frames=None):
    asr = FakeFish()
    ttses = []

    def dial(url, headers):
        assert headers["Authorization"] == "Bearer k"
        if "asr" in url:
            return asr
        assert headers["model"] == "s2.1-pro-free"
        t = FakeFish(tts_frames or [(OP_BINARY, pack({"event": "audio", "audio": b"PCM"})),
                                    (OP_BINARY, pack({"event": "finish", "reason": "stop"}))])
        ttses.append(t)
        return t

    phone = FakePhone()
    settings = {"key": "k", "asr_url": "wss://x/asr", "tts_url": "wss://x/tts", "tts_model": "s2.1-pro-free"}
    th = threading.Thread(target=fishcall.run_bridge,
                          args=(phone, "sid", None, [], settings),
                          kwargs={"dial": dial, "brain": brain, "speakable": lambda s: s}, daemon=True)
    th.start()
    assert wait_for(lambda: "ready" in phone.kinds())
    return phone, asr, ttses, th


def test_bridge_full_turn_streams_voice_and_commits_history():
    def brain(text, history, runner):
        return {"reply": "hello " + text, "history": history + [{"role": "user", "content": text},
                                                                 {"role": "assistant", "content": "hello " + text}]}
    phone, asr, ttses, th = make_bridge(brain)
    assert asr.sent[0]["type"] == "config"
    phone.inbox.put((OP_BINARY, b"\x01\x02"))
    assert wait_for(lambda: any(m["type"] == "audio" for m in asr.sent))
    asr.push({"type": "eager_end_of_turn", "turn_index": 0, "text": "ram"})
    asr.push({"type": "committed", "turn_index": 0, "text": "ram"})
    assert wait_for(lambda: "audio_end" in phone.kinds())
    assert phone.audio == [b"PCM"]
    assert {"type": "heard", "text": "ram"} in phone.out
    assert {"type": "reply", "text": "hello ram"} in phone.out
    assert [m for m in ttses[0].sent if m["event"] == "text"][0]["text"] == "hello ram"
    assert {"type": "agent_speaking", "speaking": True} in asr.sent
    phone.inbox.put((OP_TEXT, b'{"type":"played"}'))
    assert wait_for(lambda: asr.sent[-1] == {"type": "agent_speaking", "speaking": False})
    phone.inbox.put((OP_TEXT, b'{"type":"stop"}'))
    th.join(2)
    assert not th.is_alive()
    assert asr.closed and {"type": "audio_done"} in asr.sent


def test_bridge_eager_write_tool_waits_for_commit():
    calls = []

    def brain(text, history, runner):
        calls.append(text)
        runner("decide", {}, None) if len(calls) == 1 else None
        return {"reply": "done", "history": history}

    phone, asr, ttses, th = make_bridge(brain)
    asr.push({"type": "eager_end_of_turn", "turn_index": 0, "text": "approve"})
    assert wait_for(lambda: len(calls) == 1)
    time.sleep(0.1)
    assert "reply" not in phone.kinds()                  # no speculative write, nothing said
    asr.push({"type": "committed", "turn_index": 0, "text": "approve"})
    assert wait_for(lambda: "audio_end" in phone.kinds())
    assert calls == ["approve", "approve"]
    phone.inbox.put((OP_CLOSE, b""))
    th.join(2)


def test_eager_runner_allows_reads_and_blocks_writes():
    seen = {}

    def brain(text, history, runner):
        try:
            runner("comment", {}, None)
        except NeedsCommit:
            seen["blocked"] = True
            raise
        return {"reply": "x", "history": history}

    phone, asr, ttses, th = make_bridge(brain)
    asr.push({"type": "eager_end_of_turn", "turn_index": 0, "text": "note"})
    assert wait_for(lambda: seen.get("blocked"))
    phone.inbox.put((OP_CLOSE, b""))
    th.join(2)


def test_bridge_barge_stops_voice():
    gate = threading.Event()

    def brain(text, history, runner):
        return {"reply": "long story", "history": history}

    phone, asr, ttses, th = make_bridge(brain, tts_frames=[(OP_BINARY, pack({"event": "audio", "audio": b"A"}))])
    asr.push({"type": "committed", "turn_index": 0, "text": "story"})
    assert wait_for(lambda: phone.audio == [b"A"])
    asr.push({"type": "user_turn_taken", "turn_index": 1})
    assert wait_for(lambda: "barge" in phone.kinds())
    assert wait_for(lambda: ttses[0].closed)
    time.sleep(0.1)
    assert "audio_end" not in phone.kinds()
    gate.set()
    phone.inbox.put((OP_CLOSE, b""))
    th.join(2)


def test_bridge_reports_unreachable_asr():
    phone = FakePhone()

    def dial(url, headers):
        raise OSError("refused")

    fishcall.run_bridge(phone, "sid", None, [], {"key": "k", "asr_url": "a", "tts_url": "t", "tts_model": "m"},
                        dial=dial, brain=lambda *a: None, speakable=lambda s: s)
    assert phone.kinds() == ["error"]


def test_bridge_start_message_seeds_history():
    seen = []

    def brain(text, history, runner):
        seen.append(list(history))
        return {"reply": "ok", "history": history}

    phone, asr, ttses, th = make_bridge(brain)
    phone.inbox.put((OP_TEXT, json.dumps({"type": "start", "history": [
        {"role": "user", "content": "earlier"}]}).encode()))
    time.sleep(0.1)
    asr.push({"type": "committed", "turn_index": 0, "text": "now"})
    assert wait_for(lambda: "audio_end" in phone.kinds())
    assert seen and seen[0][0] == {"role": "user", "content": "earlier"}
    phone.inbox.put((OP_CLOSE, b""))
    th.join(2)
