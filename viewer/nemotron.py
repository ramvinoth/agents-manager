"""viewer.nemotron — thin, single-slot client for the Nemotron turn-based
voicechat GPU service (see deploy/voicechat_service.py, deploy/voicechat.md).

This is a SEPARATE backend from viewer.voice (sherpa-onnx STT/TTS): one GPU
process owns one conversation for the lifetime of one WebSocket, and there is
no STT -> text-provider -> TTS fallback path — a Nemotron call either talks to
this service or fails closed, it never silently drops back to the older
segment()/wakeguard() pipeline.

NEMOTRON_URL / NEMOTRON_TOKEN_FILE are both empty by default (see
viewer/config.py): production stays disabled until explicitly pointed at a
deployed box. Nothing here ever hands the service token to a client — it is
read fresh from a private 0600 file (the same convention as
VIEWER_TOKEN_FILE/viewer/login.py) on each request and only ever placed in an
outbound Authorization header, never a URL, a log line, or a response body.
"""
import base64
import json
import os
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from viewer.config import NEMOTRON_TIMEOUT, NEMOTRON_TOKEN_FILE, NEMOTRON_URL

# Mirror the service's own input bound (deploy/voicechat_service.py MAX_INPUT)
# so the viewer rejects an oversized turn before ever dialing the GPU box,
# instead of forwarding garbage and letting the service's own validate_wav
# reject it (and pay the network round trip) later.
try:
    from deploy.voicechat_service import MAX_INPUT
except ImportError:  # pragma: no cover - deploy/ is always importable in this repo
    MAX_INPUT = 16000 * 2 * 30 + 4096

# The phone uploads compressed m4a, not raw PCM — a 30s utterance encodes to a
# few hundred KB, so this is generous headroom, not a real capacity estimate.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
CONVERT_TIMEOUT = 20      # seconds — ffmpeg on one short utterance
CANCEL_POLL = 0.25        # how often convert_to_wav16k checks its `cancel` callback
MAX_INPUT_SECONDS = 30    # matches the service's own per-turn cap (voicechat_service.turn)
# ffmpeg is asked to decode one second PAST the limit, not to it: -t 30 would
# silently truncate a 45s recording down to a clean, valid 30s WAV and forward
# it as if the user's whole utterance fit — the service would happily accept
# that lie. Decoding to 31s means an over-limit recording comes back palpably
# over 30*16000 frames, so convert_to_wav16k below can tell "genuinely fits"
# from "truncated" and reject the latter instead of forwarding a clipped turn.
_FFMPEG_DECODE_SECONDS = MAX_INPUT_SECONDS + 1
# Hard output-size floor for ffmpeg itself (-fs), independent of the MAX_INPUT
# check applied after the fact: bounds disk usage during conversion even if a
# malicious/malformed upload decodes to something far larger than any real
# 30s utterance would.
_FFMPEG_OUTPUT_CAP = MAX_INPUT + 65536
TURN_WAIT_TIMEOUT = 130   # > the service's own 120s per-turn deadline, so ITS
                         # {"kind":"error"} reaches the client before a generic
                         # proxy timeout would
CALL_LIFETIME = 900       # matches the service's own socket lifetime cap

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class NemotronError(Exception):
    """The Nemotron service could not be reached, or answered incorrectly.
    Callers surface this as a clear message — never a silent empty result."""


def enabled():
    """True only when BOTH the URL and a token file are configured. Either
    one missing means the feature is off, not half-broken."""
    return bool(NEMOTRON_URL) and bool(NEMOTRON_TOKEN_FILE)


def _token():
    """Read the shared service token fresh on every call. Never cached at
    import time (so rotating the file takes effect immediately) and never
    logged, returned to a client, or interpolated into a URL."""
    if not enabled():
        raise NemotronError("Nemotron voicechat is not configured")
    try:
        token = NEMOTRON_TOKEN_FILE.read_text().strip()
    except OSError as e:
        raise NemotronError(f"Nemotron token file unreadable: {e}")
    if not token:
        raise NemotronError("Nemotron token file is empty")
    return token


def _host_port(url):
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https", "ws", "wss"):
        raise NemotronError("Nemotron URL must be http(s):// or ws(s)://")
    tls = parts.scheme in ("https", "wss")
    host = parts.hostname
    port = parts.port or (443 if tls else 80)
    if not host:
        raise NemotronError("Nemotron URL has no host")
    return host, port, tls


def status():
    """GET /health on the service: identity, capability flags, and
    installed/ready/busy. `ready=false` while idle is EXPECTED — the model
    loads per call, so idle availability (installed) and call readiness
    (ready) are different signals; never collapse them into one boolean."""
    if not enabled():
        return {"enabled": False, "installed": False, "ready": False, "busy": False}
    token = _token()
    url = NEMOTRON_URL.rstrip("/") + "/health"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=NEMOTRON_TIMEOUT) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise NemotronError(f"Nemotron service {e.code}")
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise NemotronError(f"Nemotron service unreachable: {e}")
    if not isinstance(data, dict):
        raise NemotronError("Nemotron service returned a malformed /health response")
    data["enabled"] = True
    return data


# ===== single GPU slot, viewer side =====
# The service itself only holds one active call (deploy/voicechat_service.py
# rejects a second with close code 1013) — but that check happens only AFTER
# a viewer caller has already dialed in and possibly started uploading audio.
# This mirrors the same one-at-a-time rule on the viewer's side so a second
# concurrent caller gets an immediate, cheap "busy" without ever opening a
# socket to the GPU box.
_slot_lock = threading.Lock()
_slot_taken = False


def try_acquire_slot():
    global _slot_taken
    with _slot_lock:
        if _slot_taken:
            return False
        _slot_taken = True
        return True


def release_slot():
    global _slot_taken
    with _slot_lock:
        _slot_taken = False


def convert_to_wav16k(upload_bytes, timeout=CONVERT_TIMEOUT, cancel=None):
    """One complete phone-recorded utterance (m4a or any ffmpeg-readable
    container) -> mono 16 kHz PCM16 WAV bytes. ffmpeg writes to a private
    0600 temp file rather than stdout: stdout is a pipe, and a pipe is not
    seekable, so ffmpeg cannot go back and patch the RIFF/data chunk sizes
    once it knows the real frame count — it writes the WAV spec's documented
    fallback of 0xFFFFFFFF instead. That header lies about duration, and the
    GPU service's own validate_wav (deploy/voicechat_service.py) computes
    frames/rate from exactly that field, so every piped conversion would be
    rejected as exceeding the turn limit — no amount of upstream retrying
    fixes that; only a seekable output does. A temp file is also what makes
    the -fs (max output size) bound meaningful: ffmpeg enforces -fs against
    the file it is writing, not a pipe, and stops rather than accumulating
    unbounded frames in memory.

    argv list, not a shell: nothing in `upload_bytes` is ever interpreted.
    `-protocol_whitelist pipe` refuses any other input scheme an untrusted
    m4a container could smuggle in (e.g. a redirect to http/file/concat).
    Bounded on input size, output duration (-t), output size (-fs) and wall
    time; raises NemotronError rather than ever forwarding something the GPU
    service's own validate_wav would reject anyway.

    `cancel`, if given, is called every CANCEL_POLL seconds while ffmpeg runs;
    if it returns True (the caller's WebSocket has gone away) the subprocess
    is killed immediately instead of running to its full timeout — a
    disconnect during conversion frees the ffmpeg process right away rather
    than lingering for up to `timeout` seconds."""
    if not upload_bytes:
        raise NemotronError("empty audio upload")
    if len(upload_bytes) > MAX_UPLOAD_BYTES:
        raise NemotronError("audio upload too large")

    fd, out_path = tempfile.mkstemp(prefix="nemotron-turn-", suffix=".wav")
    os.close(fd)
    try:
        try:
            proc = subprocess.Popen(
                ["ffmpeg", "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                 "-protocol_whitelist", "pipe",
                 "-i", "pipe:0", "-map", "0:a:0", "-vn",
                 "-ac", "1", "-ar", "16000", "-sample_fmt", "s16",
                 "-t", str(_FFMPEG_DECODE_SECONDS), "-fs", str(_FFMPEG_OUTPUT_CAP),
                 "-f", "wav", out_path],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            raise NemotronError("ffmpeg is not installed on the viewer host")

        result = {}

        def _communicate():
            try:
                proc.communicate(input=upload_bytes, timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                result["timeout"] = True

        worker = threading.Thread(target=_communicate, daemon=True)
        worker.start()
        while worker.is_alive():
            worker.join(CANCEL_POLL)
            if worker.is_alive() and cancel is not None and cancel():
                proc.kill()
                worker.join(CONVERT_TIMEOUT)
                raise NemotronError("audio conversion cancelled (client disconnected)")
        if result.get("timeout"):
            raise NemotronError("audio conversion timed out")
        if proc.returncode != 0:
            raise NemotronError("audio conversion failed (bad or empty upload)")
        try:
            out = Path(out_path).read_bytes()
        except OSError:
            out = b""
        if not out:
            raise NemotronError("audio conversion failed (bad or empty upload)")
        if len(out) > MAX_INPUT:
            raise NemotronError("converted audio exceeds the service's turn limit")
        return out
    finally:
        try:
            os.unlink(out_path)
        except OSError:
            pass


# Transcript hygiene: the fork's raw model output starts assistant turns with
# BOS/EOS control tokens (</s><s>) that must never reach a UI as literal text.
_CONTROL_TOKENS = ("</s>", "<s>", "<pad>", "<unk>")


def _clean_text(value):
    if not isinstance(value, str):
        return value
    for tok in _CONTROL_TOKENS:
        value = value.replace(tok, "")
    return value.strip()


def sanitize_event(event):
    """A JSON event from the service, made safe to forward to the client:
    drop any field that could carry a server-side path (defence in depth —
    the service already pops path/audio, but never trust a single layer),
    and strip literal control tokens out of any transcript text so the UI
    never voices/renders raw </s><s>."""
    if not isinstance(event, dict):
        return {"kind": "error", "message": "malformed event"}
    clean = {}
    for key, value in event.items():
        if key in ("path", "audio", "cwd"):
            continue
        clean[key] = _clean_text(value) if isinstance(value, str) else value
    return clean


class _UpstreamWS:
    """Client-role WebSocket framing over a raw connected socket: masks
    outgoing frames (RFC 6455 requires it from a client), decodes incoming
    ones (the service does not mask). Deliberately self-contained rather than
    shared with viewer.browser.WSServer/WSConn — both of those are sized for
    their own call sites (server-role framing, and CDP's text-only client),
    and duplicating ~30 lines of frame parsing here is simpler than bending
    either to a third shape."""

    def __init__(self, sock, leftover=b""):
        self.sock = sock
        self.buf = leftover

    def _fill(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise NemotronError("Nemotron connection closed")
        self.buf += chunk

    def _take(self, n):
        while len(self.buf) < n:
            self._fill()
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        """Return (opcode, payload) for the next data/close frame."""
        while True:
            b1, b2 = self._take(2)
            opcode = b1 & 0x0F
            masked, ln = b2 & 0x80, b2 & 0x7F
            if ln == 126:
                ln = struct.unpack("!H", self._take(2))[0]
            elif ln == 127:
                ln = struct.unpack("!Q", self._take(8))[0]
            mask = self._take(4) if masked else None
            payload = self._take(ln)
            if mask:
                payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
            if opcode == 0x9:                       # ping -> pong
                self._send(0xA, payload)
                continue
            if opcode == 0x8:
                return 0x8, payload
            if opcode in (0x0, 0x1, 0x2):
                return opcode, payload

    def _send(self, opcode, data):
        """Mask and write one frame — a client-role socket MUST mask (RFC 6455
        5.1); the service-side WSServer in viewer/browser.py never does, so
        this cannot reuse that class's _send."""
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
        self.sock.sendall(hdr + mask + masked)

    def send_bytes(self, data):
        self._send(0x2, data)

    def send_text(self, data):
        self._send(0x1, data)

    def close(self):
        try:
            self._send(0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


def open_upstream(timeout=10):
    """Dial the Nemotron service's /call WebSocket with the Bearer token in
    the handshake headers (never a query param — those can end up in logs),
    and return a connected _UpstreamWS. Raises NemotronError on any failure
    (bad URL, TCP/TLS failure, non-101 handshake) so the caller can surface a
    clean 502 instead of a bare socket exception."""
    token = _token()
    host, port, tls = _host_port(NEMOTRON_URL)
    path = urlsplit(NEMOTRON_URL).path.rstrip("/") + "/call"
    sock = socket.create_connection((host, port), timeout=timeout)
    sock.settimeout(timeout)
    if tls:
        ctx = ssl.create_default_context()
        sock = ctx.wrap_socket(sock, server_hostname=host)
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Authorization: Bearer {token}\r\n"
        "\r\n"
    ).encode()
    try:
        sock.sendall(request)
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise NemotronError("Nemotron service closed the connection during handshake")
            buf += chunk
    except (OSError, socket.timeout) as e:
        sock.close()
        raise NemotronError(f"Nemotron service unreachable: {e}")
    head, _, rest = buf.partition(b"\r\n\r\n")
    status_line = head.split(b"\r\n", 1)[0]
    if b" 101" not in status_line:
        sock.close()
        if b" 401" in status_line or b" 403" in status_line:
            raise NemotronError("Nemotron service rejected the shared token")
        raise NemotronError("Nemotron handshake failed: " + status_line.decode(errors="replace")[:200])
    sock.settimeout(None)
    return _UpstreamWS(sock, leftover=rest)
