"""viewer.routes.voice — VoiceMixin: the voice call's speech endpoints.

Thin HTTP wrappers over viewer.voice (which delegates to the GPU speech service).
All are normal /api routes, so the standard session gate authenticates them.

  GET  /api/voice/tts/stream?text=...  -> live audio/aac stream (proxied from the
                        speech service's /synthesize_stream_aac). track-player does
                        a GET with an Authorization header, so this is a GET.
  GET  /api/voice/ws?mode=call|wakeguard  -> WebSocket. The app streams audio
                        windows (binary WAV frames); the GPU box transcribes each
                        and a JSON text frame comes back ({"type":"utterance"} or,
                        for barge-in wakeguard, {"type":"wake"}). See _g_voice_ws.
  POST /api/call/turn   body = {path, text, history?}  -> {reply, history, tools}.
                        One exchange with the fast call brain (viewer.callbrain).

  GET  /api/voice/nemotron/status         -> the Nemotron GPU service's /health,
                        passed through (see viewer.nemotron). A SEPARATE backend
                        from the sherpa-onnx voice above — turn-based, one call
                        at a time, no STT/TTS fallback.
  GET  /api/voice/nemotron/ws?path=<sess> -> WebSocket. See _g_voice_nemotron_ws.
"""
import json
import socket
import threading
import time
import urllib.request

from viewer import nemotron, voice
from viewer.config import SPEECH_SERVICE_URL, SPEECH_TIMEOUT, TTS_STREAM_URL
from viewer.speakable import speakable


class VoiceMixin:
    def _p_call_turn(self, req):
        """One spoken exchange with the call brain (viewer.callbrain). Body:
        {path, text, history?, mode?}. The brain answers small talk itself and
        hands real work to the session at `path` as a background turn; the reply
        comes back in ~1-2 s regardless of how long that work takes.
          -> {reply, history, tools}   history is echoed back on the next turn."""
        import os
        from pathlib import Path
        from viewer import callbrain
        from viewer.engine import extract_cwd
        body = self.read_body() or {}
        text = (body.get("text") or "").strip()
        full_path = self.resolve_session_quiet(body.get("path", ""))
        if not text or full_path is None:
            self.send_json({"error": "Session and text required"}, status=400)
            return
        cwd = extract_cwd(full_path)
        if not cwd or not os.path.isdir(cwd):
            cwd = str(Path.home())
        try:
            result = callbrain.call_turn(full_path.stem, cwd, body.get("mode", "acceptEdits"),
                                         text, body.get("history") or [])
        except RuntimeError as e:
            self.send_json({"error": str(e)}, status=409)
            return
        except Exception as e:
            self.send_json({"error": f"Call brain: {e}"}, status=502)
            return
        self.send_json(result)

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
        from viewer.browser import WSServer
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

    def _g_voice_nemotron_status(self, req):
        """GET /api/voice/nemotron/status -> the Nemotron service's /health,
        passed through as-is (see viewer.nemotron.status). Never raises past
        this point: a disabled or unreachable backend is a normal 200 body
        ({"enabled": false, ...} or an error string), not a 5xx surprise for
        a client that's just polling to decide whether to show the feature."""
        try:
            self.send_json(nemotron.status())
        except nemotron.NemotronError as e:
            self.send_json({"enabled": True, "installed": False, "ready": False,
                            "busy": False, "error": str(e)}, status=502)

    def _g_voice_nemotron_ws(self, req):
        """WebSocket for one Nemotron turn-based call.

            client -> (binary) one complete utterance, raw as recorded (m4a or
                                any ffmpeg-readable container) — the viewer
                                converts it, the phone never has to.
            server -> (text)   sanitized JSON `kind` events straight from the
                                service (ready / error / turn_end / ...);
                                `tool_call` is never forwarded — it fails the
                                turn closed instead (see viewer.nemotron).
            server -> (binary) for a turn_end, the reply WAV, sent BEFORE that
                                turn_end's JSON text frame — matching the
                                service's own wire order exactly, so the app
                                can rely on "binary, then its turn_end".

        Only a human at the UI may open this (never an autonomous MCP agent
        session) — placing a live call is a phone/UI action, not something an
        agent should be able to trigger on a caller's behalf. That is real
        per-caller authorization on top of resolve_session_quiet's path
        traversal/existence check (there is no separate session-ownership ACL
        anywhere else in the codebase to reuse — see /api/call/turn — so this
        route adds its own rather than pretending one exists elsewhere).

        One call at a time, viewer-side and service-side both: a second
        concurrent caller gets a clean {"kind":"error","message":"busy"} and
        the socket is closed — never left half-upgraded, never silently
        dropped to the old STT/TTS pipeline."""
        from viewer.browser import WSServer
        if req.principal is None or req.principal.get("kind") != "app":
            self.send_json({"error": "voice calls require an interactive session"}, status=403)
            return
        full_path = self.resolve_session_quiet((req.query.get("path") or [""])[0])
        if full_path is None:
            self.send_json({"error": "unknown session"}, status=404)
            return
        if not nemotron.enabled():
            self.send_json({"error": "Nemotron voicechat is not configured"}, status=502)
            return
        got_slot = nemotron.try_acquire_slot()
        ws = WSServer.upgrade(self)
        if not ws:
            if got_slot:
                nemotron.release_slot()
            return
        if not got_slot:
            try:
                ws.send_text(json.dumps({"kind": "error", "message": "busy"}))
            except Exception:
                pass
            ws.close()
            return
        upstream = None
        try:
            try:
                upstream = nemotron.open_upstream()
            except nemotron.NemotronError as e:
                ws.send_text(json.dumps({"kind": "error", "message": str(e)}))
                return

            def _relay_until(stop_kinds):
                """Forward upstream frames to the client until an event of one
                of `stop_kinds` (or error) has been sent. Returns that event,
                or None if the upstream went away."""
                while True:
                    try:
                        up_op, up_payload = upstream.recv()
                    except nemotron.NemotronError:
                        return None
                    if up_op == 0x2:               # binary reply audio first,
                        ws.send_bytes(up_payload)   # exactly as the service sent it
                        continue
                    if up_op != 0x1:
                        continue
                    try:
                        event = json.loads(up_payload.decode("utf-8", "replace"))
                    except Exception:
                        event = {"kind": "error", "message": "malformed upstream event"}
                    if isinstance(event, dict) and event.get("kind") == "tool_call":
                        # Defense in depth: the service itself already refuses to
                        # dispatch a tool_call (deploy/voicechat_service.py raises
                        # and turns it into its own {"kind":"error"} before this
                        # code ever sees it) — but never trust a single layer,
                        # so a tool_call reaching here (a future service bug, a
                        # rogue upstream) fails the turn closed too, never forwarded
                        # or acted on.
                        event = {"kind": "error", "message": "tool calls are not supported"}
                    event = nemotron.sanitize_event(event)
                    ws.send_text(json.dumps(event))
                    if event.get("kind") in stop_kinds or event.get("kind") == "error":
                        return event

            # The model loads per call: the phone must see `ready` BEFORE it is
            # allowed to send audio, so relay upstream first and only then start
            # reading the client. Reading the client first would deadlock a
            # correct client that waits for ready.
            first = _relay_until(("ready",))
            if first is None or first.get("kind") != "ready":
                return
            while True:
                op, payload = ws.recv()
                if op == 0x8:  # client closed — an acceptable end-of-call,
                    break      # no graceful {"cmd":"close"} handshake required
                if op != 0x2 or not payload:
                    continue   # only complete-utterance binary frames matter

                def _client_gone():
                    # Non-blocking peek at the client socket: a closed/reset
                    # connection reads as EOF (b"") or ECONNRESET here, without
                    # consuming any real frame data a later ws.recv() would
                    # need (MSG_PEEK), so this is safe to poll mid-conversion.
                    sock = getattr(ws, "sock", None)
                    if sock is None:
                        return False
                    try:
                        return sock.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b""
                    except BlockingIOError:
                        return False
                    except OSError:
                        return True

                try:
                    wav = nemotron.convert_to_wav16k(bytes(payload), cancel=_client_gone)
                except nemotron.NemotronError as e:
                    ws.send_text(json.dumps({"kind": "error", "message": str(e)}))
                    continue
                try:
                    upstream.send_bytes(wav)
                except Exception:
                    break
                if _relay_until(("turn_end",)) is None:
                    break
        except Exception as e:
            # A dropped client mid-frame lands here too; log rather than hide
            # it — a silent teardown is what let a broken loop look "fine".
            print(f"[voice.nemotron] call ended: {e!r}", flush=True)
        finally:
            nemotron.release_slot()
            if upstream is not None:
                upstream.close()
            ws.close()
