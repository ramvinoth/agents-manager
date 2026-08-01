"""viewer.routes.voice — VoiceMixin: speech-to-text + text-to-speech endpoints.

Thin HTTP wrappers over viewer.voice (which delegates to the GPU speech service).
Both are normal /api routes, so the standard session gate authenticates them.

  POST /api/voice/stt   body = raw audio bytes (Content-Type: audio/*)  -> {"text": ...}
  POST /api/voice/tts   body = {"text": ...}                            -> audio/wav bytes
"""
from viewer import voice


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
