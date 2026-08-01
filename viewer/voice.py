"""viewer.voice — speech-to-text + text-to-speech, delegated to the GPU box.

STT (Parakeet) and TTS (Kokoro) run as a persistent sherpa-onnx service on
suha-ai (see deploy/speech_service.py); this module is a thin client the viewer
calls. Audio never leaves the user's own machines (viewer host + the tailnet GPU
box) — no cloud provider.

Both functions raise VoiceError on failure (service down / bad audio) so the
route can surface a clear message; the caller never gets a silent empty result.
"""
import json
import urllib.error
import urllib.request

from viewer.config import SPEECH_SERVICE_URL, SPEECH_TIMEOUT


class VoiceError(Exception):
    """STT/TTS could not be completed (service unreachable, decode error, …)."""


def enabled() -> bool:
    """Voice is available only when a speech-service URL is configured."""
    return bool(SPEECH_SERVICE_URL)


def _post(path: str, data: bytes, content_type: str) -> bytes:
    if not SPEECH_SERVICE_URL:
        raise VoiceError("voice is disabled (no speech service configured)")
    url = SPEECH_SERVICE_URL.rstrip("/") + path
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": content_type})
    try:
        with urllib.request.urlopen(req, timeout=SPEECH_TIMEOUT) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:500]
        raise VoiceError(f"speech service {e.code}: {body}")
    except (urllib.error.URLError, OSError) as e:
        raise VoiceError(f"speech service unreachable: {e}")


def transcribe(audio: bytes, content_type: str = "audio/wav") -> str:
    """Speech → text. `audio` is raw recorded bytes (WAV/m4a/etc — the service
    decodes via ffmpeg). Returns the transcript (possibly empty for silence)."""
    if not audio:
        raise VoiceError("empty audio")
    raw = _post("/transcribe", audio, content_type or "application/octet-stream")
    try:
        return (json.loads(raw).get("text") or "").strip()
    except (ValueError, AttributeError):
        raise VoiceError("speech service returned a malformed transcription")


def synthesize(text: str) -> bytes:
    """Text → WAV bytes (16-bit PCM, mono, 24 kHz) spoken by Kokoro."""
    text = (text or "").strip()
    if not text:
        raise VoiceError("empty text")
    payload = json.dumps({"text": text}).encode("utf-8")
    return _post("/synthesize", payload, "application/json")
