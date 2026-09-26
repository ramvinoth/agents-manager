"""viewer.voice — the call's speech services, delegated to the GPU box.

Utterance segmentation/transcription and barge-in wake spotting run as a
persistent service on suha-ai (see deploy/speech_service.py); this module is a
thin client the viewer calls. Audio never leaves the user's own machines (viewer
host + the tailnet GPU box) — no cloud provider.

Every function raises VoiceError on failure (service down / bad audio) so the
route can surface a clear message; the caller never gets a silent empty result.
"""
import json
import urllib.error
import urllib.parse
import urllib.request

from viewer.config import VERIFY_SERVICE_URL, VERIFY_TIMEOUT


class VoiceError(Exception):
    """STT/TTS could not be completed (service unreachable, decode error, …)."""


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


def _post_q(path: str, query: str, data: bytes, content_type: str) -> bytes:
    """POST to the VERIFY service (enroll/segment live there, which may be a
    different port than TTS), appending a query string (for ?speaker_id=…)."""
    if not VERIFY_SERVICE_URL:
        raise VoiceError("speaker verification is disabled (no verify service)")
    full = path + ("?" + query if query else "")
    return _post_url(VERIFY_SERVICE_URL, full, data, content_type, VERIFY_TIMEOUT)


def segment(audio: bytes, speaker_id: str = "default",
            content_type: str = "audio/wav", no_wake: bool = False) -> dict:
    """Transcribe one audio window on the box. Returns the service's
    {speech, wake, match, score, text}. With no_wake=True (call mode) the full
    transcript comes back for any speech, wake word or not; without it the text
    is only filled after "Harman …" and `match` reports speaker verification."""
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
