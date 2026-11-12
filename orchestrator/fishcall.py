"""Fish Audio realtime call engine: the phone's /api/call/live socket.

One WebSocket from the phone carries the whole call:
  phone -> server  binary PCM16 mono 16 kHz (20-40 ms chunks), and JSON
                   {"type":"start","history":[...]}, {"type":"played"},
                   {"type":"stop"}, {"type":"ping"}
  server -> phone  binary PCM16 mono 24 kHz (the reply's voice), and JSON
                   ready{sample_rate}, heard{text}, reply{text}, audio_end,
                   barge, error{message}, pong

Behind it the server holds two Fish sockets (msgpack frames):
  ASR  wss://api.fish.audio/v1/asr/realtime  — streams the caller's audio and
       decides when they finished a turn (eager_end_of_turn, then committed).
  TTS  wss://api.fish.audio/v1/tts/live      — one socket per reply; closing
       it is how a barge-in stops the voice.
The brain in between is callbrain.call_turn (the board tools), unchanged.

Speed: Fish sends an EAGER end-of-turn before it is sure. The brain starts on
it; when the turn is then committed with the same words, the reply is ready.
If the caller keeps talking (turn_resumed) the speculative answer is dropped.
A speculative turn may only READ (board_status, card_detail): a tool that
writes raises NeedsCommit and the turn is answered again once committed.

TurnTaker is the pure state machine (unit-tested); run_bridge wires sockets
and threads, with the dialer and brain injectable so tests need no network.
"""

import re
import time
import json
import struct
import threading

import msgpack

from orchestrator import wsclient
from orchestrator.wsclient import OP_BINARY, OP_CLOSE, OP_TEXT, WSHandshakeError

PHONE_RATE = 16000          # what the phone sends
VOICE_RATE = 24000          # what TTS sends back
READ_TIMEOUT = 10           # ASR read tick; an idle tick sends keepalive (Fish closes at 30 s idle)
ASR_RECONNECT = 1012        # Fish "service restart": dial again
ACK_LINE = "One sec, checking."
READ_ONLY_TOOLS = frozenset({"board_status", "card_detail"})


def dial_error(e, default):
    """What the phone says when Fish refuses the socket: 402 means the API balance
    (separate from the app subscription) is empty, 401 a bad key, 429 too many calls."""
    status = getattr(e, "status", None) if isinstance(e, WSHandshakeError) else None
    return {402: "The Fish API balance is empty; top it up to use the call.",
            401: "The Fish API key was refused.",
            429: "Fish is busy with too many calls; try again in a moment."}.get(status, default)


def pack(d):
    return msgpack.packb(d, use_bin_type=True)


def unpack(b):
    return msgpack.unpackb(b, raw=False)


class NeedsCommit(Exception):
    """A speculative turn tried a tool that writes; answer it after commit."""


# ------------------------------------------------------------ turn taking

_TAG = re.compile(r"<\|[^|>]*\|>")


def clean_text(raw):
    """ASR text without its <|speaker:0|> style tags (Fish prefixes them)."""
    return _TAG.sub("", raw or "").strip()


class TurnTaker:
    """Decides, from Fish ASR events and brain results, what to do next.

    Every method returns a list of actions:
      ("think", turn, text, eager)  start the brain on `text`
      ("cancel", turn)              drop that turn's speculative answer
      ("speak", turn, reply)        voice `reply`
      ("interrupt",)                the caller started talking: the voice, if any, must stop
      ("heard", text)               show the caller's committed words
    """

    def __init__(self):
        self.current = None       # newest turn index
        self.asked = {}           # turn -> text the brain is answering
        self.replies = {}         # turn -> finished reply awaiting commit
        self.committed = {}       # turn -> committed text

    def on_asr(self, ev):
        kind, turn = ev.get("type"), ev.get("turn_index")
        if kind == "user_turn_taken":
            self.current = turn
            return [("interrupt",)]
        if kind == "eager_end_of_turn":
            text = clean_text(ev.get("text"))
            if not text or turn in self.committed:
                return []
            self.current = turn
            self.asked[turn] = text
            self.replies.pop(turn, None)
            return [("think", turn, text, True)]
        if kind == "turn_resumed":
            self.replies.pop(turn, None)
            if self.asked.pop(turn, None) is None:
                return []
            return [("cancel", turn)]
        if kind == "committed":
            text = clean_text(ev.get("text"))
            if ev.get("user_turn") is False or not text:
                return []
            self.current = turn
            self.committed[turn] = text
            acts = [("heard", text)]
            if self.asked.get(turn) == text:
                if turn in self.replies:
                    acts.append(self._speak(turn))
                return acts
            if turn in self.asked:
                acts.append(("cancel", turn))
            self.asked[turn] = text
            self.replies.pop(turn, None)
            acts.append(("think", turn, text, False))
            return acts
        return []                 # speech_start, user_backchannel, progress, configured ...

    def brain_done(self, turn, text, reply):
        if self.asked.get(turn) != text or turn != self.current:
            return []             # stale: the caller moved on or the words changed
        self.replies[turn] = reply
        if self.committed.get(turn) == text:
            return [self._speak(turn)]
        return []

    def brain_deferred(self, turn, text):
        """The eager answer needed a write; re-run it for real once committed."""
        if self.asked.get(turn) != text:
            return []
        if self.committed.get(turn) == text:
            return [("think", turn, text, False)]
        self.asked.pop(turn, None)  # committed will re-ask
        return []

    def _speak(self, turn):
        reply = self.replies.pop(turn)
        self.asked.pop(turn, None)
        return ("speak", turn, reply)


# ------------------------------------------------------------ Fish sockets

def asr_config(history):
    ctx = [{"role": m["role"], "text": str(m.get("content") or "")[:2000]}
           for m in (history or [])
           if isinstance(m, dict) and m.get("role") in ("user", "assistant") and m.get("content")]
    return {"type": "config",
            "audio": {"format": "pcm_s16le", "sample_rate": PHONE_RATE, "channels": 1},
            "turn_detection": {"mode": "auto", "eager": True},
            "results": {"drafts": False, "tag_audio_events": False},
            "context": {"history": ctx[-32:]}}


def tts_start(voice_id):
    req = {"text": "", "format": "pcm", "sample_rate": VOICE_RATE, "latency": "low"}
    if voice_id:
        req["reference_id"] = voice_id
    return {"event": "start", "request": req}


def close_code(payload):
    return struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005


# ------------------------------------------------------------ the voice

class Voice:
    """The one owner of what the caller hears.

    Every utterance (the "one sec" line and the real answer alike) is one Fish TTS
    socket, played strictly in order. A barge-in bumps `epoch`, which cancels the
    utterance in flight and every one still queued. The phone answers each
    `audio_end` with `played` carrying the same `gen`; a `played` for anything but
    the newest utterance is a stale echo of an earlier one and is ignored, so one
    utterance finishing can never declare the voice over while another is speaking.
    """

    def __init__(self, dial, tell, send_audio, asr_send, speakable, voice_id):
        self.dial, self.tell, self.send_audio = dial, tell, send_audio
        self.asr_send, self.speakable, self.voice_id = asr_send, speakable, voice_id
        self.lock = threading.Lock()     # guards everything below
        self.order = threading.Lock()    # one utterance streams at a time
        self.epoch = 0                   # bumped by every barge
        self.seq = 0                     # utterance counter, echoed back as `gen`
        self.pending = 0                 # queued or streaming this epoch
        self.awaiting = None             # gen the phone has not finished playing yet
        self.announced = False           # Fish ASR was told agent_speaking=True
        self.sock = None

    def _busy(self):
        return self.pending > 0 or self.awaiting is not None

    def _announce(self, speaking):
        if self.announced != speaking:
            self.announced = speaking
            self.asr_send({"type": "agent_speaking", "speaking": speaking})

    def current_epoch(self):
        with self.lock:
            return self.epoch

    def say(self, text, epoch, only_if_idle=False):
        """Voice `text` unless a barge-in has happened since `epoch` was read."""
        with self.lock:
            if epoch != self.epoch or (only_if_idle and self._busy()):
                return
            self.pending += 1
        try:
            with self.order:
                self._stream(text, epoch)
        finally:
            with self.lock:
                if epoch == self.epoch:
                    self.pending -= 1
                    if not self._busy():
                        self._announce(False)

    def played(self, gen):
        """The phone finished playing utterance `gen` (None from builds that predate it)."""
        with self.lock:
            if self.awaiting is None or (gen is not None and gen != self.awaiting):
                return
            self.awaiting = None
            if not self._busy():
                self._announce(False)

    def barge(self):
        """Cut the voice now. True when something was speaking or queued."""
        with self.lock:
            was = self._busy()
            if was:
                self.epoch += 1
                self.pending = 0
                self.awaiting = None
                sock, self.sock = self.sock, None
                if sock is not None:
                    sock.close()
                self._announce(False)
            return was

    def _stream(self, text, epoch):
        with self.lock:
            if epoch != self.epoch:
                return
            self._announce(True)
        self.asr_send({"type": "context_add", "items": [{"role": "assistant", "text": text[:2000]}]})
        try:
            tts = self.dial()
        except Exception as e:
            print(f"[fishcall] tts dial failed: {e}", flush=True)
            self.tell("error", message=dial_error(e, "The voice service is unreachable."))
            return
        with self.lock:
            if epoch != self.epoch:
                tts.close()
                return
            self.sock = tts
        chunks = nbytes = 0
        t0 = time.monotonic()
        first = None
        why = "closed"
        try:
            tts.send_bytes(pack(tts_start(self.voice_id)))
            tts.send_bytes(pack({"event": "text", "text": self.speakable(text)}))
            tts.send_bytes(pack({"event": "flush"}))
            tts.send_bytes(pack({"event": "stop"}))
            while True:
                op, payload = tts.recv()
                if op == OP_CLOSE:
                    break
                if op != OP_BINARY:
                    continue
                ev = unpack(payload)
                if ev.get("event") == "audio" and ev.get("audio"):
                    if first is None:
                        first = time.monotonic() - t0
                    chunks += 1
                    nbytes += len(ev["audio"])
                    self.send_audio(ev["audio"])
                elif ev.get("event") == "finish":
                    why = ev.get("reason") or "stop"
                    break
        except Exception as e:
            why = f"dropped: {e}"     # a barge-in closes the socket too; both end up here
        with self.lock:
            barged = epoch != self.epoch
            if self.sock is tts:
                self.sock = None
            if not barged:
                self.seq += 1
                gen = self.awaiting = self.seq
        tts.close()
        print(f"[fishcall] tts {why}: {chunks} chunks {nbytes} B first={first if first is None else round(first, 2)}s barged={barged}", flush=True)
        if not barged:
            self.tell("audio_end", gen=gen)  # the phone answers "played" once its buffer drains


# ------------------------------------------------------------ the bridge

class Bridge:
    """One live call. `phone` is a server-side socket (recv/send_bytes/
    send_text/close); `dial(url, headers)` opens a Fish client socket;
    `brain(text, history, tool_runner)` returns call_turn's dict."""

    def __init__(self, phone, dial, brain, key, asr_url, tts_url, tts_model, voice_id="",
                 history=None, speakable=lambda s: s):
        self.phone, self.dial, self.brain = phone, dial, brain
        self.key, self.asr_url, self.tts_url = key, asr_url, tts_url
        self.tts_model, self.voice_id, self.speakable = tts_model, voice_id, speakable
        self.history = list(history or [])
        self.turns = TurnTaker()
        self.lock = threading.Lock()     # guards turns and history
        self.asr = None
        self.t0 = time.monotonic()
        self.done = threading.Event()
        self.voice = Voice(
            dial=lambda: dial(tts_url, {"Authorization": "Bearer " + key, "model": tts_model}),
            tell=self.tell, send_audio=phone.send_bytes, asr_send=self._asr_send,
            speakable=speakable, voice_id=voice_id)

    # -- helpers
    def tell(self, kind, **kw):
        try:
            self.phone.send_text(json.dumps({"type": kind, **kw}))
        except Exception:
            self.done.set()

    def _asr_send(self, msg):
        asr = self.asr
        if asr is not None:
            try:
                asr.send_bytes(pack(msg))
            except Exception:
                pass

    def open_asr(self):
        asr = self.dial(self.asr_url, {"Authorization": "Bearer " + self.key})
        asr.sock.settimeout(READ_TIMEOUT)
        asr.send_bytes(pack(asr_config(self.history)))
        self.asr = asr

    # -- actions
    def act(self, actions):
        for a in actions:
            if a[0] == "think":
                threading.Thread(target=self._think, args=a[1:], daemon=True).start()
            elif a[0] == "heard":
                self.tell("heard", text=a[1])
            elif a[0] == "speak":
                args = (a[2], self.voice.current_epoch())
                threading.Thread(target=self._speak, args=args, daemon=True).start()
            elif a[0] == "interrupt":
                if self.voice.barge():
                    self.tell("barge")
            # "cancel": the stale answer is dropped by TurnTaker; nothing to close

    def _ack(self, turn, epoch):
        with self.lock:
            live = self.turns.current == turn
        if live:
            self.voice.say(ACK_LINE, epoch, only_if_idle=True)

    def _think(self, turn, text, eager):
        acked = []
        def runner(name, args, ctx):
            if eager and name not in READ_ONLY_TOOLS:
                raise NeedsCommit(name)
            from orchestrator.callbrain import run_tool
            if not eager and not acked:
                acked.append(1)   # no dead air: say so while the tool runs, keep listening
                threading.Thread(target=self._ack, args=(turn, self.voice.current_epoch()), daemon=True).start()
            return run_tool(name, args, ctx)
        with self.lock:
            history = list(self.history)
        try:
            out = self.brain(text, history, runner)
        except NeedsCommit:
            with self.lock:
                acts = self.turns.brain_deferred(turn, text)
            return self.act(acts)
        except Exception as e:
            print(f"[fishcall] brain failed: {e}", flush=True)
            out = {"reply": "Sorry, I could not think that through. Say it again?", "history": history}
        with self.lock:
            acts = self.turns.brain_done(turn, text, out["reply"])
            if acts:
                self.history = out.get("history") or history
        self.act(acts)

    def _speak(self, reply, epoch):
        self.tell("reply", text=reply)
        self.voice.say(reply, epoch)

    # -- loops
    def asr_loop(self):
        last_keepalive = time.monotonic()
        while not self.done.is_set():
            # Keepalive on the clock, not only on a quiet read: Fish counts client
            # messages, so a stalled phone mic must never let the stream idle out.
            if time.monotonic() - last_keepalive >= READ_TIMEOUT:
                self._asr_send({"type": "keepalive"})
                last_keepalive = time.monotonic()
            try:
                op, payload = self.asr.recv()
            except TimeoutError:
                continue
            except Exception:
                op, payload = OP_CLOSE, b""
            if op == OP_CLOSE:
                if self.done.is_set():
                    return
                if close_code(payload) == ASR_RECONNECT:
                    try:
                        self.open_asr()
                        continue
                    except Exception:
                        pass
                self.tell("error", message="The listening service closed the call.")
                self.done.set()
                return
            if op != OP_BINARY:
                continue
            ev = unpack(payload)
            if ev.get("type") == "error":
                print(f"[fishcall] asr error: {ev.get('message')}", flush=True)
                if not ev.get("recoverable"):
                    self.tell("error", message="The listening service failed.")
                    self.done.set()
                    return
                continue
            if ev.get("type") in ("user_turn_taken", "eager_end_of_turn", "committed", "turn_resumed"):
                # Per-turn timing: the gaps between these lines show where a slow reply is lost.
                print(f"[fishcall] asr {ev.get('type')} turn={ev.get('turn_index')} "
                      f"reason={ev.get('reason')} t={time.monotonic() - self.t0:.2f}s", flush=True)
            with self.lock:
                acts = self.turns.on_asr(ev)
            self.act(acts)

    def run(self):
        try:
            self.open_asr()
        except Exception as e:
            print(f"[fishcall] asr dial failed: {e}", flush=True)
            self.tell("error", message=dial_error(e, "The listening service is unreachable."))
            return
        self.tell("ready", sample_rate=VOICE_RATE)
        reader = threading.Thread(target=self.asr_loop, daemon=True)
        reader.start()
        try:
            while not self.done.is_set():
                op, payload = self.phone.recv()
                if op == OP_CLOSE:
                    break
                if op == OP_BINARY and payload:
                    self.asr.send_bytes(pack({"type": "audio", "data": payload}))
                elif op == OP_TEXT:
                    msg = json.loads(payload.decode("utf-8", "replace") or "{}")
                    kind = msg.get("type") if isinstance(msg, dict) else None
                    if kind == "start":
                        # The phone's call history so far; it feeds the brain's turns
                        # (the ASR context was already sent when the socket opened).
                        hist = msg.get("history")
                        if isinstance(hist, list):
                            with self.lock:
                                self.history = [m for m in hist if isinstance(m, dict)]
                    elif kind == "played":
                        self.voice.played(msg.get("gen"))
                    elif kind == "stop":
                        break
                    elif kind == "ping":
                        self.tell("pong")
        except Exception:
            pass
        finally:
            self.done.set()
            self.voice.barge()
            self._asr_send({"type": "audio_done"})
            if self.asr is not None:
                self.asr.close()


def run_bridge(phone, sid, principal, history, settings, dial=None, brain=None, speakable=None):
    """Serve one phone call. `settings` = {key, asr_url, tts_url, tts_model, voice_id}."""
    if brain is None:
        from orchestrator import callbrain
        def brain(text, hist, runner):
            return callbrain.call_turn(sid, principal, text, hist, tool_runner=runner)
    if speakable is None:
        from orchestrator.speakable import speakable
    dial = dial or (lambda url, headers: wsclient.dial(url, headers=headers))
    Bridge(phone, dial, brain, settings["key"], settings["asr_url"], settings["tts_url"],
           settings["tts_model"], settings.get("voice_id", ""), history, speakable).run()
