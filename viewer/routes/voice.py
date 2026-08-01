"""viewer.routes.voice — VoiceMixin: speech-to-text + text-to-speech endpoints.

Thin HTTP wrappers over viewer.voice (which delegates to the GPU speech service).
Both are normal /api routes, so the standard session gate authenticates them.

  POST /api/voice/stt   body = raw audio bytes (Content-Type: audio/*)  -> {"text": ...}
  POST /api/voice/tts   body = {"text": ...}                            -> audio/wav bytes
  GET  /api/voice/tts/stream?text=...  -> live audio/aac stream (proxied from the
                        speech service's /synthesize_stream_aac). track-player does
                        a GET with an Authorization header, so this is a GET.
"""
import urllib.parse
import urllib.request

from viewer import voice
from viewer.config import SPEECH_SERVICE_URL, SPEECH_TIMEOUT


class VoiceMixin:
    def _p_voice_stt(self, req):
        """Transcribe posted audio. The body is raw audio (not JSON), so read it
        directly off the wire using the declared Content-Length + Content-Type."""
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            length = 0
        if not length:
            self.send_json({"error": "empty audio body"}, status=400)
            return
        audio = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "audio/wav")
        try:
            text = voice.transcribe(audio, content_type)
        except voice.VoiceError as e:
            self.send_json({"error": str(e)}, status=502)
            return
        self.send_json({"text": text})

    def _p_voice_tts(self, req):
        """Synthesize speech for the posted text; respond with WAV bytes."""
        body = self.read_body() or {}
        try:
            wav = voice.synthesize(body.get("text", ""))
        except voice.VoiceError as e:
            self.send_json({"error": str(e)}, status=502)
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(wav)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _g_voice_tts_stream(self, req):
        """Proxy a LIVE AAC stream from the speech service to the client, chunk
        by chunk, so a streaming player starts almost immediately. text comes in
        the query string (a GET, so react-native-track-player can play the URL
        with an Authorization header)."""
        text = (req.query.get("text") or [""])[0].strip()
        if not text:
            self.send_json({"error": "empty text"}, status=400)
            return
        # Strip markdown so the stream doesn't voice "asterisk asterisk" etc.
        from viewer.speakable import speakable
        text = speakable(text) or text
        if not SPEECH_SERVICE_URL:
            self.send_json({"error": "voice disabled"}, status=502)
            return
        import json as _json
        url = SPEECH_SERVICE_URL.rstrip("/") + "/synthesize_stream_aac"
        body = _json.dumps({"text": text}).encode("utf-8")
        upstream = urllib.request.Request(url, data=body, method="POST",
                                          headers={"Content-Type": "application/json"})
        try:
            resp = urllib.request.urlopen(upstream, timeout=SPEECH_TIMEOUT)
        except Exception as e:
            self.send_json({"error": f"speech service unreachable: {e}"}, status=502)
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/aac")
        self.send_header("Access-Control-Allow-Origin", "*")
        # No Content-Length: it's a live stream. HTTP/1.0 closes the connection
        # at the end, which the player treats as end-of-stream.
        self.end_headers()
        try:
            while True:
                data = resp.read(4096)
                if not data:
                    break
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                resp.close()
            except Exception:
                pass
