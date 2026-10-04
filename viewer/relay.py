"""viewer.relay — reach this server from anywhere without exposing it.

The server dials OUT to a Harman relay (relay/ — a Cloudflare Worker +
Durable Object derived from Paseo's relay v2) and phones dial the same relay.
Nothing listens on the internet; no tunnel or port-forward per install.

    phone ──wss──> relay <──wss── this server ──http/ws──> 127.0.0.1:PORT

The relay only routes. Every byte after the handshake is NaCl-box encrypted
end to end (X25519 + XSalsa20-Poly1305): the phone learns this server's
public key from the pairing QR, so only this server can answer it. Inside the
encrypted channel a small mux replays the phone's HTTP requests and
WebSockets onto this server's own loopback port, so every route, auth check
and throttle runs exactly as for a direct client — the relay adds a path,
not a second API.

Sockets (relay protocol v2, see relay/src/index.ts):
  control  /ws?serverId=..&role=server               one; announces phones
  data     /ws?serverId=..&role=server&connectionId= one per phone

Channel handshake (Paseo-compatible shape): the phone repeats a plaintext
{"type":"e2ee_hello","key":<its ephemeral public key>} until it sees
{"type":"e2ee_ready"}; after that every frame is binary [nonce24][box]. Unlike
Paseo's random nonces, nonces here are a direction byte plus a counter and
must arrive strictly in order — a replayed or reordered frame is rejected and
the connection dropped.

Mux frame (plaintext inside one encrypted frame):
  [type u8][stream u32 big-endian][payload]
"""
import base64
import http.client
import json
import queue
import secrets
import socket
import struct
import threading
import time
from urllib.parse import urlencode

import nacl.bindings as nb
import nacl.exceptions

from viewer import db, wsclient
from viewer.config import PORT, RELAY_URL

# ---- mux frame types --------------------------------------------------------
HTTP_REQ = 0x01        # phone -> server  JSON {method, path, headers}
HTTP_BODY = 0x02       # phone -> server  request body chunk
HTTP_END = 0x03        # phone -> server  request body complete
RES_HEAD = 0x11        # server -> phone  JSON {status, headers}
RES_BODY = 0x12        # server -> phone  response body chunk
RES_END = 0x13         # server -> phone  response complete
ERROR = 0x14           # either way       utf-8 reason; ends the stream
WS_OPEN = 0x21         # phone -> server  JSON {path, headers}
WS_OPENED = 0x22       # server -> phone  (empty)
WS_TEXT = 0x23         # either way
WS_BINARY = 0x24       # either way
WS_CLOSE = 0x25        # either way       u16 close code
CANCEL = 0x30          # phone -> server  abandon the stream

CHUNK = 256 * 1024             # body chunk: far under the relay's 32 MiB frame cap
MAX_STREAMS = 32               # concurrent streams per phone
STREAM_QUEUE = 64              # request-body chunks buffered per stream (16 MiB)
PING_EVERY = 20                # seconds; protocol pings are free at the relay edge
DEAD_AFTER = 3 * PING_EVERY    # no frame (pongs included) for this long -> redial
HANDSHAKE_TIMEOUT = 30
MAX_BACKOFF = 60
METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}

# Headers never forwarded to the loopback server. Hop-by-hop ones are the
# relay bridge's own business; the rest are identities the PHONE must not be
# able to assert: client address (the throttle key is set from what the relay
# observed) and the agent-subprocess credential headers (agents never come in
# over the relay, so these can only be forgery).
_DROP_REQ = {"host", "connection", "keep-alive", "transfer-encoding", "upgrade",
             "te", "trailer", "proxy-authorization", "proxy-connection",
             "cf-connecting-ip", "x-real-ip", "forwarded", "true-client-ip",
             "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions",
             "sec-websocket-accept"}
_DROP_REQ_PREFIX = ("x-forwarded-", "x-viewer-", "x-kanban-")
_DROP_RES = {"connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer"}


class ChannelError(Exception):
    """Handshake failure, bad ciphertext, or an out-of-order nonce."""


# ---- identity ---------------------------------------------------------------

def identity():
    """This server's relay identity, created once and kept in settings:
    serverId (the relay routing key), a static X25519 keypair (the public half
    goes into pairing QRs) and the bearer token that pins the serverId at the
    relay so nobody who has seen a QR can impersonate this server there."""
    ident = db.setting_get("relay_identity")
    if ident and all(ident.get(k) for k in ("serverId", "publicKey", "secretKey", "token")):
        return ident
    pk, sk = nb.crypto_box_keypair()
    ident = {"serverId": secrets.token_urlsafe(18),
             "publicKey": base64.b64encode(pk).decode(),
             "secretKey": base64.b64encode(sk).decode(),
             "token": secrets.token_urlsafe(32)}
    db.setting_set("relay_identity", ident)
    return ident


def enabled():
    return bool(RELAY_URL)


def offer():
    """What a pairing QR needs to reach this server through the relay, or
    None when the relay is off. The secret key and relay token never leave."""
    if not enabled():
        return None
    ident = identity()
    return {"url": RELAY_URL, "serverId": ident["serverId"], "publicKey": ident["publicKey"]}


# ---- encrypted channel ------------------------------------------------------

def _nonce(direction, counter):
    return bytes([direction]) + b"\0" * 15 + struct.pack("!Q", counter)


class Channel:
    """The server side of one phone's E2E channel. Direction 0 is
    phone->server, 1 is server->phone; each side counts its own frames from 0,
    and the key is fresh per connection (the phone's key is ephemeral), so a
    (key, nonce) pair is never reused."""

    TO_SERVER, TO_PHONE = 0, 1

    def __init__(self, secret_key):
        self._sk = secret_key
        self.key = None
        self.peer_key = None
        self._rx = 0
        self._tx = 0
        self._tx_lock = threading.Lock()

    def accept_hello(self, text):
        """Process a plaintext hello; return the plaintext ready reply.
        A repeated hello with the SAME key (the phone missed our ready) is
        answered again; a different key on a live channel is an attack or a
        bug, either way fatal."""
        try:
            msg = json.loads(text)
            peer = base64.b64decode(msg["key"], validate=True)
        except (ValueError, KeyError, TypeError):
            raise ChannelError("malformed hello")
        if msg.get("type") != "e2ee_hello" or len(peer) != 32:
            raise ChannelError("malformed hello")
        if self.peer_key is not None:
            if peer != self.peer_key:
                raise ChannelError("hello key changed mid-connection")
        else:
            try:
                self.key = nb.crypto_box_beforenm(peer, self._sk)
            except Exception:  # low-order point -> libsodium refuses
                raise ChannelError("unusable peer key")
            self.peer_key = peer
        return json.dumps({"type": "e2ee_ready"})

    def seal(self, plaintext):
        with self._tx_lock:
            nonce = _nonce(self.TO_PHONE, self._tx)
            self._tx += 1
            return nonce + nb.crypto_box_afternm(plaintext, nonce, self.key)

    def open(self, frame):
        if self.key is None:
            raise ChannelError("encrypted frame before handshake")
        if len(frame) < 24 + 16 or frame[:24] != _nonce(self.TO_SERVER, self._rx):
            raise ChannelError("unexpected nonce (replayed, reordered or dropped frame)")
        try:
            plaintext = nb.crypto_box_open_afternm(frame[24:], frame[:24], self.key)
        except nacl.exceptions.CryptoError:
            raise ChannelError("frame failed authentication")
        self._rx += 1
        return plaintext


def pack(kind, stream, payload=b""):
    if isinstance(payload, str):
        payload = payload.encode()
    return struct.pack("!BI", kind, stream) + payload


def unpack(frame):
    if len(frame) < 5:
        raise ChannelError("short mux frame")
    kind, stream = struct.unpack("!BI", frame[:5])
    return kind, stream, frame[5:]


def forward_headers(headers, client_key):
    """Headers safe to replay onto loopback. `client_key` becomes
    CF-Connecting-IP: viewer.routes.auth trusts that header only from a
    loopback peer, which is exactly what makes the sign-in throttle count
    the phone's real address (as observed by the relay) instead of lumping
    every relayed phone into one 127.0.0.1 bucket."""
    out = {}
    for k, v in (headers or {}).items():
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        lk = k.lower()
        if lk in _DROP_REQ or lk.startswith(_DROP_REQ_PREFIX):
            continue
        if any(c in k + v for c in "\r\n\0") or not k.strip():
            continue
        out[k] = v
    out["CF-Connecting-IP"] = client_key
    return out


def _valid_path(path):
    return (isinstance(path, str) and path.startswith("/") and not path.startswith("//")
            and not any(c in path for c in " \r\n\0#"))


# ---- one phone --------------------------------------------------------------

class Connection:
    """One phone, one relay data socket, one encrypted channel, many streams."""

    def __init__(self, service, connection_id, ip):
        self.service = service
        self.connection_id = connection_id
        self.client_key = ip or f"relay:{connection_id}"
        self.ws = None
        self.channel = Channel(base64.b64decode(service.ident["secretKey"]))
        self.streams = {}            # stream id -> queue.Queue | wsclient.WSClient
        self.lock = threading.Lock()
        self.closed = threading.Event()

    # -- plumbing --
    def send(self, kind, stream, payload=b""):
        if self.closed.is_set():
            raise ChannelError("connection closed")
        self.ws.send_bytes(self.channel.seal(pack(kind, stream, payload)))

    def _send_quiet(self, kind, stream, payload=b""):
        try:
            self.send(kind, stream, payload)
        except Exception:
            pass

    def close(self):
        if self.closed.is_set():
            return
        self.closed.set()
        with self.lock:
            streams, self.streams = list(self.streams.values()), {}
        for s in streams:
            if isinstance(s, queue.Queue):
                s.put(None)
            else:
                s.close()
        if self.ws:
            self.ws.close()

    def run(self):
        try:
            self.ws = self.service.dial(connection_id=self.connection_id)
            self.ws.sock.settimeout(PING_EVERY)
            started = time.monotonic()
            while not self.closed.is_set():
                try:
                    op, payload = self.ws.recv()
                except socket.timeout:
                    if time.monotonic() - self.ws.last_rx > DEAD_AFTER:
                        break
                    if self.channel.key is None and time.monotonic() - started > HANDSHAKE_TIMEOUT:
                        break
                    self.ws.ping()
                    continue
                if op == wsclient.OP_CLOSE:
                    break
                if op == wsclient.OP_TEXT:
                    self.ws.send_text(self.channel.accept_hello(payload.decode("utf-8", "replace")))
                    continue
                self._dispatch(*unpack(self.channel.open(payload)))
        except (wsclient.WSError, ChannelError, OSError) as e:
            print(f"[relay] {self.connection_id} closed: {e}", flush=True)
        finally:
            self.close()
            self.service.forget(self)

    def _dispatch(self, kind, stream, payload):
        with self.lock:
            target = self.streams.get(stream)
        if kind in (HTTP_REQ, WS_OPEN):
            if target is not None:
                raise ChannelError("stream id reused")
            if len(self.streams) >= MAX_STREAMS:
                self._send_quiet(ERROR, stream, "too many concurrent requests")
                return
            try:
                spec = json.loads(payload)
            except ValueError:
                self._send_quiet(ERROR, stream, "malformed request")
                return
            if kind == HTTP_REQ:
                q = queue.Queue(STREAM_QUEUE)
                with self.lock:
                    self.streams[stream] = q
                worker = self._http
                args = (stream, spec, q)
            else:
                with self.lock:
                    self.streams[stream] = _PendingWS()
                worker = self._websocket
                args = (stream, spec)
            threading.Thread(target=worker, args=args, daemon=True,
                             name=f"relay-{self.connection_id}-{stream}").start()
            return
        if target is None:
            return                                   # stream already finished
        if kind in (CANCEL, WS_CLOSE):
            self._finish(stream)                     # the phone freed its slot already
        if isinstance(target, queue.Queue):
            if kind == HTTP_BODY:
                target.put(payload)
            elif kind in (HTTP_END, CANCEL):
                target.put(b"" if kind == HTTP_END else None)
        elif kind in (WS_TEXT, WS_BINARY, WS_CLOSE, CANCEL):
            target.forward(kind, payload)

    def _finish(self, stream):
        with self.lock:
            return self.streams.pop(stream, None)

    def _end(self, stream, kind, payload=b""):
        """Free the stream's slot, THEN send its last frame: the phone reuses
        the slot the moment it sees that frame, and must never be refused
        "too many concurrent requests" by a slot we were about to free."""
        self._finish(stream)
        self._send_quiet(kind, stream, payload)

    # -- HTTP --
    def _http(self, stream, spec, body):
        conn = None
        try:
            method = str(spec.get("method", "GET")).upper()
            path = spec.get("path")
            if method not in METHODS or not _valid_path(path):
                self._end(stream, ERROR, "invalid request")
                return
            conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=300)
            conn.putrequest(method, path, skip_accept_encoding=True)
            for k, v in forward_headers(spec.get("headers"), self.client_key).items():
                conn.putheader(k, v)
            conn.endheaders()
            while True:
                chunk = body.get()
                if chunk is None:                    # cancelled / connection gone
                    return
                if chunk == b"":
                    break
                conn.send(chunk)
            res = conn.getresponse()
            headers = {k: v for k, v in res.getheaders() if k.lower() not in _DROP_RES}
            self.send(RES_HEAD, stream, json.dumps({"status": res.status, "headers": headers}))
            while True:
                chunk = res.read1(CHUNK) if method != "HEAD" else b""
                if not chunk:
                    break
                with self.lock:
                    if stream not in self.streams:   # phone cancelled mid-body
                        return
                self.send(RES_BODY, stream, chunk)
            self._end(stream, RES_END)
        except (OSError, http.client.HTTPException) as e:
            self._end(stream, ERROR, f"server error: {e}")
        except ChannelError:
            pass
        finally:
            self._finish(stream)
            if conn:
                conn.close()

    # -- WebSocket --
    def _websocket(self, stream, spec):
        with self.lock:
            pending = self.streams.get(stream)
        up = None
        try:
            path = spec.get("path")
            if not _valid_path(path) or not path.startswith("/api/"):
                self._end(stream, ERROR, "invalid websocket path")
                return
            headers = forward_headers(spec.get("headers"), self.client_key)
            try:
                up = wsclient.dial(f"ws://127.0.0.1:{PORT}{path}", headers)
            except wsclient.WSHandshakeError as e:
                self._end(stream, ERROR, f"websocket refused ({e.status})")
                return
            if not pending.attach(up):               # phone gave up while we dialed
                return
            self.send(WS_OPENED, stream)
            while True:
                op, payload = up.recv()
                if op == wsclient.OP_CLOSE:
                    code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1000
                    self._end(stream, WS_CLOSE, struct.pack("!H", code))
                    return
                self.send(WS_TEXT if op == wsclient.OP_TEXT else WS_BINARY, stream, payload)
        except (wsclient.WSError, OSError, ChannelError):
            self._end(stream, WS_CLOSE, struct.pack("!H", 1011))
        finally:
            self._finish(stream)
            if up:
                up.close()


class _PendingWS:
    """A loopback WebSocket that may still be dialing: frames from the phone
    that arrive first are held, and a close/cancel before it is up wins."""

    def __init__(self):
        self.ws = None
        self.held = []
        self.cancelled = False
        self.lock = threading.Lock()

    def attach(self, ws):
        with self.lock:
            if self.cancelled:
                return False
            self.ws = ws
            held, self.held = self.held, []
        for kind, payload in held:
            self._deliver(kind, payload)
        return True

    def forward(self, kind, payload):
        with self.lock:
            if self.ws is None:
                if kind in (WS_CLOSE, CANCEL):
                    self.cancelled = True
                else:
                    self.held.append((kind, payload))
                return
        self._deliver(kind, payload)

    def _deliver(self, kind, payload):
        try:
            if kind == WS_TEXT:
                self.ws.send_text(payload)
            elif kind == WS_BINARY:
                self.ws.send_bytes(payload)
            else:
                self.close()
        except OSError:
            self.close()

    def close(self):
        with self.lock:
            self.cancelled = True
            ws = self.ws
        if ws:
            ws.close()


# ---- the control loop -------------------------------------------------------

class RelayService:
    def __init__(self, relay_url, ident):
        self.relay_url = relay_url.rstrip("/")
        self.ident = ident
        self.connections = {}
        self.lock = threading.Lock()

    def dial(self, connection_id=None):
        params = {"serverId": self.ident["serverId"], "role": "server"}
        if connection_id:
            params["connectionId"] = connection_id
        return wsclient.dial(f"{self.relay_url}/ws?{urlencode(params)}",
                             {"Authorization": "Bearer " + self.ident["token"]})

    def attach(self, connection_id, ip=""):
        with self.lock:
            if connection_id in self.connections:
                return
            conn = Connection(self, connection_id, ip)
            self.connections[connection_id] = conn
        threading.Thread(target=conn.run, daemon=True, name=f"relay-{connection_id}").start()

    def detach(self, connection_id):
        with self.lock:
            conn = self.connections.pop(connection_id, None)
        if conn:
            conn.close()

    def forget(self, conn):
        with self.lock:
            if self.connections.get(conn.connection_id) is conn:
                del self.connections[conn.connection_id]

    def handle_control(self, text):
        try:
            msg = json.loads(text)
        except ValueError:
            return
        kind = msg.get("type")
        if kind == "connected" and isinstance(msg.get("connectionId"), str):
            self.attach(msg["connectionId"], str(msg.get("ip") or ""))
        elif kind == "disconnected" and isinstance(msg.get("connectionId"), str):
            self.detach(msg["connectionId"])
        elif kind == "sync" and isinstance(msg.get("connections"), list):
            live = {c.get("connectionId"): str(c.get("ip") or "")
                    for c in msg["connections"] if isinstance(c, dict)}
            with self.lock:
                stale = [cid for cid in self.connections if cid not in live]
            for cid in stale:
                self.detach(cid)
            for cid, ip in live.items():
                if isinstance(cid, str):
                    self.attach(cid, ip)

    def run_forever(self):
        backoff = 1
        while True:
            ws = None
            try:
                ws = self.dial()
                ws.sock.settimeout(PING_EVERY)
                print(f"[relay] connected to {self.relay_url} as {self.ident['serverId']}", flush=True)
                backoff = 1
                while True:
                    try:
                        op, payload = ws.recv()
                    except socket.timeout:
                        if time.monotonic() - ws.last_rx > DEAD_AFTER:
                            raise wsclient.WSError("control socket silent")
                        ws.ping()
                        continue
                    if op == wsclient.OP_CLOSE:
                        raise wsclient.WSError("relay closed the control socket")
                    if op == wsclient.OP_TEXT:
                        self.handle_control(payload.decode("utf-8", "replace"))
            except wsclient.WSHandshakeError as e:
                # 403 = another install holds this serverId's pin: retrying fast
                # cannot fix it, so back off fully and say why.
                print(f"[relay] refused by relay: {e}", flush=True)
                backoff = MAX_BACKOFF
            except (wsclient.WSError, OSError) as e:
                print(f"[relay] control lost: {e}; retrying in {backoff}s", flush=True)
            finally:
                if ws:
                    ws.close()
            time.sleep(backoff + secrets.randbelow(1000) / 1000)
            backoff = min(backoff * 2, MAX_BACKOFF)


def start():
    """Start the relay client in the background if HARMAN_RELAY_URL is set.
    Called only by the live server (never a VIEWER_PREFLIGHT spare: a spare
    would replace the live server's control socket at the relay)."""
    if not enabled():
        return None
    service = RelayService(RELAY_URL, identity())
    threading.Thread(target=service.run_forever, daemon=True, name="relay-control").start()
    return service
