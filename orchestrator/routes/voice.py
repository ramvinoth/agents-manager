"""orchestrator.routes.voice — VoiceMixin: the voice call's speech endpoints.

Thin HTTP wrappers over orchestrator.voice (which delegates to the GPU speech service).
All are normal /api routes, so the standard session gate authenticates them.

  GET  /api/voice/tts/stream?text=...  -> live audio/aac stream (proxied from the
                        speech service's /synthesize_stream_aac). track-player does
                        a GET with an Authorization header, so this is a GET.
  GET  /api/voice/ws?mode=call|wakeguard  -> WebSocket. The app streams audio
                        windows (binary WAV frames); the GPU box transcribes each
                        and a JSON text frame comes back ({"type":"utterance"} or,
                        for barge-in wakeguard, {"type":"wake"}). See _g_voice_ws.
  GET  /api/call/engine -> {engine: "brain", model?, error?}. The call brain's
                        model name, or why no brain is configured
                        (orchestrator.callbrain.engine).
  POST /api/call/turn   body = {path, text, history?}  -> {reply, history, tools}
                        or, on LFM3-Audio, {audio, next, history, tools}.
                        One exchange with the fast call brain (orchestrator.callbrain).
  GET  /api/call/audio?path=..&id=..  -> live audio/aac of one spoken segment
                        (proxied from the LFM3 service's /audio/<id>).
  POST /api/call/next   body = {path, next, stop?}  -> {said, history, tools}
                        (+ {audio, next} or {reply} when the answer goes on). The
                        phone posts it when a segment finished playing or, with
                        stop, when the owner barged in (callbrain.lfm3_next).

"""
import json
import urllib.request

from orchestrator import voice
from orchestrator.config import LFM3_SERVICE_URL, SPEECH_SERVICE_URL, SPEECH_TIMEOUT, TTS_STREAM_URL
from orchestrator.speakable import speakable


class VoiceMixin:
    def _g_call_engine(self, req):
        from orchestrator import callbrain
        self.send_json(callbrain.engine())

    def _p_call_turn(self, req):
        """One spoken exchange with the call brain (orchestrator.callbrain). Body:
        {path, text, history?}. The brain answers from a live system snapshot and
        works the board (delegate / check / comment / decide) under the CALLER's
        principal — the human on the phone — so the reply comes back in ~1-3 s
        and every request survives the call as a card.
          -> {reply, history, tools}   history is echoed back on the next turn."""
        from orchestrator import callbrain
        body = self.read_body() or {}
        text = (body.get("text") or "").strip()
        full_path = self.resolve_session_quiet(body.get("path", ""))
        if not text or full_path is None:
            self.send_json({"error": "Session and text required"}, status=400)
            return
        turn = callbrain.lfm3_turn if LFM3_SERVICE_URL else callbrain.call_turn
        try:
            result = turn(full_path.stem, req.principal, text, body.get("history") or [])
        except RuntimeError as e:
            self.send_json({"error": str(e)}, status=409)
            return
        except Exception as e:
            self.send_json({"error": f"Call brain: {e}"}, status=502)
            return
        self.send_json(result)

    def _p_call_next(self, req):
        from orchestrator import callbrain
        body = self.read_body() or {}
        full_path = self.resolve_session_quiet(body.get("path", ""))
        if full_path is None or not body.get("next"):
            self.send_json({"error": "Session and next required"}, status=400)
            return
        try:
            self.send_json(callbrain.lfm3_next(full_path.stem, str(body["next"]),
                                               stop=bool(body.get("stop"))))
        except LookupError as e:
            self.send_json({"error": str(e)}, status=404)

    def _g_call_audio(self, req):
        """Stream one spoken segment. Only a segment pending for THIS session is
        served, so an id alone never reaches another chat's audio."""
        from orchestrator import callbrain
        full_path = self.resolve_session_quiet((req.query.get("path") or [""])[0])
        seg = (req.query.get("id") or [""])[0]
        if full_path is None or not callbrain.owns_segment(full_path.stem, seg):
            self.send_json({"error": "unknown call segment"}, status=404)
            return
        self._proxy_aac(urllib.request.Request(
            LFM3_SERVICE_URL.rstrip("/") + f"/audio/{seg}"), timeout=callbrain.LFM3_TIMEOUT)

    def _proxy_aac(self, upstream, timeout):
        try:
            resp = urllib.request.urlopen(upstream, timeout=timeout)
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
        text = speakable(text) or text
        base = TTS_STREAM_URL or SPEECH_SERVICE_URL
        if not base:
            self.send_json({"error": "voice disabled"}, status=502)
            return
        url = base.rstrip("/") + "/synthesize_stream_aac"
        body = json.dumps({"text": text}).encode("utf-8")
        self._proxy_aac(urllib.request.Request(url, data=body, method="POST",
                                               headers={"Content-Type": "application/json"}),
                        timeout=SPEECH_TIMEOUT)

    def _g_voice_ws(self, req):
        """The call's listening WebSocket. The app streams short audio windows as
        binary frames; for each one the GPU box transcribes (or, in wakeguard
        mode, spots the wake word) and a JSON text frame comes back:

            client -> (binary)  a self-contained WAV window (one utterance)
            server -> (text)    mode=call:      {"type":"utterance","text":...}
                                mode=wakeguard: {"type":"wake","text":<tail>}
                                or {"type":"idle"} for windows that don't fire

        Keeping each window a complete WAV means the box can decode it standalone
        (no stream reassembly), and the app's on-device endpointer only sends
        windows that actually contain speech — so this is cheap at rest.

        mode=call: an active phone call the user placed is itself the identity and
        intent signal, so any speech with words fires — no wake word, no
        per-utterance speaker match (a biometric match every turn was both
        overkill and, in practice, what blocked calls: live scores sat below
        threshold).
        mode=wakeguard: barge-in while Harman speaks. The device sends
        echo-cancelled windows; only "Harman …" matters (AEC already removed
        Harman's own voice), and the tail after the wake word is the command."""
        from orchestrator.browser import WSServer
        speaker_id = (req.query.get("speaker_id") or ["default"])[0]
        wakeguard_mode = (req.query.get("mode") or ["call"])[0] == "wakeguard"
        ws = WSServer.upgrade(self)
        if not ws:
            return
        n_win = 0
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
                n_win += 1
                if wakeguard_mode:
                    try:
                        wg = voice.wakeguard(bytes(payload), "audio/wav")
                    except voice.VoiceError as e:
                        print(f"[voice.ws] wakeguard error (win {n_win}): {e}", flush=True)
                        ws.send_text(json.dumps({"type": "error", "error": str(e)}))
                        continue
                    if wg.get("wake"):
                        print(f"[voice.ws] wakeguard win={n_win} WAKE text={wg.get('text','')!r}", flush=True)
                        ws.send_text(json.dumps({"type": "wake", "text": wg.get("text", "")}))
                    else:
                        ws.send_text(json.dumps({"type": "idle"}))
                    continue
                try:
                    result = voice.segment(bytes(payload), speaker_id, "audio/wav", no_wake=True)
                except voice.VoiceError as e:
                    print(f"[voice.ws] segment error (win {n_win}): {e}", flush=True)
                    ws.send_text(json.dumps({"type": "error", "error": str(e)}))
                    continue
                # Diagnostic: every window's verdict, so a "stuck on Listening" can be
                # traced to whether windows arrive and what they transcribe to.
                print(f"[voice.ws] win={n_win} bytes={len(payload)} speech={result.get('speech')} "
                      f"text={result.get('text','')!r}", flush=True)
                if result.get("speech") and result.get("text"):
                    ws.send_text(json.dumps({"type": "utterance", "text": result.get("text", "")}))
                else:
                    ws.send_text(json.dumps({"type": "idle"}))
        except Exception:
            pass
        finally:
            print(f"[voice.ws] closed after {n_win} windows", flush=True)
            ws.close()
