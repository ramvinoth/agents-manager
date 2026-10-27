#!/usr/bin/env python3
"""
Harman Qwen-TTS service — an alternate voice backend for A/B testing against
Kokoro. Runs in ~/qwen3-tts-env on its own port (default 8096).

  POST /synthesize : {"text": ...} -> audio/wav   (Qwen3-TTS-1.7B CustomVoice)
  POST /transcribe : audio bytes   -> {"text": ...}  (FORWARDED to the Kokoro/
                     Parakeet service on 8095 — Qwen is TTS only)
  GET  /health     : {"ok": true, "tts": bool, "engine": "qwen"}

So the viewer only needs to repoint HARMAN_SPEECH_URL at this port; STT keeps
using the fast Parakeet model transparently. Qwen TTS is ~5s/sentence, so this
is for judging QUALITY, not latency.
"""
import io
import os
import urllib.request
import wave

import numpy as np
import torch
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

QWEN_MODEL = os.environ.get("HARMAN_QWEN_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice")
QWEN_SPEAKER = os.environ.get("HARMAN_QWEN_SPEAKER", "vivian")
QWEN_LANG = os.environ.get("HARMAN_QWEN_LANG", "English")
# STT is forwarded here (the existing sherpa Parakeet service).
STT_FORWARD_URL = os.environ.get("HARMAN_STT_URL", "http://127.0.0.1:8095/transcribe")

app = FastAPI()

try:
    from qwen_tts import Qwen3TTSModel
    _tts = Qwen3TTSModel.from_pretrained(QWEN_MODEL, device_map="cuda", dtype=torch.bfloat16)
    print(f"[qwen] model loaded on {next(_tts.model.parameters()).device}", flush=True)
except Exception as e:  # keep the service up so /health reports the failure
    print(f"[qwen] TTS load failed: {e}", flush=True)
    _tts = None


def _wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    pcm = np.clip(np.asarray(samples, dtype=np.float32).squeeze(), -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


@app.get("/health")
def health():
    return {"ok": True, "tts": _tts is not None, "engine": "qwen", "speaker": QWEN_SPEAKER}


@app.post("/synthesize")
async def synthesize(request: Request):
    if _tts is None:
        return JSONResponse({"error": "Qwen TTS model not loaded"}, status_code=503)
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)
    speaker = body.get("voice") or QWEN_SPEAKER
    if isinstance(speaker, int):
        speaker = QWEN_SPEAKER
    wavs, sr = _tts.generate_custom_voice(text, language=QWEN_LANG, speaker=speaker)
    return Response(content=_wav_bytes(wavs[0], sr), media_type="audio/wav")


@app.post("/transcribe")
async def transcribe(request: Request):
    """Forward audio to the Parakeet STT service and relay its JSON back."""
    raw = await request.body()
    ct = request.headers.get("Content-Type", "audio/wav")
    req = urllib.request.Request(STT_FORWARD_URL, data=raw, method="POST",
                                 headers={"Content-Type": ct})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return Response(content=resp.read(), media_type="application/json")
    except Exception as e:
        return JSONResponse({"error": f"STT forward failed: {e}"}, status_code=502)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("HARMAN_QWEN_PORT", "8096"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
