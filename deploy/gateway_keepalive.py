#!/usr/bin/env python3
"""
Keep-alive front for the GPU model gateway (llama-swap), between the
Cloudflare tunnel and the gateway.

Cloudflare answers 524 when a proxied origin sends nothing for 125 s (its
Proxy Read Timeout, the same on every plan below Enterprise). A long prompt's
prefill, a wait in the engine's queue or a cold model load is silent that
long, so long-context chats died at two minutes. On a streaming
POST .../v1/messages this proxy keeps bytes flowing:

- Gateway still silent after HEADER_GRACE: answer 200 text/event-stream
  ourselves and send SSE comments until it replies. A gateway error that comes
  later is sent as an Anthropic `event: error` frame. Fast errors keep their
  real status (a 400 "prompt is too long" is how Claude Code knows to
  compact), because they arrive inside the grace.
- Gateway streaming but quiet for PING_EVERY: send a comment, only between
  events so one is never split.

SSE parsers ignore comment lines, so clients see an ordinary stream. Every
other request passes through untouched.

  HARMAN_KA_LISTEN        host:port to serve        (127.0.0.1:8079)
  HARMAN_KA_UPSTREAM      the gateway               (http://127.0.0.1:8080)
  HARMAN_KA_PING_EVERY    seconds between pings     (15)
  HARMAN_KA_HEADER_GRACE  seconds before we commit  (20)
"""
import asyncio
import json
import os

try:
    from aiohttp import ClientSession, ClientTimeout, web
except ImportError:  # the box has it; the pure helpers are unit-tested where it isn't
    ClientSession = ClientTimeout = web = None

PING = b": keep-alive\n\n"
# Hop-by-hop headers, plus the ones that would be wrong once we re-stream:
# lengths change (chunked), and a compressed stream can't take injected pings.
_DROP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
         "te", "trailer", "trailers", "transfer-encoding", "upgrade", "host",
         "content-length", "accept-encoding"}


def wants_keepalive(method, path, body):
    """Only streaming Messages calls are long and silent; all else passes."""
    if method != "POST" or not path.rstrip("/").endswith("/v1/messages"):
        return False
    try:
        return json.loads(body).get("stream") is True
    except (ValueError, AttributeError):
        return False


def at_boundary(chunk, prev):
    """True when the bytes sent so far end on an SSE event boundary."""
    tail = (prev + chunk)[-4:]
    return tail.endswith(b"\n\n") or tail.endswith(b"\r\n\r\n")


def error_event(status, body):
    """An Anthropic stream error frame for a gateway error after we committed."""
    try:
        err = json.loads(body)["error"]
        assert isinstance(err, dict)
    except Exception:
        text = body.decode("utf-8", "replace") if isinstance(body, bytes) else str(body)
        kind = "overloaded_error" if status in (502, 503, 504, 529) else "api_error"
        err = {"type": kind, "message": f"gateway {status}: {text[:2000]}"}
    payload = json.dumps({"type": "error", "error": err})
    return f"event: error\ndata: {payload}\n\n".encode()


def _headers(src):
    return {k: v for k, v in src.items() if k.lower() not in _DROP}


class Proxy:
    def __init__(self, upstream, ping_every=15.0, header_grace=20.0):
        self.upstream = upstream.rstrip("/")
        self.ping_every = ping_every
        self.header_grace = header_grace
        self.session = None

    async def start(self, _app=None):
        # No total timeout: a turn may legitimately stream for many minutes.
        self.session = ClientSession(auto_decompress=False,
                                     timeout=ClientTimeout(total=None, sock_connect=10))

    async def stop(self, _app=None):
        await self.session.close()

    async def handle(self, request):
        body = await request.read()
        send = self.session.request(request.method, self.upstream + request.path_qs,
                                    headers=_headers(request.headers), data=body,
                                    allow_redirects=False)
        if not wants_keepalive(request.method, request.path, body):
            async with send as resp:
                return await self._relay(request, resp)
        return await self._keepalive(request, asyncio.ensure_future(send))

    async def _relay(self, request, resp):
        out = web.StreamResponse(status=resp.status, reason=resp.reason,
                                 headers=_headers(resp.headers))
        await out.prepare(request)
        async for chunk in resp.content.iter_any():
            await out.write(chunk)
        await out.write_eof()
        return out

    async def _keepalive(self, request, pending):
        resp = None
        try:
            done, _ = await asyncio.wait({pending}, timeout=self.header_grace)
            if done:
                resp = pending.result()
                if resp.status != 200:
                    return await self._relay(request, resp)
                out = web.StreamResponse(status=200, headers=_headers(resp.headers))
                await out.prepare(request)
            else:
                out = web.StreamResponse(status=200, headers={
                    "Content-Type": "text/event-stream", "Cache-Control": "no-cache"})
                await out.prepare(request)
                while not pending.done():
                    await out.write(PING)
                    await asyncio.wait({pending}, timeout=self.ping_every)
                try:
                    resp = pending.result()
                except Exception as e:
                    await out.write(error_event(502, str(e)))
                    await out.write_eof()
                    return out
                if resp.status != 200:
                    await out.write(error_event(resp.status, await resp.read()))
                    await out.write_eof()
                    return out
            await self._pump(resp, out)
            await out.write_eof()
            return out
        finally:
            # Client gone or done: close the gateway side too, so the engine
            # aborts the request and frees its slot.
            if not pending.done():
                pending.cancel()
            if resp is not None:
                resp.close()

    async def _pump(self, resp, out):
        sent, boundary = b"", True
        read = asyncio.ensure_future(resp.content.readany())
        try:
            while True:
                done, _ = await asyncio.wait({read}, timeout=self.ping_every)
                if not done:
                    if boundary:
                        await out.write(PING)
                    continue
                chunk = read.result()
                if not chunk:
                    return
                await out.write(chunk)
                boundary = at_boundary(chunk, sent)
                sent = (sent + chunk)[-4:]
                read = asyncio.ensure_future(resp.content.readany())
        finally:
            read.cancel()


def make_app(proxy):
    app = web.Application(client_max_size=256 * 1024 * 1024)  # long prompts are MBs
    app.on_startup.append(proxy.start)
    app.on_cleanup.append(proxy.stop)
    app.router.add_route("*", "/{tail:.*}", proxy.handle)
    return app


def main():
    host, port = os.environ.get("HARMAN_KA_LISTEN", "127.0.0.1:8079").rsplit(":", 1)
    proxy = Proxy(os.environ.get("HARMAN_KA_UPSTREAM", "http://127.0.0.1:8080"),
                  float(os.environ.get("HARMAN_KA_PING_EVERY", "15")),
                  float(os.environ.get("HARMAN_KA_HEADER_GRACE", "20")))
    web.run_app(make_app(proxy), host=host, port=int(port),
                handler_cancellation=True, access_log=None)


if __name__ == "__main__":
    main()
