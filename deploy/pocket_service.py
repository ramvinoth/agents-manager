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
import struct
import subprocess
import threading
import urllib.request
import wave

import numpy as np
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

VOICE = os.environ.get("HARMAN_POCKET_VOICE", "george")  # US English male
STT_FORWARD_URL = os.environ.get("HARMAN_STT_URL", "http://127.0.0.1:8095/transcribe")
DEVICE = os.environ.get("HARMAN_POCKET_DEVICE", "cuda")  # "cuda" (GPU) or "cpu"

app = FastAPI()

try:
    import torch
    from pocket_tts import TTSModel
    _model = TTSModel.load_model()
    # Move to GPU when available (CLI's `serve` does model.to(device)). Long
    # replies are much faster on the 3090s than CPU.
    if DEVICE.startswith("cuda") and torch.cuda.is_available():
        _model = _model.to(DEVICE)
        _dev = DEVICE
    else:
        _dev = "cpu"
    _sr = int(_model.sample_rate)
    # Cache the voice state so every request skips prompt setup.
    _voice_state = _model.get_state_for_audio_prompt(VOICE)
    print(f"[pocket] loaded on {_dev}, sr={_sr}, voice={VOICE}", flush=True)
except Exception as e:
    print(f"[pocket] load failed: {e}", flush=True)
    _model = None
    _sr = 24000
    _voice_state = None


def _to_np(audio) -> np.ndarray:
    # A CUDA tensor must be copied to host (.cpu()) before numpy() — otherwise
    # "can't convert cuda:0 device type tensor to numpy".
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu()
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


def _streaming_wav_header(sample_rate: int) -> bytes:
    """A WAV header for an OPEN-ENDED PCM stream: sizes are set to a large
    placeholder so a progressive player starts immediately without knowing the
    final length. 16-bit mono."""
    data_size = 0x7FFFFFFF - 44  # unknown length placeholder
    riff_size = data_size + 36
    return (b"RIFF" + struct.pack("<I", riff_size) + b"WAVE"
            + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate,
                                    sample_rate * 2, 2, 16)
            + b"data" + struct.pack("<I", data_size))


@app.post("/synthesize_stream")
async def synthesize_stream(request: Request):
    """Stream audio as it's generated (Pocket generate_audio_stream). Emits a
    WAV header, then int16 PCM chunks (~80ms each) as they become available —
    first chunk in ~0.5s, so a progressive client starts speaking almost at
    once even for a long reply."""
    if _model is None:
        return JSONResponse({"error": "Pocket TTS model not loaded"}, status_code=503)
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)

    def gen():
        yield _streaming_wav_header(_sr)
        for chunk in _model.generate_audio_stream(_voice_state, text):
            a = _to_np(chunk)
            pcm = (np.clip(a, -1.0, 1.0) * 32767.0).astype("<i2")
            yield pcm.tobytes()

    return StreamingResponse(gen(), media_type="audio/wav")


@app.post("/synthesize_stream_aac")
async def synthesize_stream_aac(request: Request):
    """Stream as ADTS-AAC — a format mobile players (react-native-track-player)
    can play LIVE as it arrives. Pocket's float32 PCM chunks are piped into
    ffmpeg's stdin on a thread; ffmpeg's stdout (AAC) is yielded to the client
    as it's produced. First audio in ~0.5s even for a long reply."""
    if _model is None:
        return JSONResponse({"error": "Pocket TTS model not loaded"}, status_code=503)
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)

    proc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-f", "f32le", "-ar", str(_sr), "-ac", "1", "-i", "pipe:0",
         "-c:a", "aac", "-b:a", "96k", "-f", "adts", "pipe:1"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )

    def feed():
        try:
            for chunk in _model.generate_audio_stream(_voice_state, text):
                a = _to_np(chunk).astype("<f4")
                proc.stdin.write(a.tobytes())
            proc.stdin.close()  # signals ffmpeg EOF -> it flushes + exits
        except Exception:
            try:
                proc.stdin.close()
            except Exception:
                pass

    threading.Thread(target=feed, daemon=True).start()

    def out():
        try:
            while True:
                data = proc.stdout.read(4096)
                if not data:
                    break
                yield data
        finally:
            proc.stdout.close()
            proc.wait()

    return StreamingResponse(out(), media_type="audio/aac")


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
