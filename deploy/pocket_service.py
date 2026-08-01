#!/usr/bin/env python3
"""
Harman Pocket-TTS service — fast neural TTS (kyutai/pocket-tts), the successor
to the Qwen experiment. Runs in ~/pocket-tts-env on its own port (default 8097).

  POST /synthesize : {"text": ...} -> audio/wav
  POST /transcribe : audio bytes   -> {"text": ...}  (FORWARDED to Parakeet on 8095)
  GET  /health     : {"ok": true, "tts": bool, "engine": "pocket", "voice": ...}

Pocket generates faster than real-time (RTF ~0.5), so this is meant to be the
default conversational voice. The viewer just points HARMAN_SPEECH_URL here.
"""
import io
import os
import urllib.request
import wave

import numpy as np
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

VOICE = os.environ.get("HARMAN_POCKET_VOICE", "george")  # US English male
STT_FORWARD_URL = os.environ.get("HARMAN_STT_URL", "http://127.0.0.1:8095/transcribe")

app = FastAPI()

try:
    from pocket_tts import TTSModel
    _model = TTSModel.load_model()
    _sr = int(_model.sample_rate)
    # Cache the voice state so every request skips prompt setup.
    _voice_state = _model.get_state_for_audio_prompt(VOICE)
    print(f"[pocket] loaded, sr={_sr}, voice={VOICE}", flush=True)
except Exception as e:
    print(f"[pocket] load failed: {e}", flush=True)
    _model = None
    _sr = 24000
    _voice_state = None


def _to_np(audio) -> np.ndarray:
    a = audio.numpy() if hasattr(audio, "numpy") else np.asarray(audio)
    return np.asarray(a, dtype=np.float32).squeeze()


def _wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    pcm = np.clip(samples, -1.0, 1.0)
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
    return {"ok": True, "tts": _model is not None, "engine": "pocket", "voice": VOICE}


@app.post("/synthesize")
async def synthesize(request: Request):
    if _model is None:
        return JSONResponse({"error": "Pocket TTS model not loaded"}, status_code=503)
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)
    audio = _model.generate_audio(_voice_state, text)
    return Response(content=_wav_bytes(_to_np(audio), _sr), media_type="audio/wav")


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
    port = int(os.environ.get("HARMAN_POCKET_PORT", "8097"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
