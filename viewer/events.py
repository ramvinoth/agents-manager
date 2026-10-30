"""viewer.events — the live push channel for session updates.

Clients used to poll: the phone's chat list every 4s and an open thread's
/api/chat/status every 1.5s. This module tells them WHEN something changed so
they fetch only that resource; their polls stay as a slow fallback.

Transport: a WebSocket at /api/events/ws, the same way terminal/voice stream.
Not SSE, deliberately: the server already runs every long-lived WebSocket on
its own thread off the bounded worker pool (server.PooledHTTPServer.WS_PATHS),
the relay already tunnels WebSockets end to end (relay.py WS_OPEN), and the
phone's transport opens one on whichever route answers
(serverTransport.openSocket). React Native's fetch cannot read a streaming
body, and the relay's HTTP lane buffers a response per request — an SSE
stream would have needed a second long-lived path through all three.

Events are JSON text frames:
  {"type": "hello"}                                  on connect
  {"type": "turn-start", "session": id}              a run began
  {"type": "turn-end", "session": id}                a run ended
  {"type": "status-changed", "session": id}          queue / approvals / turns moved
  {"type": "transcript-changed", "session": id, "size": n, "uuid": u}
  {"type": "list-changed"}                           the chat list may differ
  {"type": "resync"}                                 events were dropped: refetch all
  {"type": "ping"}                                   keepalive every PING_EVERY s

Where events come from: one Watcher thread diffs snapshots of the state the
polls read (CHAT_JOBS, local transcript sizes, project-folder mtimes) — so no
runner (claude, codex, copilot, pi, custom) has to remember to publish, and
the CLI's own transcript writes are seen at all. It runs only while someone
is subscribed. Route handlers that change the list (rename, delete, fork…)
publish list-changed directly (server.LIST_MUTATIONS).

Pure parts (Hub, diff, list_due, last_uuid) are unit-tested without a server.
"""
import json
import queue
import threading
import time

from viewer.config import CHAT_JOBS, CHAT_LOCK, CLAUDE_DIR, transcript_path

TICK = 0.5            # seconds between watcher snapshots
LIST_MIN_GAP = 3.0    # a running transcript changes every tick; the list refetch must not
PING_EVERY = 25       # keepalive; the client treats ~2 missed pings as a dead stream
QUEUE_MAX = 256       # events buffered per subscriber before it is told to resync
TAIL_BYTES = 64 * 1024


# ---- pub-sub ------------------------------------------------------------------

class Subscription:
    """One client's bounded event queue. A client too slow to drain it loses
    the backlog and gets one {"type": "resync"} instead — never a silent gap."""

    def __init__(self, maxsize=QUEUE_MAX):
        self._q = queue.Queue(maxsize)
        self._lock = threading.Lock()
        self._overflow = False
        self.closed = False

    def put(self, event):
        try:
            self._q.put_nowait(event)
        except queue.Full:
            with self._lock:
                self._overflow = True

    def get(self, timeout=None):
        """The next event, {"type": "resync"} after an overflow, or None on
        timeout / once closed."""
        with self._lock:
            if self._overflow:
                self._overflow = False
                self._drain()
                return {"type": "resync"}
        if self.closed:
            return None
        try:
            return self._q.get(timeout=timeout)
        except queue.Empty:
            return None

    def _drain(self):
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                return

    def close(self):
        self.closed = True
        try:
            self._q.put_nowait(None)   # wake a blocked get()
        except queue.Full:
            pass


class Hub:
    """In-process fan-out: publish() copies an event to every subscriber."""

    def __init__(self, on_first=None):
        self._subs = set()
        self._lock = threading.Lock()
        self._on_first = on_first

    def subscribe(self, maxsize=QUEUE_MAX):
        sub = Subscription(maxsize)
        with self._lock:
            self._subs.add(sub)
        if self._on_first:
            self._on_first()
        return sub

    def unsubscribe(self, sub):
        sub.close()
        with self._lock:
            self._subs.discard(sub)

    def count(self):
        with self._lock:
            return len(self._subs)

    def publish(self, event):
        with self._lock:
            subs = list(self._subs)
        for sub in subs:
            sub.put(event)


# ---- state diff (pure) ----------------------------------------------------------

def job_state(job):
    """What a client's /api/chat/status poll would see change, as a comparable
    tuple: the run flag, its queue, the approval/question/plan entries waiting,
    and the turn counters."""
    return {
        "running": bool(job.get("running")),
        "status": (len(job.get("queue") or ()),
                   tuple(str(e.get("id")) for e in job.get("pending_approvals") or ()),
                   job.get("turns", 0), job.get("steered", 0),
                   bool(job.get("interrupted"))),
    }


def diff(prev, cur):
    """Events between two snapshots {session: {running, status, size}}, plus
    (list_urgent, list_dirty). A turn boundary is urgent for the list (its
    row's running dot); transcript growth only makes it dirty (activity
    order), which list_due throttles."""
    events, urgent, dirty = [], False, False
    for sid in sorted(set(prev) | set(cur)):
        p, c = prev.get(sid) or {}, cur.get(sid) or {}
        was, now = bool(p.get("running")), bool(c.get("running"))
        if now and not was:
            events.append({"type": "turn-start", "session": sid})
            urgent = True
        elif was and not now:
            events.append({"type": "turn-end", "session": sid})
            urgent = True
        elif c and p and c.get("status") != p.get("status"):
            events.append({"type": "status-changed", "session": sid})
        size = c.get("size")
        if size is not None and p and size != p.get("size"):
            events.append({"type": "transcript-changed", "session": sid, "size": size})
            dirty = True
    return events, urgent, dirty


def list_due(urgent, dirty, now, last_emit, gap=LIST_MIN_GAP):
    """Whether to emit list-changed now. Urgent always; dirty at most once per
    `gap` seconds (the caller keeps `dirty` pending until this says yes)."""
    return urgent or (dirty and now - last_emit >= gap)


def last_uuid(tail):
    """The uuid of the last complete transcript line in `tail` (bytes), or ""."""
    for line in reversed(tail.split(b"\n")):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue           # the first line of a tail read is usually cut
        if isinstance(obj, dict) and obj.get("uuid"):
            return str(obj["uuid"])
    return ""


# ---- the watcher ------------------------------------------------------------------

class Watcher:
    """Snapshots the polled state every TICK while the hub has subscribers and
    publishes the difference. Started by the hub's first subscriber; exits on
    its own when the last one leaves (atomically with ensure(), so a
    subscriber arriving at that moment always gets a running watcher)."""

    def __init__(self, hub):
        self.hub = hub
        self._lock = threading.Lock()
        self._thread = None
        self._paths = {}   # session id -> transcript Path (the glob is not per-tick cheap)

    def ensure(self):
        with self._lock:
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, daemon=True, name="events-watch")
                self._thread.start()

    def _run(self):
        prev, dirs = self._snapshot(), self._dirs()
        last_list, dirty = 0.0, False
        while True:
            time.sleep(TICK)
            with self._lock:
                if self.hub.count() == 0:
                    self._thread = None
                    return
            try:
                cur, cur_dirs = self._snapshot(), self._dirs()
                events, urgent, grew = diff(prev, cur)
                urgent = urgent or cur_dirs != dirs
                dirty = dirty or grew
                for ev in events:
                    if ev["type"] == "transcript-changed":
                        ev["uuid"] = self._tail_uuid(ev["session"], ev["size"])
                    self.hub.publish(ev)
                now = time.monotonic()
                if list_due(urgent, dirty, now, last_list):
                    self.hub.publish({"type": "list-changed"})
                    last_list, dirty = now, False
                prev, dirs = cur, cur_dirs
            except Exception as e:   # never let one bad tick end the stream for everyone
                print(f"[events] watcher tick failed: {e}", flush=True)

    def _snapshot(self):
        with CHAT_LOCK:
            jobs = {sid: (job.get("host", "local"), job_state(job)) for sid, job in CHAT_JOBS.items()}
        snap = {}
        for sid, (host, state) in jobs.items():
            state["size"] = self._size(sid) if host == "local" else None
            snap[sid] = state
        for sid in list(self._paths):
            if sid not in jobs:
                self._paths.pop(sid, None)
        return snap

    def _size(self, sid):
        path = self._paths.get(sid)
        if path is None:
            path = transcript_path(sid)   # a new chat's file appears after its CLI starts
            if path is None:
                return None
            self._paths[sid] = path
        try:
            return path.stat().st_size
        except OSError:
            self._paths.pop(sid, None)    # moved (deleted / forked): look it up again
            return None

    def _tail_uuid(self, sid, size):
        path = self._paths.get(sid)
        if not path:
            return ""
        try:
            with open(path, "rb") as f:
                f.seek(max(0, size - TAIL_BYTES))
                return last_uuid(f.read(TAIL_BYTES))
        except OSError:
            return ""

    @staticmethod
    def _dirs():
        """Project folders and their mtimes: a session file created, deleted or
        moved — by any client or a CLI outside the viewer — changes one."""
        try:
            return {p.name: p.stat().st_mtime for p in CLAUDE_DIR.iterdir() if p.is_dir()}
        except OSError:
            return {}


HUB = Hub()
WATCHER = Watcher(HUB)
HUB._on_first = WATCHER.ensure


def publish_list_changed():
    HUB.publish({"type": "list-changed"})


# ---- the WebSocket ------------------------------------------------------------------

def serve_ws(handler):
    """Hold one subscriber's stream until it hangs up. Runs on the dedicated
    thread PooledHTTPServer gives every WS_PATHS connection; a second small
    thread reads, only to notice the close."""
    from viewer.browser import WSServer
    ws = WSServer.upgrade(handler)
    if not ws:
        return
    sub = HUB.subscribe()

    def _reader():
        try:
            while True:
                op, _ = ws.recv()
                if op == 0x8:
                    break
        except OSError:
            pass
        finally:
            sub.close()

    threading.Thread(target=_reader, daemon=True, name="events-ws-read").start()
    try:
        ws.send_text(json.dumps({"type": "hello"}))
        while not sub.closed:
            ev = sub.get(timeout=PING_EVERY)
            if ev is None:
                if sub.closed:
                    break
                ev = {"type": "ping"}
            ws.send_text(json.dumps(ev))
    except OSError:
        pass
    finally:
        HUB.unsubscribe(sub)
        ws.close()
