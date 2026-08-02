"""viewer.routes.voice — VoiceMixin: speech-to-text + text-to-speech endpoints.

Thin HTTP wrappers over viewer.voice (which delegates to the GPU speech service).
Both are normal /api routes, so the standard session gate authenticates them.

  POST /api/voice/stt   body = raw audio bytes (Content-Type: audio/*)  -> {"text": ...}
  POST /api/voice/tts   body = {"text": ...}                            -> audio/wav bytes
  GET  /api/voice/tts/stream?text=...  -> live audio/aac stream (proxied from the
                        speech service's /synthesize_stream_aac). track-player does
                        a GET with an Authorization header, so this is a GET.
  POST /api/voice/enroll?speaker_id=...  body = raw audio (a few seconds of the
                        user's voice) -> {"ok":true, "speaker_id":...}. Stores a
                        voiceprint so hands-free listening can verify the speaker.
  GET  /api/voice/ws?speaker_id=...  -> WebSocket. The app streams audio windows
                        (binary WAV frames); the server runs wake-word + strict
                        speaker verification on the GPU box and sends back a JSON
                        text frame {"type":"utterance","text":...} ONLY when the
                        enrolled user says "Harman …". Hands-free listening channel.
"""
import json
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

    def _p_voice_enroll(self, req):
        """Enroll the user's voiceprint from a posted raw-audio clip. The body is
        raw audio (not JSON); speaker_id comes in the query (default "default")."""
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            length = 0
        if not length:
            self.send_json({"error": "empty audio body"}, status=400)
            return
        audio = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "audio/wav")
        speaker_id = (req.query.get("speaker_id") or ["default"])[0]
        try:
            result = voice.enroll(audio, speaker_id, content_type)
        except voice.VoiceError as e:
            self.send_json({"error": str(e)}, status=502)
            return
        self.send_json(result)

    def _g_voice_ws(self, req):
        """Hands-free listening WebSocket. The app streams short audio windows as
        binary frames; for each one we ask the GPU box to run wake-word + strict
        speaker verification, and push a JSON text frame back ONLY when the
        enrolled user actually says "Harman …":

            client -> (binary)  a self-contained WAV window (~1-3s of speech)
            server -> (text)    {"type":"utterance","text":"...", "score":0.79}
                                or {"type":"idle"} for windows that don't fire

        Keeping each window a complete WAV means the box can decode it standalone
        (no stream reassembly), and the app's on-device VAD only sends windows
        that actually contain speech — so this is cheap at rest."""
        from viewer.browser import WSServer
        speaker_id = (req.query.get("speaker_id") or ["default"])[0]
        ws = WSServer.upgrade(self)
        if not ws:
            return
        try:
            while True:
                op, payload = ws.recv()
                if op == 0x8:  # close
                    break
                if op == 0x1:  # a text frame = a small control message
                    try:
                        msg = json.loads(payload.decode("utf-8", "replace"))
                    except Exception:
                        continue
                    if msg.get("t") == "ping":
                        ws.send_text(json.dumps({"type": "pong"}))
                    continue
                if op != 0x2 or not payload:  # expect binary audio otherwise
                    continue
                try:
                    result = voice.segment(bytes(payload), speaker_id, "audio/wav")
                except voice.VoiceError as e:
                    ws.send_text(json.dumps({"type": "error", "error": str(e)}))
                    continue
                if result.get("wake") and result.get("match") and result.get("text"):
                    ws.send_text(json.dumps({
                        "type": "utterance",
                        "text": result.get("text", ""),
                        "score": result.get("score", 0.0),
                    }))
                elif result.get("wake") and result.get("unenrolled"):
                    ws.send_text(json.dumps({"type": "unenrolled"}))
                else:
                    ws.send_text(json.dumps({"type": "idle"}))
        except Exception:
            pass
        finally:
            ws.close()
