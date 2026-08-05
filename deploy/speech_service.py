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
import json
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
SPK_MODEL = os.environ.get(
    "HARMAN_SPK_MODEL",
    os.path.join(BASE, "speaker-embedding", "nemo_en_titanet_small.onnx"),
)
SILERO_VAD = os.path.join(BASE, "silero-vad", "silero_vad.onnx")
# Where enrolled voiceprints live (one JSON per speaker_id: {"dim":..,"vec":[...]}).
VOICEPRINT_DIR = os.environ.get(
    "HARMAN_VOICEPRINT_DIR", os.path.join(BASE, "voiceprints")
)
# NeMo Parakeet is a transducer trained at 16 kHz; Kokoro renders at 24 kHz.
STT_SAMPLE_RATE = 16000
PROVIDER = os.environ.get("HARMAN_SPEECH_PROVIDER", "cpu")  # "cuda" once ORT-GPU is wired
THREADS = int(os.environ.get("HARMAN_SPEECH_THREADS", "4"))

# Wake word + speaker-verification tunables (all env-overridable so they can be
# tuned on the box without a redeploy).
WAKE_WORD = os.environ.get("HARMAN_WAKE_WORD", "harman").lower().strip()
SPK_THRESHOLD = float(os.environ.get("HARMAN_SPK_THRESHOLD", "0.45"))

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


def _load_spk():
    """Speaker-embedding extractor (NeMo TitaNet) — 192-dim voiceprints used to
    verify that a wake utterance came from the enrolled user, not a bystander.

    Pinned to CPU: TitaNet's fused-conv layers trip a cuDNN BAD_PARAM on this
    ORT-CUDA build, and the model is tiny (~40MB, sub-10ms/clip on CPU), so GPU
    buys nothing here. STT/TTS stay on CUDA."""
    provider = os.environ.get("HARMAN_SPK_PROVIDER", "cpu")
    cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=SPK_MODEL, num_threads=THREADS, provider=provider
    )
    return sherpa_onnx.SpeakerEmbeddingExtractor(cfg)


try:
    _spk = _load_spk()
except Exception as e:
    print(f"[speech] speaker-embedding load failed: {e}", flush=True)
    _spk = None

os.makedirs(VOICEPRINT_DIR, exist_ok=True)


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


# ---- Speaker verification + wake-word helpers --------------------------------

def _embed(audio: np.ndarray) -> np.ndarray:
    """Compute an L2-normalized speaker embedding for a mono-16k float32 clip."""
    stream = _spk.create_stream()
    stream.accept_waveform(STT_SAMPLE_RATE, audio)
    stream.input_finished()
    vec = np.asarray(_spk.compute(stream), dtype=np.float32)
    norm = float(np.linalg.norm(vec))
    return vec / norm if norm > 0 else vec


def _voiceprint_path(speaker_id: str) -> str:
    # Keep speaker_id filesystem-safe (it comes from the client).
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", speaker_id or "default")
    return os.path.join(VOICEPRINT_DIR, f"{safe}.json")


def _save_voiceprint(speaker_id: str, vec: np.ndarray) -> None:
    with open(_voiceprint_path(speaker_id), "w") as f:
        json.dump({"dim": int(vec.size), "vec": vec.tolist()}, f)


def _load_voiceprint(speaker_id: str):
    path = _voiceprint_path(speaker_id)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        data = json.load(f)
    return np.asarray(data.get("vec", []), dtype=np.float32)


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    if a is None or b is None or a.size == 0 or b.size != a.size:
        return 0.0
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def _transcribe_np(audio: np.ndarray) -> str:
    stream = _stt.create_stream()
    stream.accept_waveform(STT_SAMPLE_RATE, audio)
    _stt.decode_stream(stream)
    return (stream.result.text or "").strip()


def _edit_distance(a: str, b: str) -> int:
    """Levenshtein distance — small strings, so the simple DP is plenty fast."""
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


# ASR (Parakeet) rarely spells the wake word exactly — "Harman" comes back as
# "Harmon", "Herman", etc. Accept a token as the wake word if it's an explicit
# known variant or within a small edit distance of the configured wake word.
_WAKE_VARIANTS = {WAKE_WORD, "harman", "harmon", "herman", "harmony", "harmen",
                  "hartman", "harding"}


def _is_wake_token(tok: str) -> bool:
    if not tok:
        return False
    if tok in _WAKE_VARIANTS:
        return True
    # Allow edit distance up to ~1/4 of the word length (>=1) for ASR noise.
    return _edit_distance(tok, WAKE_WORD) <= max(1, len(WAKE_WORD) // 4)


def _strip_wake(text: str):
    """If `text` begins with the wake word (allowing ASR spelling drift), return
    (True, remainder-without-wake). Else (False, text). Parakeet lowercases and
    drops most punctuation, so a normalized fuzzy prefix check is robust."""
    norm = re.sub(r"[^a-z0-9 ]", " ", (text or "").lower())
    norm = re.sub(r"\s+", " ", norm).strip()
    if not WAKE_WORD:
        return False, text
    words = norm.split(" ")
    if not words or not words[0]:
        return False, text
    # Wake word as the first token (or first two if ASR split it, e.g. "har man").
    if _is_wake_token(words[0]):
        return True, " ".join(words[1:]).strip()
    if len(words) >= 2 and _is_wake_token("".join(words[:2])):
        return True, " ".join(words[2:]).strip()
    return False, text


# ---- Routes ------------------------------------------------------------------

@app.get("/health")
def health():
    return {"ok": True, "stt": _stt is not None, "tts": _tts is not None,
            "spk": _spk is not None, "provider": PROVIDER,
            "wake_word": WAKE_WORD, "spk_threshold": SPK_THRESHOLD}


@app.post("/enroll")
async def enroll(request: Request):
    """Enroll (or re-enroll) a user's voiceprint. Body = raw audio (a few seconds
    of the user speaking). Query/JSON `speaker_id` names the voiceprint (default
    "default"). Averaging happens client-side by sending one clean clip; we store
    a single normalized embedding."""
    if _spk is None:
        return JSONResponse({"error": "speaker model not loaded"}, status_code=503)
    raw = await request.body()
    if not raw:
        return JSONResponse({"error": "empty audio body"}, status_code=400)
    speaker_id = (request.query_params.get("speaker_id") or "default").strip()
    try:
        audio = _decode_to_mono16k(raw)
    except Exception as e:
        return JSONResponse({"error": f"decode failed: {e}"}, status_code=400)
    if audio.size < STT_SAMPLE_RATE // 2:  # < 0.5s is too short to be reliable
        return JSONResponse({"error": "audio too short to enroll"}, status_code=400)
    vec = _embed(audio)
    _save_voiceprint(speaker_id, vec)
    return {"ok": True, "speaker_id": speaker_id, "dim": int(vec.size)}


@app.post("/segment")
async def segment(request: Request):
    """Wake + speaker-verify one audio window. Body = raw audio bytes; JSON/query
    `speaker_id` selects the enrolled voiceprint. Returns:
        {speech, wake, match, score, text}
    - speech: did VAD find any speech at all
    - wake:   did the transcript start with the wake word ("Harman")
    - match:  is the speaker the enrolled user (cosine >= threshold)
    - score:  cosine similarity to the enrolled voiceprint
    - text:   the transcript with the wake word stripped (only meaningful on wake)
    The caller fires a chat turn only when wake AND match are both true."""
    if _stt is None or _spk is None:
        return JSONResponse({"error": "models not loaded"}, status_code=503)
    raw = await request.body()
    if not raw:
        return JSONResponse({"error": "empty audio body"}, status_code=400)
    speaker_id = (request.query_params.get("speaker_id") or "default").strip()
    # Call mode: the phone call is itself the intent signal, so we do NOT require
    # the "Harman" wake word — return the full transcript for any speech so the
    # caller can fire a turn on it. Hands-free (no_wake unset) keeps strict gating.
    no_wake = (request.query_params.get("no_wake") or "") in ("1", "true", "yes")
    try:
        audio = _decode_to_mono16k(raw)
    except Exception as e:
        return JSONResponse({"error": f"decode failed: {e}"}, status_code=400)
    # Too little energy -> treat as silence (cheap gate before running the ASR).
    if audio.size == 0 or float(np.sqrt(np.mean(audio * audio))) < 0.004:
        return {"speech": False, "wake": False, "match": False, "score": 0.0, "text": ""}
    text = _transcribe_np(audio)
    if not text:
        return {"speech": False, "wake": False, "match": False, "score": 0.0, "text": ""}
    is_wake, rest = _strip_wake(text)
    if not is_wake:
        # No wake word. In call mode, still surface the full transcript so the
        # caller fires on plain speech; in strict mode, withhold it.
        return {"speech": True, "wake": False, "match": False, "score": 0.0,
                "text": text if no_wake else ""}
    enrolled = _load_voiceprint(speaker_id)
    if enrolled is None:
        # No enrollment yet: report wake but cannot verify. match stays False so
        # strict mode won't fire; the app should prompt the user to enroll.
        return {"speech": True, "wake": True, "match": False, "score": 0.0,
                "text": rest, "unenrolled": True}
    score = _cosine(_embed(audio), enrolled)
    return {"speech": True, "wake": True, "match": score >= SPK_THRESHOLD,
            "score": round(score, 4), "text": rest}


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


@app.post("/wakeguard")
async def wakeguard(request: Request):
    """Barge-in wake guard: cheap "did the user say Harman?" check for a window
    captured WHILE the assistant is speaking (call-mode barge-in).

    Body = raw audio (echo-cancelled PCM/WAV from the phone's voiceProcessingIO,
    so the assistant's own TTS is already removed from the signal). Returns:
        {wake: bool, text: str}
    - wake: did the transcript start with the wake word ("Harman")
    - text: the transcript with the wake word stripped (the command / question)

    Unlike /segment this SKIPS speaker verification: the hardware AEC already
    strips the assistant's voice, so the only thing left to gate on is the wake
    word. The RMS energy gate short-circuits the (near-silent, echo-cancelled)
    windows before any STT runs, so it's cheap to loop continuously."""
    if _stt is None:
        return JSONResponse({"error": "STT model not loaded"}, status_code=503)
    raw = await request.body()
    if not raw:
        return {"wake": False, "text": ""}
    try:
        audio = _decode_to_mono16k(raw)
    except Exception as e:
        return JSONResponse({"error": f"decode failed: {e}"}, status_code=400)
    # Echo-cancelled window with no user speech is near-silent -> skip STT.
    if audio.size == 0 or float(np.sqrt(np.mean(audio * audio))) < 0.004:
        return {"wake": False, "text": ""}
    text = _transcribe_np(audio)
    if not text:
        return {"wake": False, "text": ""}
    is_wake, rest = _strip_wake(text)
    if not is_wake:
        return {"wake": False, "text": ""}
    return {"wake": True, "text": rest}


@app.post("/synthesize")
async def synthesize(request: Request):
    if _tts is None:
        return JSONResponse({"error": "TTS model not loaded"}, status_code=503)
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)
    sid = int(body.get("voice", 0))
    # Slightly faster than normal for a snappier feel; pauses still breathe.
    speed = float(body.get("speed", 1.1))
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
