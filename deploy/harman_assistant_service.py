#!/usr/bin/env python3
"""
Harman assistant voice service — the hands-free tool-capable assistant brain.

Given a user utterance (already transcribed + wake/verify-gated upstream by the
:8095 speech service), this service:

  1. Routes the request:
       - action/agentic intent (time, weather, "run", "list", ...) OR anything
         when in doubt -> Qwen-27B agent (:8081) with a small real tool set
         (get_current_time, get_weather). Qwen decides + we execute the tool +
         Qwen phrases the final spoken answer.
       - trivial chit-chat -> a quick Qwen conversational reply (no tools).
  2. Speaks the answer in the assistant's cloned voice via Step-Audio 2 vLLM (:8000)
     TTS mode + token2wav(prompt_wav=assistant.wav), streamed out as ADTS-AAC so
     the mobile player starts almost immediately (same contract as Pocket's
     /synthesize_stream_aac, so the app's streaming path is unchanged).

Endpoints (mirror pocket_service so the viewer can proxy either):
  POST /synthesize_stream_aac : {"text": <user utterance>} -> audio/aac (assistant voice)
  POST /reply                 : {"text": <user utterance>} -> {"text","routed"}
                                (text-only, for debugging the brain)
  GET  /health                : {"ok", "voice", "step", "qwen"}

Env:
  HARMAN_ASSISTANT_PORT   (default 8099)
  HARMAN_STEP_URL      (default http://127.0.0.1:8000/v1/chat/completions)
  HARMAN_QWEN_URL      (default http://100.115.120.89:8081/v1/chat/completions)
  HARMAN_QWEN_KEY      (default sk-llama-suhai-2026)
  HARMAN_ASSISTANT_VOICE    (default <model>/voices/assistant.wav)
  HARMAN_ASSISTANT_DEVICE (default cuda:0 for token2wav)
"""
import io
import json
import os
import re
import struct
import subprocess
import threading
import urllib.request
import wave
from datetime import datetime

import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

# --- config ---------------------------------------------------------------
PORT = int(os.environ.get("HARMAN_ASSISTANT_PORT", "8099"))
STEP_URL = os.environ.get("HARMAN_STEP_URL", "http://127.0.0.1:8000/v1/chat/completions")
STEP_MODEL = os.environ.get("HARMAN_STEP_MODEL", "step-audio-2-mini")
QWEN_URL = os.environ.get("HARMAN_QWEN_URL", "http://100.115.120.89:8081/v1/chat/completions")
QWEN_KEY = os.environ.get("HARMAN_QWEN_KEY", "sk-llama-suhai-2026")
MODEL_DIR = os.environ.get("HARMAN_STEP_MODEL_DIR",
                           "/home/suhai/Documents/vllm-models/step-audio-2-mini")
VOICE_WAV = os.environ.get("HARMAN_ASSISTANT_VOICE", MODEL_DIR + "/voices/assistant.wav")
DEVICE = os.environ.get("HARMAN_ASSISTANT_DEVICE", "cuda:0")

# TTS backend for speaking Qwen's answer. Step-Audio's token2wav is ~3.4s/turn on
# this GPU; Pocket TTS (same cloned "george" voice, same /synthesize_stream_aac
# contract) is ~0.8s — ~4x faster. Since Qwen is the brain (Step-Audio was only the
# mouth, and its own tool-calling was unreliable anyway), we speak via Pocket and
# skip Step-Audio + token2wav entirely. Set HARMAN_ASSISTANT_TTS=step to force the
# old path.
POCKET_URL = os.environ.get("HARMAN_POCKET_URL", "http://127.0.0.1:8097/synthesize_stream_aac")
TTS_BACKEND = os.environ.get("HARMAN_ASSISTANT_TTS", "pocket").strip().lower()

SYSTEM = ("You are Harman, a warm, concise voice assistant on a phone call. "
          "Answer in ONE short spoken sentence — 15 words or fewer — in natural "
          "spoken English, no markdown, no lists, no preamble. Get straight to the "
          "answer; the person can always ask a follow-up. Use tools for time or weather.")

# Route to the Qwen tool-agent when the utterance smells like an action/fact
# request; otherwise a plain conversational reply. "When in doubt -> agent."
_ACTION_RE = re.compile(
    r"\b(time|clock|date|day|today|weather|temperature|forecast|rain|hot|cold|"
    r"run|list|open|show|find|search|remind|schedule|set|turn|play|call|send|"
    r"what('| i)s|whats|how many|how much|when|where|who|which)\b", re.I)

app = FastAPI()

# --- token2wav (assistant voice) — the only local GPU piece ------------------
import sys
sys.path.insert(0, "/home/suhai/Documents/Step-Audio2")
_t2w = None
try:
    import torch  # noqa: F401
    from token2wav import Token2wav
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", DEVICE.split(":")[-1])
    _t2w = Token2wav(MODEL_DIR + "/token2wav")
    print(f"[assistant] token2wav loaded, ref={VOICE_WAV}", flush=True)
except Exception as e:  # pragma: no cover
    print(f"[assistant] token2wav load failed: {e}", flush=True)
    _t2w = None

_AUDIO_TOK_RE = re.compile(r"<audio_(\d+)>")
_SR = 24000  # token2wav output rate


# --- helpers --------------------------------------------------------------
def _post_json(url, payload, key=None, timeout=120):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "harman-assistant/1.0")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


# --- the tools Qwen can actually call -------------------------------------
def _tool_get_current_time(_args):
    return datetime.now().strftime("It is %-I:%M %p on %A, %B %-d.")


def _tool_get_weather(args):
    city = (args or {}).get("city", "your area")
    # Placeholder: no live weather feed wired yet. Honest stub so the loop works;
    # swap for a real API later.
    return f"I don't have a live weather feed yet for {city}."


_TOOLS_SPEC = [
    {"type": "function", "function": {
        "name": "get_current_time",
        "description": "Get the current local time and date.",
        "parameters": {"type": "object", "properties": {}, "required": []}}},
    {"type": "function", "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {"type": "object", "properties": {
            "city": {"type": "string", "description": "City name"}},
            "required": ["city"]}}},
]
_TOOL_FNS = {"get_current_time": _tool_get_current_time, "get_weather": _tool_get_weather}


def _qwen_answer(utterance, use_tools):
    """Run one Qwen turn; if it calls a tool, execute it and let Qwen phrase the
    final spoken answer. Returns the final text."""
    messages = [{"role": "system", "content": SYSTEM},
                {"role": "user", "content": utterance}]
    # Qwen is a thinking model; for short spoken replies we disable the internal
    # monologue (else it burns the whole token budget on reasoning_content and
    # returns empty content).
    payload = {"messages": messages, "max_tokens": 80, "temperature": 0.4,
               "chat_template_kwargs": {"enable_thinking": False}}
    if use_tools:
        payload["tools"] = _TOOLS_SPEC
        payload["tool_choice"] = "auto"
    data = _post_json(QWEN_URL, payload, key=QWEN_KEY)
    msg = data["choices"][0]["message"]
    calls = msg.get("tool_calls") or []
    if not calls:
        return (msg.get("content") or "").strip() or "Sorry, I didn't catch that."
    # Execute tools, feed results back for a natural phrasing.
    messages.append({"role": "assistant", "content": msg.get("content") or "",
                     "tool_calls": calls})
    for c in calls:
        fn = c.get("function", {})
        name = fn.get("name")
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except Exception:
            args = {}
        result = _TOOL_FNS.get(name, lambda a: "Unknown tool.")(args)
        messages.append({"role": "tool", "tool_call_id": c.get("id", name),
                         "name": name, "content": result})
    data2 = _post_json(QWEN_URL, {"messages": messages, "max_tokens": 80,
                                  "temperature": 0.4,
                                  "chat_template_kwargs": {"enable_thinking": False}},
                       key=QWEN_KEY)
    return (data2["choices"][0]["message"].get("content") or "").strip() \
        or "Done."


def brain(utterance):
    """Route + answer. Returns (text, routed_label)."""
    utterance = (utterance or "").strip()
    if not utterance:
        return "I'm listening.", "empty"
    use_tools = bool(_ACTION_RE.search(utterance))
    text = _qwen_answer(utterance, use_tools)
    return text, ("agent" if use_tools else "chat")


# --- Step-Audio TTS: text -> assistant audio tokens --------------------------
def _step_tts_messages(text):
    return [
        {"role": "system", "content": "Read the following text aloud verbatim in English."},
        {"role": "user", "content": text},
        {"role": "assistant", "content": "<tts_start>", "eot": False},
    ]


def _step_tts_tokens(text):
    """Blocking: ask Step-Audio vLLM to speak `text`; return all audio codec token
    ids. Kept for /reply-style non-streaming callers."""
    payload = {"model": STEP_MODEL, "messages": _step_tts_messages(text),
               "max_tokens": 2048, "temperature": 0.7,
               "continue_final_message": True, "add_generation_prompt": False}
    data = _post_json(STEP_URL, payload)
    msg = data["choices"][0]["message"]
    raw = ""
    tts = msg.get("tts_content") or {}
    if isinstance(tts, dict) and tts.get("tts_audio"):
        raw = tts["tts_audio"]
    if not raw:
        raw = msg.get("content") or ""
    toks = [int(x) for x in _AUDIO_TOK_RE.findall(raw)]
    return [t for t in toks if t < 6561]


def _step_tts_token_stream(text):
    """Streaming generator: yield Step-Audio audio token ids as vLLM emits them
    (SSE, stream=true). First tokens arrive in ~0.2s instead of waiting ~3s for the
    whole clip — this is what lets us start speaking almost immediately."""
    payload = {"model": STEP_MODEL, "messages": _step_tts_messages(text),
               "max_tokens": 2048, "temperature": 0.7,
               "continue_final_message": True, "add_generation_prompt": False,
               "stream": True}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(STEP_URL, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=120) as r:
        for line in r:
            line = line.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            body = line[5:].strip()
            if body == "[DONE]":
                break
            try:
                obj = json.loads(body)
                delta = obj["choices"][0].get("delta", {})
                piece = delta.get("content") or ""
                tts = delta.get("tts_content") or {}
                if isinstance(tts, dict) and tts.get("tts_audio"):
                    piece += tts["tts_audio"]
            except Exception:
                continue
            for m in _AUDIO_TOK_RE.findall(piece):
                t = int(m)
                if t < 6561:
                    yield t


# token2wav streaming is GPU-stateful (one flow/hift cache), so serialize turns.
_t2w_lock = threading.Lock()
# Tokens per vocoder chunk: ~25 tok ≈ 0.5s of audio. Small enough for a fast first
# chunk, large enough that per-chunk flow overhead stays amortized.
_CHUNK_TOKS = int(os.environ.get("HARMAN_TTS_CHUNK_TOKS", "25"))


def _voice_pcm_stream(text):
    """Generator of int16 PCM byte chunks (mono, 24k) for `text`, produced by
    streaming Step-Audio tokens into token2wav.stream() in ~0.5s groups. Yields the
    first audio in ~1s instead of ~4s. Falls back to a single blocking synth if the
    streaming vocoder path isn't available."""
    if _t2w is None:
        return
    stream_fn = getattr(_t2w, "stream", None)
    set_cache = getattr(_t2w, "set_stream_cache", None)
    if not stream_fn or not set_cache:
        # Older token2wav without streaming: one-shot fallback.
        toks = _step_tts_tokens(text)
        if toks:
            wav_bytes = _t2w(toks, prompt_wav=VOICE_WAV)
            with wave.open(io.BytesIO(wav_bytes), "rb") as w:
                yield w.readframes(w.getnframes())
        return
    with _t2w_lock:
        set_cache(VOICE_WAV)
        buf = []
        gen = _step_tts_token_stream(text)
        pending = None
        try:
            pending = next(gen)
        except StopIteration:
            pending = None
        while pending is not None:
            buf.append(pending)
            try:
                pending = next(gen)
            except StopIteration:
                pending = None
            is_last = pending is None
            if len(buf) >= _CHUNK_TOKS or is_last:
                if buf:
                    pcm = stream_fn(buf, prompt_wav=VOICE_WAV, last_chunk=is_last)
                    buf = []
                    if pcm:
                        yield pcm


def _voice_pcm_f32(text):
    """text -> assistant-voiced float32 PCM (mono, 24k). Blocking; used by callers
    that want the whole clip at once."""
    toks = _step_tts_tokens(text)
    if not toks or _t2w is None:
        return np.zeros(0, dtype=np.float32)
    wav_bytes = _t2w(toks, prompt_wav=VOICE_WAV)  # returns WAV bytes
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    return (pcm.astype(np.float32) / 32768.0)


# --- endpoints ------------------------------------------------------------
@app.get("/health")
def health():
    return {"ok": True, "tts": TTS_BACKEND, "pocket": POCKET_URL,
            "voice": VOICE_WAV, "step": STEP_URL, "qwen": QWEN_URL}


@app.post("/reply")
async def reply(request: Request):
    body = await request.json()
    text, routed = brain(body.get("text", ""))
    return JSONResponse({"text": text, "routed": routed})


@app.post("/synthesize_stream_aac")
async def synthesize_stream_aac(request: Request):
    """Full turn: utterance text -> Qwen brain -> spoken answer as live ADTS-AAC.
    Same media contract as pocket_service so the viewer proxy is unchanged.

    Default TTS = Pocket (:8097): ~4x faster than Step-Audio's token2wav and the
    same cloned "george" voice. Qwen is the brain; Pocket is the mouth. Set
    HARMAN_ASSISTANT_TTS=step to fall back to the local Step-Audio vocoder."""
    body = await request.json()
    utterance = (body.get("text") or "").strip()
    if not utterance:
        return JSONResponse({"error": "empty text"}, status_code=400)

    answer, routed = brain(utterance)

    if TTS_BACKEND != "step":
        # Speak via Pocket: POST the answer text and proxy its AAC stream straight
        # through. No local GPU vocoder, no ffmpeg — Pocket already emits ADTS-AAC.
        def out():
            try:
                data = json.dumps({"text": answer}).encode()
                req = urllib.request.Request(POCKET_URL, data=data, method="POST")
                req.add_header("Content-Type", "application/json")
                with urllib.request.urlopen(req, timeout=120) as up:
                    while True:
                        chunk = up.read(4096)
                        if not chunk:
                            break
                        yield chunk
            except Exception as e:
                print(f"[assistant] pocket proxy error: {e}", flush=True)
        return StreamingResponse(out(), media_type="audio/aac")

    # --- fallback: local Step-Audio token2wav (slower) ---
    if _t2w is None:
        return JSONResponse({"error": "token2wav not loaded"}, status_code=503)
    proc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-f", "f32le", "-ar", str(_SR), "-ac", "1", "-i", "pipe:0",
         "-c:a", "aac", "-b:a", "96k", "-f", "adts", "pipe:1"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )

    def feed():
        try:
            pcm = _voice_pcm_f32(answer).astype("<f4")
            proc.stdin.write(pcm.tobytes())
        except Exception as e:
            print(f"[assistant] feed error: {e}", flush=True)
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    threading.Thread(target=feed, daemon=True).start()

    def out_step():
        try:
            while True:
                data = proc.stdout.read(4096)
                if not data:
                    break
                yield data
        finally:
            proc.stdout.close()
            proc.wait()

    return StreamingResponse(out_step(), media_type="audio/aac")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
