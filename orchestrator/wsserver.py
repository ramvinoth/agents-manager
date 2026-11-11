"""orchestrator.wsserver — the server side of a WebSocket, upgraded in place on
the plain HTTP server's socket (RFC 6455). The client role is orchestrator.wsclient.

Used by the live terminal, the browser live view, the event stream, canvas rooms,
voice and the relay."""
import base64
import hashlib
import struct
import threading

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"   # RFC6455 handshake magic


class WSServer:
    """Server side of a WebSocket, driving one HTTP handler's raw socket after
    a successful Upgrade. Client frames are masked (we unmask); ours aren't."""

    def __init__(self, sock):
        self.sock = sock
        self.buf = b""
        self.send_lock = threading.Lock()
        self.closed = False

    @classmethod
    def upgrade(cls, handler):
        key = handler.headers.get("Sec-WebSocket-Key")
        if not key or handler.headers.get("Upgrade", "").lower() != "websocket":
            handler.send_json({"error": "expected a WebSocket upgrade"}, status=400)
            return None
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        handler.send_response(101, "Switching Protocols")
        handler.send_header("Upgrade", "websocket")
        handler.send_header("Connection", "Upgrade")
        handler.send_header("Sec-WebSocket-Accept", accept)
        handler.end_headers()
        try:
            handler.wfile.flush()
        except Exception:
            pass
        return cls(handler.connection)

    def _recv_into(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise OSError("websocket closed")
        self.buf += chunk

    def _take(self, n):
        while len(self.buf) < n:
            self._recv_into()
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self, max_payload=None):
        """Return (opcode, data) for the next data/close frame; handles ping.
        A frame larger than `max_payload` raises OSError before it is read."""
        while True:
            b1, b2 = self._take(2)
            _fin, opcode = b1 & 0x80, b1 & 0x0F
            masked, ln = b2 & 0x80, b2 & 0x7F
            if ln == 126:
                ln = struct.unpack("!H", self._take(2))[0]
            elif ln == 127:
                ln = struct.unpack("!Q", self._take(8))[0]
            if max_payload is not None and ln > max_payload:
                raise OSError(f"websocket frame of {ln} bytes exceeds {max_payload}")
            mask = self._take(4) if masked else b"\x00\x00\x00\x00"
            payload = self._take(ln)
            if masked and ln:
                # XOR as one big integer: ~100x faster than a per-byte loop.
                key = (mask * (ln // 4 + 1))[:ln]
                payload = (int.from_bytes(payload, "big") ^ int.from_bytes(key, "big")).to_bytes(ln, "big")
            if opcode == 0x9:                       # ping -> pong
                self._send(0xA, payload)
                continue
            if opcode == 0x8:                       # close
                return 0x8, payload
            if opcode in (0x0, 0x1, 0x2):
                return opcode, payload

    def _send(self, opcode, data):
        if isinstance(data, str):
            data = data.encode()
        ln = len(data)
        if ln < 126:
            hdr = struct.pack("!BB", 0x80 | opcode, ln)
        elif ln < 65536:
            hdr = struct.pack("!BBH", 0x80 | opcode, 126, ln)
        else:
            hdr = struct.pack("!BBQ", 0x80 | opcode, 127, ln)
        with self.send_lock:
            if self.closed:
                return
            self.sock.sendall(hdr + data)

    def send_bytes(self, data):
        self._send(0x2, data)

    def send_text(self, data):
        self._send(0x1, data)

    def close(self):
        with self.send_lock:
            if self.closed:
                return
            self.closed = True
        try:
            self.sock.sendall(struct.pack("!BB", 0x88, 0))   # close frame
        except Exception:
            pass
