"""Harman LFM3 voice service: LiquidAI LFM3-Audio-2B as the call's voice.

Text in (the caller's transcript), native speech + tool calls out. Every generate
runs on ONE worker thread (the compiled depth decoder uses CUDA graphs, which are
per-thread); audio streams while the model is still talking.

  GET  /health                 -> {ok, busy}
  POST /generate {messages, tools}
       -> {id, audio: true}                      first audio frame is ready
       -> {id, audio: false, text, tool_calls}   finished without speaking
  GET  /audio/<id>   live ADTS AAC (24 kHz mono) of that turn's speech
  GET  /result/<id>  blocks until the turn ends -> {text, tool_calls}
  POST /cancel/<id>  the caller barged in: stop generating now; /result then holds
                     the words said so far

The caller runs the tools and posts the next round as a fresh /generate.
Env: HARMAN_LFM3_HOST (0.0.0.0, like the speech services), HARMAN_LFM3_PORT (8098), HARMAN_LFM3_MODEL.
"""
import json, os, queue, re, subprocess, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForMultimodalLM, AutoProcessor

MODEL_ID = os.environ.get("HARMAN_LFM3_MODEL", "LiquidAI/LFM3-Audio-2B")
HOST = os.environ.get("HARMAN_LFM3_HOST", "0.0.0.0")
PORT = int(os.environ.get("HARMAN_LFM3_PORT", "8098"))
RATE = 24000
DECODE_EVERY = 3          # frames per codec chunk (3 frames = 240 ms of audio)
TURN_TTL = 300            # seconds a finished turn is kept for /audio and /result
MODE_LINE = "Respond with function calls, and interleaved text and audio."

CALL_RE = re.compile(r"<tool_call>\s*<function=([^>\n]+)>(.*?)</function>\s*</tool_call>", re.DOTALL)
PARAM_RE = re.compile(r"<parameter=([^>\n]+)>\n?(.*?)\n?</parameter>", re.DOTALL)


def parse_tool_calls(text):
    calls = []
    for name, body in CALL_RE.findall(text):
        args = {}
        for k, v in PARAM_RE.findall(body):
            try:
                args[k.strip()] = json.loads(v)
            except json.JSONDecodeError:
                args[k.strip()] = v
        calls.append({"type": "function", "function": {"name": name.strip(), "arguments": args}})
    return calls


def spoken_text(text):
    """The words of the reply, without tool-call markup."""
    return CALL_RE.sub("", text).strip()


# ---- model -------------------------------------------------------------------
device = "cuda"
model = AutoModelForMultimodalLM.from_pretrained(MODEL_ID, dtype=torch.bfloat16, device_map=device,
                                                 trust_remote_code=True).eval()
processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
codec = processor.audio_tokenizer.to(device=device).eval()
CacheCls = __import__(type(codec).__module__, fromlist=["LiquidCodecStreamingCache"]).LiquidCodecStreamingCache


def _fast_sample_audio_frame(self, hidden_state, temperature=None, top_k=None, repetition_penalty=None,
                             history=None, warpers=None):
    """The upstream maskgit sampler, batched per reveal step (same distribution, ~2x faster)."""
    single = hidden_state.ndim == 1
    if single:
        hidden_state, history = hidden_state[None], [history]
    B = hidden_state.shape[0]
    history = history if history is not None else [None] * B
    if warpers is None:
        warpers = self._build_warpers(temperature, top_k, None, None)
    n = self.config.num_codebooks
    codes = hidden_state.new_zeros((B, n), dtype=torch.long)
    revealed = torch.zeros_like(codes, dtype=torch.bool)
    order = torch.stack([torch.randperm(n, device=hidden_state.device) for _ in range(B)])
    for pick in order.split(self.config.maskgit_schedule, dim=1):
        logits = self.model.depth_decoder(hidden_state, codes, ~revealed)
        for row in range(B):
            sc = logits[row].index_select(0, pick[row]).float()
            h = history[row]
            if repetition_penalty not in (None, 1.0) and h is not None and h.numel():
                hh = h[:, pick[row]].T.to(sc.device)
                g = sc.gather(1, hh)
                sc = sc.scatter(1, hh, torch.where(g < 0, g * repetition_penalty, g / repetition_penalty))
            for w in warpers:
                sc = w(None, sc)
            s = torch.multinomial(sc.softmax(-1), 1)[:, 0] if warpers else sc.argmax(-1)
            codes[row].scatter_(0, pick[row], s.to(codes.dtype))
        revealed.scatter_(1, pick, True)
    return codes[0] if single else codes


type(model).sample_audio_frame = _fast_sample_audio_frame
dd = model.model.depth_decoder
dd.forward = torch.compile(dd.forward, mode="reduce-overhead", dynamic=False)
JOBS = queue.Queue()   # (messages, tools, turn) for the one GPU worker
BUSY = threading.Event()


# ---- one turn ----------------------------------------------------------------
class Turn:
    def __init__(self):
        self.id = uuid.uuid4().hex
        self.pcm = queue.Queue()          # float32 numpy chunks, then None
        self.started = threading.Event()  # first audio chunk, or finished
        self.done = threading.Event()
        self.has_audio = False
        self.text, self.error = "", None
        self.finished_at = None
        self.cancel = threading.Event()


class Cancelled(Exception):
    pass


class TextFirst(Exception):
    """The reply opened with plain text: the model chose to write, not speak."""


class TextStream:
    """streamer: keeps the text tokens as they are sampled, so a cancelled turn still
    knows what it said, and stops generation between tokens when the turn is cancelled
    (the model's generate takes no stopping_criteria; a raising streamer is the hook)."""
    def __init__(self, turn, gate=False):
        self.turn, self.ids, self.prompt_seen, self.gate = turn, [], False, gate

    def put(self, value):
        if self.turn.cancel.is_set():
            raise Cancelled()
        if not self.prompt_seen:   # the first put is the prompt, then one per sampled token
            self.prompt_seen = True
            return
        self.ids += value.reshape(-1).tolist()
        # Verified on the box: with tools in the prompt the model often answers in
        # plain text even under MODE_LINE. A call must be spoken, so a reply that
        # does not open with a tool call or speech is stopped at its first token.
        if self.gate and len(self.ids) == 1 and self.ids[0] not in SPOKEN_OR_TOOL:
            raise TextFirst()

    def end(self):
        pass


class AudioStream:
    """audio_streamer: gets one (n_q,) code frame per spoken frame; decodes every
    few frames with a streaming codec cache and queues the PCM."""
    def __init__(self, turn):
        self.turn, self.frames, self.cache, self.closed = turn, [], CacheCls(codec.config), False

    def _decode(self, final):
        if not self.frames and not (final and self.cache.started):
            return
        n_q = codec.config.n_q
        codes = (torch.stack(self.frames, dim=-1)[None] if self.frames
                 else torch.zeros((1, n_q, 0), dtype=torch.long, device=device))
        self.frames = []
        with torch.no_grad():
            wav = codec.decode(codes.to(device), streaming_cache=self.cache, finalize=final).audio_values
        if wav.numel():
            self.turn.pcm.put(wav[0].float().cpu().numpy())
            if not self.turn.has_audio:
                self.turn.has_audio = True
                self.turn.started.set()

    def put(self, codes):
        if self.turn.cancel.is_set():
            raise Cancelled()
        self.frames.append(codes.reshape(-1).long())
        if len(self.frames) >= DECODE_EVERY:
            self._decode(final=False)

    def end(self):
        if not self.closed:
            self.closed = True
            self._decode(final=True)


SPOKEN_OR_TOOL = {processor.tokenizer.convert_tokens_to_ids(t)
                  for t in ("<tool_call>", "<|mixed_start|>", "<|audio_start|>")}


def _run(inputs, turn, mode):
    """One generate pass. mode None = the model picks (tool call or speech, gated);
    "interleaved" = forced speech, the rerun after a text-first opening."""
    stream, text = AudioStream(turn), TextStream(turn, gate=mode is None)
    try:
        with torch.no_grad():
            out = model.generate(**inputs, max_new_tokens=1024, return_dict_in_generate=True,
                                 generation_mode=mode,
                                 audio_temperature=1.0, audio_top_k=128, audio_repetition_penalty=1.1,
                                 audio_repetition_window=4096, audio_streamer=stream, streamer=text)
            stream.end()
    except Cancelled:
        raise Cancelled(processor.decode(text.ids, skip_special_tokens=True))
    return out


def generate(messages, tools, turn=None):
    turn = turn or Turn()
    inputs = processor.apply_chat_template(messages, tools=tools or None, add_generation_prompt=True,
                                           tokenize=True, return_dict=True, return_tensors="pt").to(device)
    try:
        try:
            out = _run(inputs, turn, None)
        except TextFirst:
            out = _run(inputs, turn, "interleaved")
        turn.text = processor.decode(out.sequences[0, inputs["input_ids"].shape[1]:], skip_special_tokens=True)
    except Cancelled as c:
        turn.text = c.args[0] if c.args else ""
    except Exception as e:
        turn.error = f"{type(e).__name__}: {e}"
    finally:
        turn.pcm.put(None)
        turn.finished_at = time.time()
        turn.done.set()
        turn.started.set()
    return turn


TURNS = {}
TURNS_LOCK = threading.Lock()


def _reap():
    now = time.time()
    with TURNS_LOCK:
        for k in [k for k, t in TURNS.items() if t.finished_at and now - t.finished_at > TURN_TTL]:
            TURNS.pop(k, None)


def _result(t):
    return {"id": t.id, "text": spoken_text(t.text), "tool_calls": parse_tool_calls(t.text), "error": t.error}


# ---- http --------------------------------------------------------------------
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"   # a close-delimited stream ends /audio

    def log_message(self, fmt, *a):
        pass

    def _json(self, obj, status=200):
        b = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _turn(self, prefix):
        with TURNS_LOCK:
            return TURNS.get(self.path[len(prefix):].split("?")[0])

    def do_GET(self):
        if self.path == "/health":
            return self._json({"ok": True, "busy": BUSY.is_set() or not JOBS.empty(), "model": MODEL_ID})
        if self.path.startswith("/result/"):
            t = self._turn("/result/")
            if not t:
                return self._json({"error": "unknown turn"}, 404)
            t.done.wait(120)
            return self._json(_result(t), 200 if t.done.is_set() else 504)
        if self.path.startswith("/audio/"):
            t = self._turn("/audio/")
            if not t:
                return self._json({"error": "unknown turn"}, 404)
            return self._audio(t)
        self._json({"error": "not found"}, 404)

    def _audio(self, t):
        ff = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", str(RATE),
                               "-ac", "1", "-i", "pipe:0", "-c:a", "aac", "-b:a", "96k", "-f", "adts", "pipe:1"],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE)

        def feed():
            try:
                while True:
                    chunk = t.pcm.get()
                    if chunk is None:
                        break
                    ff.stdin.write(chunk.tobytes())
                    ff.stdin.flush()
            except (BrokenPipeError, OSError):
                pass
            finally:
                try:
                    ff.stdin.close()
                except OSError:
                    pass

        threading.Thread(target=feed, daemon=True).start()
        self.send_response(200)
        self.send_header("Content-Type", "audio/aac")
        self.end_headers()
        try:
            while True:
                data = ff.stdout.read1(4096)
                if not data:
                    break
                self.wfile.write(data)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            ff.kill()

    def do_POST(self):
        if self.path.startswith("/cancel/"):
            t = self._turn("/cancel/")
            if not t:
                return self._json({"error": "unknown turn"}, 404)
            t.cancel.set()
            return self._json({"id": t.id, "cancelled": True})
        if self.path != "/generate":
            return self._json({"error": "not found"}, 404)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "bad json"}, 400)
        messages = body.get("messages") or []
        if not messages or messages[0].get("role") != "system":
            return self._json({"error": "messages must start with a system message"}, 400)
        if not str(messages[0].get("content", "")).startswith(MODE_LINE):
            messages[0] = {"role": "system", "content": MODE_LINE + "\n\n" + str(messages[0].get("content", ""))}
        _reap()
        t = Turn()
        with TURNS_LOCK:
            TURNS[t.id] = t
        JOBS.put((messages, body.get("tools"), t))
        t.started.wait(90)
        if t.has_audio:
            return self._json({"id": t.id, "audio": True})
        t.done.wait(60)
        if t.error:
            return self._json({"id": t.id, "error": t.error}, 500)
        return self._json({**_result(t), "audio": False, "done": True})


def worker():
    """The only thread that touches the GPU: warm up, then serve JOBS in order."""
    warm()
    while True:
        messages, tools, turn = JOBS.get()
        if turn.cancel.is_set():   # barged in before it reached the GPU
            turn.pcm.put(None)
            turn.finished_at = time.time()
            turn.done.set()
            turn.started.set()
            continue
        BUSY.set()
        try:
            generate(messages, tools, turn)
        finally:
            BUSY.clear()


def warm():
    sysmsg = [{"role": "system", "content": MODE_LINE + "\n\nYou are a helpful assistant."},
              {"role": "user", "content": "Say hello in one short sentence."}]
    for _ in range(2):
        t = generate(sysmsg, None)
        while t.pcm.get() is not None:
            pass
    print(f"[lfm3] warm on :{PORT}", flush=True)


if __name__ == "__main__":
    threading.Thread(target=worker, daemon=True).start()
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
