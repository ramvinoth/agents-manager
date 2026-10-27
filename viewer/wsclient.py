"""viewer.wsclient — the one outbound (client-role) WebSocket implementation.

Used by viewer.nemotron (GPU voice service) and viewer.relay (the encrypted
phone relay). Client-role means every outgoing frame is masked (RFC 6455 5.1);
viewer.browser.WSServer is the server-role side and CDP's WSConn is a
text-only client sized for that one call site.

Frames are parsed WITHOUT consuming the buffer until a whole frame is present,
so a socket read timeout mid-frame is harmless: the caller can use the timeout
as a keepalive tick (send a ping) and simply call recv() again.
"""
import base64
import os
import socket
import ssl
import struct
import threading
import time
from urllib.parse import urlsplit

OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class WSError(Exception):
    """Dial, handshake or framing failure, or the peer went away."""


class WSHandshakeError(WSError):
    """The server answered the upgrade with a non-101 status."""

    def __init__(self, status, line):
        super().__init__(line)
        self.status = status


class WSClient:
    """One connected client-role WebSocket. recv() and the send methods may be
    used from different threads; sends are serialised by a lock."""

    def __init__(self, sock, leftover=b""):
        self.sock = sock
        self.buf = leftover
        self.last_rx = time.monotonic()   # any frame, pongs included: liveness
        self._send_lock = threading.Lock()

    def _frame(self):
        """(fin, opcode, payload, consumed) for the frame at the head of buf,
        or None when buf does not yet hold a whole frame."""
        buf = self.buf
        if len(buf) < 2:
            return None
        b1, b2 = buf[0], buf[1]
        ln, pos = b2 & 0x7F, 2
        if ln == 126:
            if len(buf) < 4:
                return None
            ln, pos = struct.unpack("!H", buf[2:4])[0], 4
        elif ln == 127:
            if len(buf) < 10:
                return None
            ln, pos = struct.unpack("!Q", buf[2:10])[0], 10
        mask = None
        if b2 & 0x80:
            if len(buf) < pos + 4:
                return None
            mask, pos = buf[pos:pos + 4], pos + 4
        if len(buf) < pos + ln:
            return None
        payload = buf[pos:pos + ln]
        if mask:
            payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
        return bool(b1 & 0x80), b1 & 0x0F, payload, pos + ln

    def recv(self):
        """Return (opcode, payload) for the next whole text/binary/close
        message. Pings are answered; pongs and fragments are absorbed.
        socket.timeout propagates with no frame lost."""
        parts, first_op = [], None
        while True:
            frame = self._frame()
            if frame is None:
                chunk = self.sock.recv(65536)
                if not chunk:
                    raise WSError("connection closed")
                self.buf += chunk
                continue
            self.last_rx = time.monotonic()
            fin, opcode, payload, used = frame
            self.buf = self.buf[used:]
            if opcode == OP_PING:
                self._send(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CLOSE:
                return OP_CLOSE, payload
            if opcode in (OP_TEXT, OP_BINARY):
                first_op = opcode
            parts.append(payload)
            if fin and first_op is not None:
                return first_op, b"".join(parts)

    def _send(self, opcode, data):
        if isinstance(data, str):
            data = data.encode()
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        ln = len(data)
        if ln < 126:
            hdr = struct.pack("!BB", 0x80 | opcode, 0x80 | ln)
        elif ln < 65536:
            hdr = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, ln)
        else:
            hdr = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, ln)
        with self._send_lock:
            self.sock.sendall(hdr + mask + masked)

    def send_bytes(self, data):
        self._send(OP_BINARY, data)

    def send_text(self, data):
        self._send(OP_TEXT, data)

    def ping(self):
        self._send(OP_PING, b"")

    def close(self, code=1000):
        try:
            self._send(OP_CLOSE, struct.pack("!H", code))
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


def dial(url, headers=None, timeout=10):
    """Open a WebSocket to ws(s):// or http(s):// `url` (path + query kept)
    with extra handshake `headers`, and return a connected WSClient with the
    socket left in blocking mode (callers set their own read timeout).
    Raises WSHandshakeError on a non-101 answer, WSError on anything else."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https", "ws", "wss") or not parts.hostname:
        raise WSError("WebSocket URL must be ws(s):// or http(s):// with a host")
    tls = parts.scheme in ("https", "wss")
    host = parts.hostname
    port = parts.port or (443 if tls else 80)
    path = (parts.path or "/") + (("?" + parts.query) if parts.query else "")
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
    except OSError as e:
        raise WSError(f"unreachable: {e}")
    try:
        sock.settimeout(timeout)
        if tls:
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        host_hdr = host if parts.port is None else f"{host}:{port}"
        lines = [f"GET {path} HTTP/1.1", f"Host: {host_hdr}", "Upgrade: websocket",
                 "Connection: Upgrade",
                 "Sec-WebSocket-Key: " + base64.b64encode(os.urandom(16)).decode(),
                 "Sec-WebSocket-Version: 13"]
        for k, v in (headers or {}).items():
            if "\r" in k or "\n" in k or "\r" in str(v) or "\n" in str(v):
                raise WSError("header contains a line break")
            lines.append(f"{k}: {v}")
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise WSError("closed during handshake")
            buf += chunk
            if len(buf) > 65536:
                raise WSError("oversized handshake response")
    except WSError:
        sock.close()
        raise
    except OSError as e:
        sock.close()
        raise WSError(f"unreachable: {e}")
    head, _, rest = buf.partition(b"\r\n\r\n")
    status_line = head.split(b"\r\n", 1)[0].decode(errors="replace")
    try:
        status = int(status_line.split(" ", 2)[1])
    except (IndexError, ValueError):
        status = 0
    if status != 101:
        sock.close()
        raise WSHandshakeError(status, "handshake failed: " + status_line[:200])
    sock.settimeout(None)
    return WSClient(sock, leftover=rest)
