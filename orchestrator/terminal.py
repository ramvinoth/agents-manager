"""orchestrator.terminal — a real interactive shell per host, streamed to xterm.js.

Local uses orchestrator.ptyproc + the login shell (same seam as the login flow);
remote uses paramiko invoke_shell() over the pooled SSH connection. The transport
is a WebSocket (orchestrator.wsserver): server→client frames are raw PTY output
(binary), client→server frames are JSON control (input/resize)."""
import json
import os
import threading
import time

from orchestrator import ptyproc
from orchestrator.remote import SSH
from orchestrator.wsserver import WSServer


class TerminalSession:
    """A PTY-backed shell, local or remote, with a uniform read/write/resize."""

    def __init__(self, hid, cols=80, rows=24):
        self.hid = hid
        self.remote = hid != "local"
        cols, rows = max(2, int(cols)), max(1, int(rows))
        if self.remote:
            with SSH.lock_for(hid):
                c = SSH.get(hid)
                self.chan = c["client"].invoke_shell(term="xterm-256color", width=cols, height=rows)
            self.chan.settimeout(None)
        else:
            env = {**os.environ, "TERM": "xterm-256color"}
            try:  # per-host env vars (e.g. GH_TOKEN) — given to the child, never echoed
                from orchestrator.hostenv import host_env
                env.update(host_env("local"))
            except Exception:
                pass
            argv, fallback = ptyproc.login_shell(env)
            self.proc = ptyproc.spawn(argv, cols, rows, env=env, fallback=fallback)

    def read(self):
        """Blocking read of terminal output; b'' on EOF."""
        try:
            if self.remote:
                return self.chan.recv(65536)
            return self.proc.read(65536)
        except OSError:
            return b""

    def write(self, data):
        if isinstance(data, str):
            data = data.encode("utf-8", "replace")
        try:
            if self.remote:
                self.chan.send(data)
            else:
                self.proc.write(data)
        except OSError:
            pass

    def resize(self, cols, rows):
        cols, rows = max(2, int(cols)), max(1, int(rows))
        try:
            if self.remote:
                self.chan.resize_pty(width=cols, height=rows)
            else:
                self.proc.resize(cols, rows)
        except OSError:
            pass

    def close(self):
        try:
            if self.remote:
                self.chan.close()
            else:
                self.proc.close()
                self.proc.kill()
                self.proc.wait()
        except OSError:
            pass


# ---- Persistent, reattachable terminals --------------------------------------
# A PTY that outlives any single WebSocket. A reader thread always drains it into
# a ring buffer (so it never blocks when no browser is attached), and a client
# that (re)connects replays recent output and keeps the SAME running process:
# a browser refresh, a new tab, or a second device all reattach to the same
# session, so an interactive `copilot` mid-task stays alive. Keyed by `key`
# (defaults to the host) — one persistent terminal per key.
TERM_SESSIONS = {}          # key -> PersistentTerminal
TERM_REGISTRY_LOCK = threading.Lock()
TERM_BUFFER_MAX = 512 * 1024


class PersistentTerminal:
    def __init__(self, key, hid, cols, rows):
        self.key = key
        self.term = TerminalSession(hid, cols, rows)
        self.buffer = bytearray()
        self.clients = set()
        self.lock = threading.Lock()
        self.alive = True
        self.created = time.time()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        """Always drain the PTY into the ring buffer + fan out to live clients."""
        while True:
            data = self.term.read()
            if not data:
                break
            with self.lock:
                self.buffer += data
                if len(self.buffer) > TERM_BUFFER_MAX:
                    del self.buffer[:len(self.buffer) - TERM_BUFFER_MAX]
                clients = list(self.clients)
            for ws in clients:
                try:
                    ws.send_bytes(data)
                except Exception:
                    pass
        # Shell exited (EOF) -> drop from the registry and close any clients.
        self.alive = False
        with TERM_REGISTRY_LOCK:
            if TERM_SESSIONS.get(self.key) is self:
                TERM_SESSIONS.pop(self.key, None)
        with self.lock:
            clients, self.clients = list(self.clients), set()
        for ws in clients:
            try:
                ws.close()
            except Exception:
                pass

    def attach(self, ws):
        # Replay the backlog and register the client atomically, so no output
        # slips in between the snapshot and the client going live (out-of-order).
        with self.lock:
            if self.buffer:
                try:
                    ws.send_bytes(bytes(self.buffer))
                except Exception:
                    pass
            self.clients.add(ws)

    def detach(self, ws):
        with self.lock:
            self.clients.discard(ws)

    def write(self, data):
        self.term.write(data)

    def resize(self, cols, rows):
        self.term.resize(cols, rows)

    def close(self):
        self.alive = False
        with TERM_REGISTRY_LOCK:
            if TERM_SESSIONS.get(self.key) is self:
                TERM_SESSIONS.pop(self.key, None)
        self.term.close()


def serve_terminal_ws(handler, hid, cols, rows, key="", init=""):
    ws = WSServer.upgrade(handler)
    if not ws:
        return
    key = key or ("host:" + (hid or "local"))
    with TERM_REGISTRY_LOCK:
        pt = TERM_SESSIONS.get(key)
        fresh = pt is None or not pt.alive
        if fresh:
            try:
                pt = PersistentTerminal(key, hid, cols, rows)
            except Exception as e:
                try:
                    ws.send_bytes(f"\r\n\x1b[31mCould not open a shell: {e}\x1b[0m\r\n".encode())
                except Exception:
                    pass
                ws.close()
                return
            TERM_SESSIONS[key] = pt
    pt.resize(cols, rows)
    pt.attach(ws)
    if fresh and init:
        pt.write(init if init.endswith("\n") else init + "\n")
    elif not fresh:
        pt.resize(cols, rows)   # nudge a reattaching TUI (e.g. copilot) to repaint

    try:
        while True:
            op, payload = ws.recv()
            if op == 0x8:
                break
            try:
                msg = json.loads(payload.decode("utf-8", "replace"))
            except Exception:
                continue
            t = msg.get("t")
            if t == "i":
                pt.write(msg.get("d", ""))
            elif t == "r":
                pt.resize(msg.get("cols", 80), msg.get("rows", 24))
            elif t == "k":          # explicit reset/kill from the UI
                pt.close()
                break
    except Exception:
        pass
    finally:
        pt.detach(ws)               # keep the PTY alive across disconnects
        ws.close()
