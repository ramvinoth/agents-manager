#!/usr/bin/env python3
"""
Harman speech service — runs on the GPU box (suha-ai), driven by the viewer.

Exposes two endpoints backed by sherpa-onnx, using models already on disk under
~/.paseo/models/local-speech/ (nothing is downloaded):
  - POST /transcribe : audio bytes (WAV/any ffmpeg-decodable) -> {"text": "..."}
                       STT via NeMo Parakeet TDT 0.6B (int8 ONNX, offline recognizer).
  - POST /synthesize : {"text": "..."} -> audio/wav
                       TTS via Kokoro (sherpa-onnx offline TTS).
  - GET  /health     : {"ok": true, "stt": bool, "tts": bool}

Models load once at startup and are reused across requests. Runs under systemd
on its own port (default 8095) so it never touches the existing .paseo daemon.

This file is deployed to ~/harman-speech/speech_service.py on suha-ai and run
inside ~/voiceagent-env (which already has sherpa_onnx, fastapi, uvicorn,
soundfile, numpy).
"""
import io
import os
import re
import subprocess
import wave

import numpy as np
import sherpa_onnx
import soundfile as sf
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

BASE = os.path.expanduser("~/.paseo/models/local-speech")
PARAKEET = os.path.join(BASE, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8")
KOKORO = os.path.join(BASE, "kokoro-en-v0_19")
# NeMo Parakeet is a transducer trained at 16 kHz; Kokoro renders at 24 kHz.
STT_SAMPLE_RATE = 16000
PROVIDER = os.environ.get("HARMAN_SPEECH_PROVIDER", "cpu")  # "cuda" once ORT-GPU is wired
THREADS = int(os.environ.get("HARMAN_SPEECH_THREADS", "4"))

app = FastAPI()

# ---- Model load (once) -------------------------------------------------------

def _load_stt():
    """Offline NeMo transducer recognizer (Parakeet TDT)."""
    return sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=os.path.join(PARAKEET, "encoder.int8.onnx"),
        decoder=os.path.join(PARAKEET, "decoder.int8.onnx"),
        joiner=os.path.join(PARAKEET, "joiner.int8.onnx"),
        tokens=os.path.join(PARAKEET, "tokens.txt"),
        num_threads=THREADS,
        sample_rate=STT_SAMPLE_RATE,
        feature_dim=80,
        decoding_method="greedy_search",
        model_type="nemo_transducer",
        provider=PROVIDER,
    )


def _load_tts():
    """Kokoro offline TTS."""
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=os.path.join(KOKORO, "model.onnx"),
                voices=os.path.join(KOKORO, "voices.bin"),
                tokens=os.path.join(KOKORO, "tokens.txt"),
                data_dir=os.path.join(KOKORO, "espeak-ng-data"),
            ),
            provider=PROVIDER,
            num_threads=THREADS,
        ),
        max_num_sentences=2,
    )
    return sherpa_onnx.OfflineTts(cfg)


try:
    _stt = _load_stt()
except Exception as e:  # keep the service up so /health reports the failure
    print(f"[speech] STT load failed: {e}", flush=True)
    _stt = None
try:
    _tts = _load_tts()
except Exception as e:
    print(f"[speech] TTS load failed: {e}", flush=True)
    _tts = None


# ---- Audio helpers -----------------------------------------------------------

def _decode_to_mono16k(raw: bytes) -> np.ndarray:
    """Decode arbitrary audio bytes to float32 mono @ 16 kHz.

    Tries soundfile first (WAV/FLAC/OGG); falls back to ffmpeg for anything else
    (m4a/aac/webm from mobile/browser recorders). Returns a 1-D float32 array in
    [-1, 1] which is what sherpa-onnx expects.
    """
    try:
        data, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
        if data.ndim > 1:
            data = data.mean(axis=1)
        if sr != STT_SAMPLE_RATE:
            data = _resample(data, sr, STT_SAMPLE_RATE)
        return data.astype(np.float32)
    except Exception:
        pass
    # ffmpeg fallback: decode to raw f32le mono 16k on stdout.
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-i", "pipe:0", "-f", "f32le", "-ac", "1",
         "-ar", str(STT_SAMPLE_RATE), "pipe:1"],
        input=raw, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True,
    )
    return np.frombuffer(proc.stdout, dtype=np.float32)


def _resample(x: np.ndarray, src: int, dst: int) -> np.ndarray:
    """Cheap linear resample — adequate for speech recognition input."""
    if src == dst or x.size == 0:
        return x
    n = int(round(x.size * dst / src))
    xp = np.linspace(0.0, 1.0, x.size, endpoint=False)
    fp = np.linspace(0.0, 1.0, n, endpoint=False)
    return np.interp(fp, xp, x).astype(np.float32)


def _split_for_prosody(text: str):
    """Split text into (chunk, trailing_punct) pairs for sentence-paced TTS.

    Break on sentence enders (. ! ? :) and, more gently, on commas — so the
    caller pads a longer silence after sentences and a short one after commas.
    Newlines become hard sentence breaks (the markdown cleaner already ends
    headers/list items on their own lines). Returns each chunk (without its
    trailing punctuation) plus the punctuation char that ended it."""
    text = re.sub(r"\s*\n+\s*", " . ", text)
    pieces = []
    buf = []
    for ch in text:
        if ch in ".!?:,":
            chunk = "".join(buf).strip()
            if chunk:
                pieces.append((chunk, ch))
            buf = []
        else:
            buf.append(ch)
    tail = "".join(buf).strip()
    if tail:
        pieces.append((tail, ""))
    return pieces


def _wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    """Encode float32 [-1,1] mono to 16-bit PCM WAV bytes."""
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


# ---- Routes ------------------------------------------------------------------

@app.get("/health")
def health():
    return {"ok": True, "stt": _stt is not None, "tts": _tts is not None,
            "provider": PROVIDER}


@app.post("/transcribe")
async def transcribe(request: Request):
    if _stt is None:
        return JSONResponse({"error": "STT model not loaded"}, status_code=503)
    raw = await request.body()
    if not raw:
        return JSONResponse({"error": "empty audio body"}, status_code=400)
    try:
        audio = _decode_to_mono16k(raw)
    except Exception as e:
        return JSONResponse({"error": f"decode failed: {e}"}, status_code=400)
    stream = _stt.create_stream()
    stream.accept_waveform(STT_SAMPLE_RATE, audio)
    _stt.decode_stream(stream)
    return {"text": (stream.result.text or "").strip()}


@app.post("/synthesize")
async def synthesize(request: Request):
    if _tts is None:
        return JSONResponse({"error": "TTS model not loaded"}, status_code=503)
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)
    sid = int(body.get("voice", 0))
    # Normal speaking rate (1.0). Pauses between sentences do the "breathing",
    # so we don't also slow the rate.
    speed = float(body.get("speed", 1.0))
    # Silence (seconds) inserted BETWEEN sentences and (shorter) at commas so the
    # speech breathes. Kokoro renders a whole blob with very short internal gaps,
    # so we synthesize sentence-by-sentence and pad the joins ourselves.
    gap = float(body.get("gap", 0.32))
    comma_gap = float(body.get("comma_gap", 0.14))
    chunks = _split_for_prosody(text)
    sample_rate = 24000
    pieces = []
    for chunk, trailing in chunks:
        audio = _tts.generate(chunk, sid=sid, speed=speed)
        sample_rate = audio.sample_rate
        pieces.append(np.asarray(audio.samples, dtype=np.float32))
        pad = gap if trailing in ".!?:" else comma_gap if trailing == "," else 0.0
        if pad > 0:
            pieces.append(np.zeros(int(sample_rate * pad), dtype=np.float32))
    samples = np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.float32)
    wav = _wav_bytes(samples, sample_rate)
    return Response(content=wav, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("HARMAN_SPEECH_PORT", "8095"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
