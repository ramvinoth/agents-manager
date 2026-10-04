"""viewer.relay + viewer.wsclient: the encrypted channel, header hygiene, the
control protocol, and real HTTP/WebSocket round trips through the mux onto a
throwaway loopback server. Hermetic: no relay, no DB, no network beyond
127.0.0.1.

Run with:  /usr/bin/python3 -m pytest tests/unit/test_relay.py -v
"""
import base64
import http.server
import json
import queue
import struct
import threading
import time

import nacl.bindings as nb
import pytest

from viewer import relay, wsclient
from viewer.browser import WSServer


# ---- the phone's half of the channel, written independently -----------------

class Phone:
    def __init__(self, server_pk):
        self.pk, self.sk = nb.crypto_box_keypair()
        self.key = nb.crypto_box_beforenm(server_pk, self.sk)
        self.tx = 0
        self.rx = 0

    def hello(self):
        return json.dumps({"type": "e2ee_hello", "key": base64.b64encode(self.pk).decode()})

    def seal(self, plaintext):
        nonce = bytes([0]) + b"\0" * 15 + struct.pack("!Q", self.tx)
        self.tx += 1
        return nonce + nb.crypto_box_afternm(plaintext, nonce, self.key)

    def open(self, frame):
        nonce = bytes([1]) + b"\0" * 15 + struct.pack("!Q", self.rx)
        assert frame[:24] == nonce
        self.rx += 1
        return nb.crypto_box_open_afternm(frame[24:], nonce, self.key)


def _server_keys():
    pk, sk = nb.crypto_box_keypair()
    return pk, sk


# ---- channel ----------------------------------------------------------------

def test_channel_round_trip_and_ready():
    pk, sk = _server_keys()
    ch, phone = relay.Channel(sk), Phone(pk)
    assert json.loads(ch.accept_hello(phone.hello())) == {"type": "e2ee_ready"}
    assert ch.open(phone.seal(b"hi")) == b"hi"
    assert phone.open(ch.seal(b"yo")) == b"yo"


def test_channel_repeated_hello_same_key_is_fine_different_key_is_fatal():
    pk, sk = _server_keys()
    ch, phone = relay.Channel(sk), Phone(pk)
    ch.accept_hello(phone.hello())
    ch.accept_hello(phone.hello())          # phone missed our ready, retries
    with pytest.raises(relay.ChannelError):
        ch.accept_hello(Phone(pk).hello())


def test_channel_rejects_replay_reorder_and_tamper():
    pk, sk = _server_keys()
    ch, phone = relay.Channel(sk), Phone(pk)
    ch.accept_hello(phone.hello())
    first, second = phone.seal(b"a"), phone.seal(b"b")
    with pytest.raises(relay.ChannelError):
        ch.open(second)                     # reordered
    ch.open(first)
    with pytest.raises(relay.ChannelError):
        ch.open(first)                      # replayed
    bad = bytearray(second)
    bad[-1] ^= 1
    with pytest.raises(relay.ChannelError):
        ch.open(bytes(bad))                 # tampered


def test_channel_rejects_frames_before_handshake_and_bad_hello():
    _, sk = _server_keys()
    ch = relay.Channel(sk)
    with pytest.raises(relay.ChannelError):
        ch.open(b"\0" * 64)
    for bad in ("nope", json.dumps({"type": "e2ee_hello", "key": "AAAA"}),
                json.dumps({"type": "other", "key": base64.b64encode(b"x" * 32).decode()})):
        with pytest.raises(relay.ChannelError):
            relay.Channel(sk).accept_hello(bad)


# ---- header hygiene ---------------------------------------------------------

def test_forward_headers_strips_spoofable_identity_and_sets_client_ip():
    out = relay.forward_headers({
        "Authorization": "Bearer t", "Content-Type": "application/json",
        "CF-Connecting-IP": "1.1.1.1", "X-Forwarded-For": "2.2.2.2",
        "X-Viewer-Session": "s", "X-Kanban-Token": "k", "Host": "evil",
        "Connection": "close", "X-Bad": "a\r\nInjected: 1",
    }, "203.0.113.9")
    assert out == {"Authorization": "Bearer t", "Content-Type": "application/json",
                   "CF-Connecting-IP": "203.0.113.9"}


def test_valid_path():
    assert relay._valid_path("/api/x?y=1")
    for bad in ("api/x", "//evil.com/x", "/a b", "/a\r\n", None):
        assert not relay._valid_path(bad)


# ---- control protocol -------------------------------------------------------

def test_handle_control_connected_sync_disconnected(monkeypatch):
    svc = relay.RelayService("wss://relay.example", {"serverId": "s" * 24, "token": "t" * 40,
                                                     "secretKey": base64.b64encode(b"\1" * 32).decode()})
    attached, detached = [], []
    monkeypatch.setattr(svc, "attach", lambda cid, ip="": (attached.append((cid, ip)),
                                                             svc.connections.setdefault(cid, object())))
    monkeypatch.setattr(svc, "detach", lambda cid: (detached.append(cid), svc.connections.pop(cid, None)))
    svc.handle_control(json.dumps({"type": "connected", "connectionId": "conn_a", "ip": "1.2.3.4"}))
    svc.handle_control(json.dumps({"type": "sync", "connections": [{"connectionId": "conn_b"}]}))
    svc.handle_control(json.dumps({"type": "disconnected", "connectionId": "conn_b"}))
    svc.handle_control("not json")
    assert attached == [("conn_a", "1.2.3.4"), ("conn_b", "")]
    assert detached == ["conn_a", "conn_b"]   # sync dropped the stale conn_a


# ---- the mux, end to end over loopback --------------------------------------

class _Upstream(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    seen = queue.Queue()

    def log_message(self, *a):
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.seen.put(dict(self.headers))
        if self.path == "/api/ws":
            ws = WSServer.upgrade(self)
            while True:
                op, payload = ws.recv()
                if op == 0x8:
                    break
                ws.send_text(b"echo:" + bytes(payload)) if op == 0x1 else ws.send_bytes(payload)
            ws.close()
            self.close_connection = True
            return
        if self.path == "/big":
            body = b"x" * (relay.CHUNK * 2 + 7)
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_json({"path": self.path})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        self.send_json({"echo": self.rfile.read(n).decode()})


@pytest.fixture
def upstream(monkeypatch):
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Upstream)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setattr(relay, "PORT", srv.server_address[1])
    while not _Upstream.seen.empty():
        _Upstream.seen.get()
    yield srv
    srv.shutdown()


class _FakeRelaySocket:
    """Stands in for the relay data socket: captures what the server sends."""

    def __init__(self):
        self.out = queue.Queue()

    def send_bytes(self, b):
        self.out.put(b)

    def send_text(self, t):
        self.out.put(t)

    def close(self):
        pass


def _connection():
    pk, sk = _server_keys()
    svc = relay.RelayService("wss://relay.example",
                             {"serverId": "s" * 24, "token": "t" * 40,
                              "secretKey": base64.b64encode(sk).decode()})
    conn = relay.Connection(svc, "conn_0123456789abcdef", "198.51.100.7")
    conn.ws = _FakeRelaySocket()
    phone = Phone(pk)
    conn.channel.accept_hello(phone.hello())
    return conn, phone


def _send(conn, phone, kind, stream, payload=b""):
    conn._dispatch(*relay.unpack(conn.channel.open(phone.seal(relay.pack(kind, stream, payload)))))


def _recv(conn, phone, timeout=5):
    return relay.unpack(phone.open(conn.ws.out.get(timeout=timeout)))


def _collect_http(conn, phone, stream):
    head, body = None, b""
    while True:
        kind, sid, payload = _recv(conn, phone)
        assert sid == stream
        if kind == relay.RES_HEAD:
            head = json.loads(payload)
        elif kind == relay.RES_BODY:
            body += payload
        elif kind == relay.RES_END:
            return head, body
        else:
            raise AssertionError((kind, payload))


def test_http_get_through_mux_with_sanitized_headers(upstream):
    conn, phone = _connection()
    _send(conn, phone, relay.HTTP_REQ, 1, json.dumps({
        "method": "GET", "path": "/api/me?x=1",
        "headers": {"Authorization": "Bearer tok", "X-Forwarded-For": "6.6.6.6",
                    "X-Viewer-Token": "forged"}}))
    _send(conn, phone, relay.HTTP_END, 1)
    head, body = _collect_http(conn, phone, 1)
    assert head["status"] == 200 and json.loads(body) == {"path": "/api/me?x=1"}
    seen = {k.lower(): v for k, v in _Upstream.seen.get(timeout=2).items()}
    assert seen["authorization"] == "Bearer tok"
    assert seen["cf-connecting-ip"] == "198.51.100.7"
    assert "x-forwarded-for" not in seen and "x-viewer-token" not in seen


def test_http_post_body_and_chunked_large_response(upstream):
    conn, phone = _connection()
    _send(conn, phone, relay.HTTP_REQ, 3, json.dumps({
        "method": "POST", "path": "/api/x", "headers": {"Content-Length": "5"}}))
    _send(conn, phone, relay.HTTP_BODY, 3, b"he")
    _send(conn, phone, relay.HTTP_BODY, 3, b"llo")
    _send(conn, phone, relay.HTTP_END, 3)
    head, body = _collect_http(conn, phone, 3)
    assert json.loads(body) == {"echo": "hello"}

    _send(conn, phone, relay.HTTP_REQ, 5, json.dumps({"method": "GET", "path": "/big"}))
    _send(conn, phone, relay.HTTP_END, 5)
    head, body = _collect_http(conn, phone, 5)
    assert len(body) == relay.CHUNK * 2 + 7


def test_invalid_requests_get_an_error_not_a_crash(upstream):
    conn, phone = _connection()
    _send(conn, phone, relay.HTTP_REQ, 7, json.dumps({"method": "TRACE", "path": "/x"}))
    kind, sid, payload = _recv(conn, phone)
    assert (kind, sid) == (relay.ERROR, 7)
    _send(conn, phone, relay.HTTP_REQ, 9, b"not json")
    assert _recv(conn, phone)[0] == relay.ERROR
    _send(conn, phone, relay.WS_OPEN, 11, json.dumps({"path": "/not-api"}))
    assert _recv(conn, phone)[0] == relay.ERROR


def test_stream_id_reuse_is_fatal(upstream):
    conn, phone = _connection()
    _send(conn, phone, relay.HTTP_REQ, 1, json.dumps({"method": "GET", "path": "/a"}))
    with pytest.raises(relay.ChannelError):
        _send(conn, phone, relay.HTTP_REQ, 1, json.dumps({"method": "GET", "path": "/a"}))


def test_websocket_through_mux(upstream):
    conn, phone = _connection()
    _send(conn, phone, relay.WS_OPEN, 2, json.dumps({"path": "/api/ws", "headers": {}}))
    _send(conn, phone, relay.WS_TEXT, 2, b"early")          # may arrive before the dial
    assert _recv(conn, phone)[:2] == (relay.WS_OPENED, 2)
    assert _recv(conn, phone) == (relay.WS_TEXT, 2, b"echo:early")
    _send(conn, phone, relay.WS_BINARY, 2, b"\x00\x01")
    assert _recv(conn, phone) == (relay.WS_BINARY, 2, b"\x00\x01")
    _send(conn, phone, relay.WS_CLOSE, 2, struct.pack("!H", 1000))
    kind, sid, payload = _recv(conn, phone)
    assert (kind, sid) == (relay.WS_CLOSE, 2)
    deadline = time.time() + 2
    while conn.streams and time.time() < deadline:
        time.sleep(0.02)
    assert conn.streams == {}


# ---- wsclient ---------------------------------------------------------------

def test_wsclient_dial_rejects_header_injection_and_reports_status(upstream):
    port = upstream.server_address[1]
    with pytest.raises(wsclient.WSError):
        wsclient.dial(f"ws://127.0.0.1:{port}/api/ws", {"X": "a\r\nB: c"})
    with pytest.raises(wsclient.WSHandshakeError) as e:
        wsclient.dial(f"ws://127.0.0.1:{port}/plain")
    assert e.value.status == 200


def test_wsclient_ping_then_echo(upstream):
    port = upstream.server_address[1]
    ws = wsclient.dial(f"ws://127.0.0.1:{port}/api/ws")
    ws.ping()
    ws.send_text("frag")
    assert ws.recv() == (wsclient.OP_TEXT, b"echo:frag")
    ws.close()
