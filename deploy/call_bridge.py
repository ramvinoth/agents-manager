"""harman-call-bridge — the GPU box's two loopback-only call engines on one LAN port.

The viewer (on the Mac) runs the live call (orchestrator/calllive.py) and speaks to
two engines that Speakrail keeps on 127.0.0.1: the LFM3 live-ASR adapter
(ws://127.0.0.1:8191/v1/transcribe) and the Breeze TTS server
(http://127.0.0.1:7860/v1/audio/speech). This bridge puts one Bearer-token-gated
port on the LAN (HARMAN_CALL_BRIDGE_PORT, default 18191) and fronts them:

  WS   /v1/transcribe     bidirectional relay to the ASR adapter: raw PCM frames
                          in, its JSON turn/transcript events out, verbatim
  POST /v1/audio/speech   {"text": "..."} -> Breeze's streaming request with the
                          box's reference voice injected here (the asset stays on
                          the box; the viewer sends text only), raw 24 kHz int16
                          PCM streamed back; if the caller disconnects mid-stream
                          the upstream request is dropped, which makes Breeze
                          abort generation — that is the barge-in
  POST /v1/chat/completions
                          the call brain: forwarded to Speakrail's Gemma vLLM
                          (HARMAN_CALL_BRAIN_URL), so a viewer off the box's tailnet
                          can still think
  GET  /health            {"ok", "asr", "tts"} — both engines reachable

Everything is gated on `Authorization: Bearer <HARMAN_CALL_TOKEN>`; the bridge
refuses to start without a token (the engines are sensitive and loopback-only by
design) or without the reference voice. The whole per-node configuration is the
box's LAN/Tailscale address plus this port; the viewer needs only HARMAN_CALL_*.

Env:
  HARMAN_CALL_TOKEN          Bearer token (required)
  HARMAN_CALL_BRIDGE_PORT    listen port (default 18191)
  HARMAN_CALL_ASR_URL        upstream ASR (default ws://127.0.0.1:8191/v1/transcribe)
  HARMAN_CALL_TTS_URL        upstream TTS (default http://127.0.0.1:7860/v1/audio/speech)
  HARMAN_CALL_VOICE          reference wav (default the Speakrail harness's female_a.wav;
                             its .txt sibling supplies the ref_text)
"""

import asyncio
import hmac
import os
import sys
import urllib.parse

from aiohttp import (
    ClientConnectionError,
    ClientConnectionResetError,
    ClientSession,
    ClientTimeout,
    FormData,
    WSMsgType,
    web,
)

TOKEN = os.environ.get("HARMAN_CALL_TOKEN", "")
PORT = int(os.environ.get("HARMAN_CALL_BRIDGE_PORT", "18191"))
ASR_URL = os.environ.get("HARMAN_CALL_ASR_URL", "ws://127.0.0.1:8191/v1/transcribe")
TTS_URL = os.environ.get("HARMAN_CALL_TTS_URL", "http://127.0.0.1:7860/v1/audio/speech")
BRAIN_URL = os.environ.get("HARMAN_CALL_BRAIN_URL",
                           "http://127.0.0.1:8000/v1/chat/completions")
VOICE = os.environ.get(
    "HARMAN_CALL_VOICE",
    os.path.expanduser("~/.speakrail/app/src/speakrail/harness/voices/female_a.wav"))
REF_TEXT = VOICE.rsplit(".", 1)[0] + ".txt"   # the harness convention: sibling .txt
SEED = 42      # the harness's fixed seed: stable timbre for a given voice
CFG_SCALE = 1.0


def authorized(req):
    return hmac.compare_digest(
        (req.headers.get("Authorization") or "").encode(),
        ("Bearer " + TOKEN).encode())


@web.middleware
async def gate(req, handler):
    # @web.middleware marks the modern (request, handler) contract: aiohttp
    # 3.14 calls an UNMARKED middleware old-style, as (app, handler), which
    # bound `req` to the Application and 500'd every request with
    # AttributeError. The marker is version-proof on 3.14+; on a venv that
    # predates it the import would fail loudly at startup, which is the
    # desired failure (an auth gate must never silently not run).
    if not authorized(req):
        return web.json_response({"error": "unauthorized"}, status=401)
    return await handler(req)


async def _session():
    """A client session for the lifetime of one call, closed when the call ends."""
    return ClientSession(timeout=ClientTimeout(sock_connect=5, total=None))


async def health(req):
    out = {"asr": False, "tts": False}
    async with await _session() as session:
        netloc = urllib.parse.urlparse(ASR_URL).netloc
        try:
            r = await session.get(f"http://{netloc}/health")
            out["asr"] = r.status == 200 and (await r.json()).get("ok") is True
            r.close()
        except Exception:
            pass
        try:
            r = await session.get(f"http://{urllib.parse.urlparse(TTS_URL).netloc}/")
            out["tts"] = r.status < 500
            r.close()
        except Exception:
            pass
    out["ok"] = out["asr"] and out["tts"]
    return web.json_response(out)


async def brain(req):
    """The call brain: an OpenAI chat-completions request, forwarded to Speakrail's
    Gemma vLLM (started with a tool-call parser, so `tools` pass through). The viewer's callbrain posts here, so the brain is reachable from a
    Mac that is not on the box's tailnet. Non-streaming, status and body verbatim."""
    try:
        body = await req.json()
    except ValueError:
        return web.json_response({"error": "invalid json"}, status=400)
    async with ClientSession(timeout=ClientTimeout(sock_connect=5, total=60)) as session:
        try:
            r = await session.post(BRAIN_URL, json=body)
            return web.Response(status=r.status, body=await r.read(),
                                content_type="application/json")
        except (ClientConnectionError, asyncio.TimeoutError):
            return web.json_response({"error": "brain unreachable"}, status=502)


async def relay_asr(req):
    """Client websocket <-> ASR adapter websocket, frames verbatim."""
    client = web.WebSocketResponse()     # 3.14: a plain object; only prepare() awaits
    if not client.can_prepare(req):
        return web.Response(status=426)
    await client.prepare(req)
    session = await _session()
    try:
        up = await session.ws_connect(ASR_URL)
    except Exception:
        await client.close(code=1011)
        return client

    async def c2u():
        async for msg in client:
            if msg.type == WSMsgType.TEXT:
                await up.send_str(msg.data)
            elif msg.type == WSMsgType.BINARY:
                await up.send_bytes(msg.data)
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED):
                break
        # the caller hung up: close the upstream so the adapter's own loop ends
        # instead of streaming into the void
        if not up.closed:
            await up.close()

    async def u2c():
        async for msg in up:
            if msg.type == WSMsgType.TEXT:
                await client.send_str(msg.data)
            elif msg.type == WSMsgType.BINARY:
                await client.send_bytes(msg.data)
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED):
                break
        # the adapter ended the session: closing the client here is what unblocks
        # c2u (gather cannot finish until both loops exit)
        if not client.closed:
            await client.close()

    try:
        await asyncio.gather(c2u(), u2c())
    finally:
        for w in (up, client):
            try:
                if not w.closed:
                    await w.close()
            except Exception:
                pass
        await session.close()
    return client


def _breeze_body(text):
    """The harness's Breeze request (harness/tts.py) as a multipart form:
    fields text/ref_text/seed/cfg_scale plus the reference wav as `ref_audio`
    (Breeze caches its codes by content hash). FormData is the right tool —
    aiohttp's MultipartWriter has no form-field helpers and a hand-rolled
    content-disposition here invites boundary bugs."""
    form = FormData()
    form.add_field("text", text)
    try:
        with open(REF_TEXT, encoding="utf-8") as f:
            form.add_field("ref_text", f.read().strip())
    except OSError:
        pass
    form.add_field("seed", str(SEED))
    form.add_field("cfg_scale", str(CFG_SCALE))
    # bytes, not a file object: FormData serializes at request time, after any
    # `with` block has closed its file
    with open(VOICE, "rb") as f:
        form.add_field("ref_audio", f.read(),
                       filename="ref.wav", content_type="audio/wav")
    return form


async def tts(req):
    body = await req.json()
    text = (body.get("text") or "").strip()
    if not text:
        return web.json_response({"error": "empty text"}, status=400)
    session = await _session()
    resp = None
    out = None
    try:
        for _ in range(75):     # 409 = a request we just killed is still releasing (~20-50 ms)
            try:
                resp = await session.post(TTS_URL, data=_breeze_body(text))
            except ClientConnectionError:
                return web.json_response({"error": "tts unreachable"}, status=502)
            if resp.status != 409:
                break
            await resp.release()
            await asyncio.sleep(0.02)
        if resp is None or resp.status != 200:
            detail = (await resp.text()).strip()[:200] if resp is not None else ""
            status = resp.status if resp is not None else "?"
            if resp is not None:
                resp.close()
                resp = None
            return web.json_response({"error": f"tts {status}: {detail}"}, status=502)
        out = web.StreamResponse(status=200)   # 3.14 dropped Response(chunked=)
        out.content_type = resp.headers.get("Content-Type", "audio/pcm")
        await out.prepare(req)
        try:
            async for chunk in resp.content.iter_any():
                if chunk:
                    await out.write(chunk)
            await out.write_eof()
        except (ClientConnectionResetError, ConnectionResetError):
            print("tts: caller closed mid-speech, upstream aborted", file=sys.stderr, flush=True)
    finally:
        # Also the barge-in path: when the caller hangs up mid-speech the write
        # raises, and closing the upstream makes Breeze abort the generation
        # (it watches its client's socket).
        if resp is not None:
            resp.close()
        await session.close()
    return out


def main():
    if not TOKEN:
        print("HARMAN_CALL_TOKEN not set: refusing to start with the engines open",
              file=sys.stderr)
        return 1
    if not os.path.exists(VOICE):
        print(f"reference voice not found: {VOICE}", file=sys.stderr)
        return 1
    app = web.Application(middlewares=[gate])
    app.router.add_get("/health", health)
    app.router.add_get("/v1/transcribe", relay_asr)
    app.router.add_post("/v1/audio/speech", tts)
    app.router.add_post("/v1/chat/completions", brain)
    print(f"call bridge on 0.0.0.0:{PORT} (asr={ASR_URL} tts={TTS_URL} brain={BRAIN_URL})",
          flush=True)
    web.run_app(app, host="0.0.0.0", port=PORT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
