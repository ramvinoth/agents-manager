"""Speakrail LFM3 + Breeze as a calllive provider (the second of two, after Fish).

The phone never knows: calllive's Bridge still speaks the Fish-vocabulary events
and the Fish TTS socket contract. This module is the pair of adapters that
translate the GPU box's Speakrail engines into that contract, over the box's
harman-call-bridge (deploy/call_bridge.py), which fronts the box's loopback-only
engines on one LAN port:

  ASR  ws://<box>/v1/transcribe — the LFM3 live-ASR adapter: raw PCM16 16 kHz in,
       transcript deltas (each word carries its audio position in ms) and
       turn-probability frames out; an energy VAD ends turns. The VAD has no
       speaker identity, so SrAsrState (pure, unit-tested) does the translating:
       it drops everything while the agent speaks (the caller's mic picks up the
       speaker's voice and the adapter cannot tell it apart), arms a leak window
       when the agent stops (the model runs ~1 s behind, so its transcript can
       still hold the agent's tail; words are filtered by their own timestamps),
       and emits user_turn_taken / committed — never the eager/speculative
       events Fish has, so calllive's bookkeeping runs in half-duplex: the
       caller waits for the agent to finish, then talks. The one exception is a
       spoken stop command ("okay stop", "pause"): see _stop_command. Free
       barge-in by voice energy needs echo-cancelling on the ASR side, which this
       VAD does not have.
  TTS  POST <box>/v1/audio/speech — Breeze: the Mac sends the text as JSON and
       the bridge turns it into Breeze's streaming multipart request (adding the
       reference voice, which lives on the box) and streams raw 24 kHz int16 PCM
       back. BreezeTtsSocket implements the Fish TTS socket contract so
       calllive's Voice needs no change: the `stop` event fires the request, the
       stream becomes `audio`/`finish` events, and closing the socket is exactly
       the barge-in kill (closing the response makes the Breeze server drop the
       request). Stdlib only: the viewer venv has no third-party HTTP client.

`dial(url, headers)` is the default dialer for run_bridge: a ws:// URL becomes
an ASR socket, an http(s):// URL a TTS socket.
"""

import json
import queue
import random
import re
import threading
import time

from orchestrator.calllive import OP_BINARY, OP_CLOSE, OP_TEXT, pack, unpack

LEAK_MARGIN_MS = 300   # speaker ring-out + AEC tail after the agent stops
LATCH_FRAMES = 5       # 5 x 80 ms of continuous speech settles the leak with no VAD boundary
# Spoken stop commands that cut the agent off mid-speech. The ASR keeps hearing the
# caller while the agent talks, but the VAD cannot tell voices apart, so only a
# transcript event made ENTIRELY of these words counts: short, whole-utterance, and
# not something a sentence of the agent's own would produce.
STOP_WORDS = frozenset("okay ok stop pause wait hold on please hang a second minute sorry enough shut up".split())
STOP_TRIGGERS = frozenset("stop pause wait hold enough".split())
STOP_MAX_WORDS = 4
REPLY_WAIT_S = 30.0   # how long after a committed turn a spoken stop still cancels the pending reply
# The adapter does not know when a word was spoken: it spreads each delta's words
# evenly from the previous delta's end to now. After a pause that puts the first
# word back in the pause (even before the agent stopped), so the leak filter ate
# it. A word really ends at most one 960 ms model chunk plus one held-back word
# before the delta that carries it, so older positions are clamped to that.
WORD_LAG_MS = 2 * 960

_SPEECH = [0.95, 0.01, 0.02, 0.01, 0.01, 0.02, 0.02, 0.02]
_COMPLETE = [0.01, 0.97, 0.01, 0.0, 0.01, 0.9, 0.9, 0.9]
_TRANS = [0.3, 0.2, 0.48, 0.01, 0.01, 0.3, 0.3, 0.3]


def classify(p):
    """A turn-probability frame from the adapter: "speech", "complete" or "transient".

    The adapter (our own code) sends exactly the three patterns; the test is on
    which slots carry the mass, so a future tweak to the numbers still classifies.
    Unknown shapes read as a boundary, never as speech — a false "complete" ends
    a real turn, a false "speech" cannot open one it should not open."""
    if not p or len(p) != 8:
        return "transient"
    if p[0] >= 0.9:
        return "speech"
    if p[1] >= 0.9 and p[5] >= 0.9:
        return "complete"
    return "transient"


class SrAsrState:
    """Speakrail LFM3-ASR adapter events -> the Fish-vocabulary events calllive wants.

    The two halves:
      while the agent speaks  — everything is dropped: the caller's mic carries
        the speaker's voice and the VAD cannot tell it from the caller, so any
        turn opened here would be the agent's own words;
      when the agent stops    — a leak window opens: the model is ~1 s behind,
        so transcript words keep arriving for the agent's tail. Words carry
        their audio position (the same clock as the turn frames), so anything
        that ends before the agent's voice has left the mic (stop + margin) is
        the agent and is dropped; the window "settles" on a VAD boundary
        (transient/complete frame) or after LATCH_FRAMES of continuous speech.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.agent = False
        self.leak_until_ms = 0      # word.end < this = the agent's voice
        self.leak_pending = False   # agent just stopped; the next frame arms the window
        self.leak_settled = True    # no agent has spoken yet, so nothing to wait for
        self.speech_run = 0
        self.turn = 0               # last turn index opened
        self.utter = None           # turn index of the open utterance
        self.buf = []               # that utterance's transcript words
        self.stopped = False        # a spoken stop already cut this agent utterance
        self.reply_due = 0.0        # monotonic deadline: a committed turn is awaiting its spoken reply

    def set_agent_speaking(self, speaking):
        with self.lock:
            if speaking == self.agent:
                return
            self.reply_due = 0.0    # the reply arrived (or the agent finished): nothing is waiting
            if speaking:
                self.agent = True
                self.stopped = False
                self.speech_run = 0
                self.utter = None   # an in-flight user utterance is now the agent's echo: dead
                self.buf = []
            else:
                self.agent = False
                self.leak_settled = False
                self.leak_pending = True

    def _open(self):
        self.turn += 1
        self.utter = self.turn
        self.buf = []
        return [{"type": "user_turn_taken", "turn_index": self.turn}]

    def on_frame(self, t_ms, p):
        """One turn-probability frame (t_ms = audio position, the VAD's clock)."""
        with self.lock:
            if self.agent:
                self.speech_run = 0
                return []
            if self.leak_pending:
                self.leak_until_ms = t_ms + LEAK_MARGIN_MS
                self.leak_pending = False
            kind = classify(p)
            if kind != "speech":
                self.speech_run = 0
                if not self.leak_settled:
                    self.leak_settled = True   # a quiet boundary: the tail is over
                if kind == "complete":
                    return self._finish_locked()
                return []
            self.speech_run += 1
            if not self.leak_settled:
                if self.speech_run < LATCH_FRAMES:
                    return []                 # continuous speech: settle after the ring-out
                self.leak_settled = True
            if self.utter is None:
                return self._open()
            return []

    def on_words(self, words):
        """One transcript event's words, each {text, start, end} in the audio clock."""
        with self.lock:
            if self.agent:
                return self._stop_command(words)
            if self._reply_pending():
                said = [{"text": t} for t in self.buf] + [w for w in (words or []) if isinstance(w, dict)]
                acts = self._stop_command(said)
                if acts:
                    return acts           # the reply was queued or thinking: cancel it
            if not self.leak_settled:
                return []                     # the model's tail of the agent's voice
            words = [w for w in (words or []) if isinstance(w, dict) and w.get("text")]
            floor = max((w.get("end", 0) for w in words), default=0) - WORD_LAG_MS
            keep = [w["text"] for w in words if max(w.get("end", 0), floor) >= self.leak_until_ms]
            if not keep:
                return []                     # an all-tail event never opens a turn
            acts = []
            if self.utter is None:
                acts = self._open()           # a quiet onset under the VAD floor: open late
            self.buf.extend(keep)
            return acts

    def _reply_pending(self):
        return time.monotonic() < self.reply_due

    def _stop_command(self, words):
        """While the agent speaks: a spoken "stop"/"pause" barges in. Emits a bare
        user_turn_taken (calllive cuts the voice) and never a committed turn, so the
        command itself gets no reply. Once per agent utterance."""
        toks = [t for t in (re.sub(r"[^a-z]", "", str(w.get("text", "")).lower())
                            for w in (words or []) if isinstance(w, dict)) if t]
        if (not toks or len(toks) > STOP_MAX_WORDS or self.stopped
                or not all(t in STOP_WORDS for t in toks)
                or not any(t in STOP_TRIGGERS for t in toks)):
            return []
        self.stopped = True
        self.reply_due = 0.0
        acts = self._open()
        self.utter = None             # the command is not a turn: nothing to commit
        return acts

    def finish(self):
        """The adapter session ended: commit whatever is in flight. A VAD
        "complete" frame is what normally closes a turn, but the session can
        end mid-utterance (input_audio.end right after continuous speech) —
        without this the caller's last words would never reach the brain."""
        with self.lock:
            return self._finish_locked()

    def _finish_locked(self):
        acts = []
        if self.utter is not None:
            turn, self.utter = self.utter, None
            text = " ".join(self.buf).strip()
            self.buf = []
            if text:
                acts.append({"type": "committed", "turn_index": turn, "text": text, "user_turn": True})
                self.stopped = False
                self.reply_due = time.monotonic() + REPLY_WAIT_S
        return acts


_DITHER = (b"\x01\x00", b"\xff\xff")   # +1 / -1 as little-endian int16


def dither_silence(pcm):
    """Replace every exact-zero PCM16 sample with a random +-1 LSB.

    LFM3's live ASR goes deaf after a stretch of pure digital silence (the
    log-mel of zero power is far outside its training data) and hears nothing
    again until its 24 s context reset; any noise at all keeps it listening.
    The phone's echo canceller hands us exact zeros whenever it suppresses the
    speaker or the room is quiet, which clipped the first and last words of
    the next utterance. One LSB is -90 dBFS: inaudible, far under the
    adapter's VAD floor, and real speech samples are left untouched.
    """
    if b"\x00\x00" not in pcm:
        return pcm
    out = bytearray(pcm)
    pick = random.getrandbits
    for i in range(0, len(out) - 1, 2):
        if not out[i] and not out[i + 1]:
            out[i:i + 2] = _DITHER[pick(1)]
    return bytes(out)


class SpeakrailAsrSocket:
    """A Fish-protocol ASR socket over the LFM3 adapter's websocket.

    send_bytes() takes calllive's msgpack frames and translates them to the
    adapter's wire (raw PCM frames in, input_audio.end to end the session);
    recv() returns Fish-vocabulary events as (OP_BINARY, msgpack), normalised
    through SrAsrState. The adapter's own messages (session.created, turn
    frames, transcript deltas, session.ended) are consumed here and never reach
    the Bridge. A socket timeout inside the adapter connection propagates, so
    calllive's keepalive tick keeps working.
    """

    def __init__(self, conn):
        self.conn = conn
        self.sock = conn.sock
        self.state = SrAsrState()
        self.events = queue.Queue()   # normalised events ahead of the socket
        self.done = False

    def send_bytes(self, b):
        ev = unpack(b)
        t = ev.get("type")
        if t == "audio":
            self.conn.send_bytes(dither_silence(ev.get("data") or b""))
        elif t == "agent_speaking":
            self.state.set_agent_speaking(bool(ev.get("speaking")))
        elif t == "audio_done":
            try:
                self.conn.send_text(json.dumps({"type": "input_audio.end"}))
            except Exception:
                pass
        # config (the adapter session is already open; it has no context API),
        # keepalive and context_add: nothing for this engine to do.

    def recv(self):
        while True:
            if self.events.qsize():
                return OP_BINARY, pack(self.events.get())
            op, payload = self.conn.recv()
            if op == OP_CLOSE:
                self.done = True
                return OP_CLOSE, payload
            if op != OP_TEXT:        # the adapter sends JSON text only; no binary frames
                continue
            try:
                m = json.loads(payload)
            except ValueError:
                continue
            for ev in (self.state.on_frame(m["t"], m["p"]) if m.get("type") == "turn"
                       else self.state.on_words(m.get("words")) if m.get("type") == "transcript"
                       else []):
                self.events.put(ev)
            if m.get("type") == "session.ended":
                for ev in self.state.finish():
                    self.events.put(ev)
                self.done = True

    def close(self):
        try:
            self.conn.close()
        except Exception:
            pass


class _NullSock:
    def settimeout(self, t):
        pass


class BreezeTtsSocket:
    """A Fish-protocol TTS socket over Breeze's streaming HTTP API.

    The Fish TTS contract: send start, then text, then flush, then stop, then
    read audio/finish events; close() kills the utterance in flight. Here one
    POST per utterance does it: the `stop` event fires the request (the `flush`
    already did, so `stop` is a no-op once sent), the streamed response becomes
    `audio` events (int16 samples kept whole across arbitrary chunk boundaries),
    and close() closes the response, which makes the Breeze server abort the
    generation — the barge-in. A 409 means the request we just killed is still
    releasing; we wait it out like the Speakrail harness does.
    """

    def __init__(self, url, token=""):
        self.url = url
        self.token = token
        self.sock = _NullSock()
        self.text = ""
        self.resp = None
        self.odd = b""            # an int16 sample split across two HTTP chunks
        self.fired = False
        self.done = False

    def _fire(self):
        import urllib.error
        import urllib.request
        if not self.text.strip():
            return
        body = json.dumps({"text": self.text}).encode()
        req = urllib.request.Request(
            self.url, data=body, method="POST",
            headers={"Authorization": "Bearer " + self.token,
                     "Content-Type": "application/json",
                     # urllib's default UA (Python-urllib/x) is a Cloudflare WAF
                     # 1010 on the tunnel edge; a plain custom UA passes.
                     "User-Agent": "HarmanCall/1.0"})
        resp = None
        for _ in range(75):        # 409 = a request we just killed is still releasing (~20-50 ms)
            try:
                resp = urllib.request.urlopen(req, timeout=30)
                break
            except urllib.error.HTTPError as e:
                if e.code != 409:
                    raise
                e.close()
                time.sleep(0.02)
        if resp is None:          # still 409 after 1.5 s: the bridge never freed it
            return
        self.resp = resp

    def send_bytes(self, b):
        ev = unpack(b)
        e = ev.get("event")
        if e == "start":
            self.text = ""
        elif e == "text":
            self.text += ev.get("text") or ""
        elif e in ("flush", "stop"):
            if not self.fired:
                self.fired = True
                self._fire()

    def recv(self):
        if self.done or self.resp is None:
            return OP_CLOSE, b""
        while True:
            try:
                chunk = self.resp.read(4096)
            except Exception as e:
                deliberate = self.resp is None      # close() ran: a barge-in, not a failure
                self.done = True
                self.close()
                if not deliberate:
                    print(f"[speakrailcall] tts stream broke: {type(e).__name__}", flush=True)
                return OP_CLOSE, b""
            if not chunk:
                self.done = True
                self.close()
                return OP_BINARY, pack({"event": "finish", "reason": "stop"})
            pcm = self.odd + chunk
            if len(pcm) & 1:       # an int16 sample split across two HTTP chunks
                self.odd = pcm[-1:]
                pcm = pcm[:-1]
            else:
                self.odd = b""
            if pcm:
                return OP_BINARY, pack({"event": "audio", "audio": pcm})

    def close(self):
        r, self.resp = self.resp, None
        if r is not None:
            try:
                r.close()
            except Exception:
                pass
        self.done = True


def dial(url, headers=None):
    """calllive's dialer for the speakrail provider: ws:// -> ASR socket, http(s):// -> TTS."""
    headers = headers or {}
    if url.startswith("ws"):
        from orchestrator import wsclient
        return SpeakrailAsrSocket(wsclient.dial(url, headers=headers))
    token = (headers.get("Authorization") or "")
    if token.startswith("Bearer "):
        token = token[7:]
    return BreezeTtsSocket(url, token=token)
