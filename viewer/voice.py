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
import urllib.parse
import urllib.request

from viewer.config import (
    SPEECH_SERVICE_URL, SPEECH_TIMEOUT, VERIFY_SERVICE_URL, VERIFY_TIMEOUT,
)
from viewer.speakable import speakable


class VoiceError(Exception):
    """STT/TTS could not be completed (service unreachable, decode error, …)."""


def enabled() -> bool:
    """Voice is available only when a speech-service URL is configured."""
    return bool(SPEECH_SERVICE_URL)


def _post(path: str, data: bytes, content_type: str) -> bytes:
    if not SPEECH_SERVICE_URL:
        raise VoiceError("voice is disabled (no speech service configured)")
    return _post_url(SPEECH_SERVICE_URL, path, data, content_type, SPEECH_TIMEOUT)


def _post_url(base: str, path: str, data: bytes, content_type: str,
              timeout: int) -> bytes:
    url = base.rstrip("/") + path
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": content_type})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
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
    """Text → WAV bytes (16-bit PCM, mono, 24 kHz) spoken by Kokoro.

    The agent's replies are markdown, which a TTS model would voice literally
    ("asterisk asterisk"). Strip it to clean, paced prose first (see
    viewer.speakable) so the speech sounds natural."""
    spoken = speakable(text or "")
    if not spoken:
        raise VoiceError("empty text")
    payload = json.dumps({"text": spoken}).encode("utf-8")
    return _post("/synthesize", payload, "application/json")


def _post_q(path: str, query: str, data: bytes, content_type: str) -> bytes:
    """POST to the VERIFY service (enroll/segment live there, which may be a
    different port than TTS), appending a query string (for ?speaker_id=…)."""
    if not VERIFY_SERVICE_URL:
        raise VoiceError("speaker verification is disabled (no verify service)")
    full = path + ("?" + query if query else "")
    return _post_url(VERIFY_SERVICE_URL, full, data, content_type, VERIFY_TIMEOUT)


def enroll(audio: bytes, speaker_id: str = "default",
           content_type: str = "audio/wav") -> dict:
    """Enroll (or re-enroll) the user's voiceprint from a few seconds of speech.
    Returns the service's {ok, speaker_id, dim}. The audio is a raw recording;
    the box decodes it (ffmpeg) and stores a normalized speaker embedding."""
    if not audio:
        raise VoiceError("empty audio")
    q = urllib.parse.urlencode({"speaker_id": speaker_id or "default"})
    raw = _post_q("/enroll", q, audio, content_type or "application/octet-stream")
    try:
        return json.loads(raw)
    except ValueError:
        raise VoiceError("speech service returned a malformed enroll response")


def segment(audio: bytes, speaker_id: str = "default",
            content_type: str = "audio/wav", no_wake: bool = False) -> dict:
    """Wake + speaker-verify one audio window. Returns the service's
    {speech, wake, match, score, text}. The caller fires a chat turn only when
    wake AND match are both true (strict: only the enrolled user's "Harman…").

    Pass no_wake=True for CALL mode: the box then returns the full transcript for
    any speech even without the "Harman" wake word, so a call fires on plain
    speech (the call itself is the intent signal)."""
    if not audio:
        return {"speech": False, "wake": False, "match": False, "score": 0.0, "text": ""}
    params = {"speaker_id": speaker_id or "default"}
    if no_wake:
        params["no_wake"] = "1"
    q = urllib.parse.urlencode(params)
    raw = _post_q("/segment", q, audio, content_type or "application/octet-stream")
    try:
        return json.loads(raw)
    except ValueError:
        raise VoiceError("speech service returned a malformed segment response")


def wakeguard(audio: bytes, content_type: str = "audio/wav") -> dict:
    """Barge-in wake check for a window captured WHILE the assistant is speaking.
    The audio is echo-cancelled on the device (voiceProcessingIO), so this only
    gates on the wake word — no speaker verify. Returns {wake, text}: wake=True
    with the command tail when the user said "Harman …" over the assistant."""
    if not audio:
        return {"wake": False, "text": ""}
    raw = _post_q("/wakeguard", "", audio, content_type or "application/octet-stream")
    try:
        return json.loads(raw)
    except ValueError:
        raise VoiceError("speech service returned a malformed wakeguard response")
