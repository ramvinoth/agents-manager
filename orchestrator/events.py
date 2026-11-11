"""orchestrator.events — the live push channel for session updates.

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
  {"type": "watching", "session": id, "ok": bool}    answer to a watch (below)

A client may send one kind of text frame back:
  {"type": "watch", "sessions": [{"session": id, "host": h, "agent": a, "path": rel}]}
naming the transcripts it has open (at most WATCH_MAX; each frame replaces the
last). A watched session gets transcript-changed even when no run of this
server owns it — a CLI in a terminal, any agent's format — and on another
host too. "watching" says, per session, whether the server can see its file:
ok=false means "keep polling it yourself"; it flips to true once the size is
known (a remote host's first stat lands a couple of seconds later).

Where events come from: one Watcher thread diffs snapshots of the state the
polls read (CHAT_JOBS, local transcript sizes, project-folder mtimes) — so no
runner (claude, codex, copilot, pi, custom) has to remember to publish, and
the CLI's own transcript writes are seen at all. It runs only while someone
is subscribed. Transcripts on other hosts are statted by RemoteSizes: one
thread per host, off the tick (an SSH op can take seconds), one SFTP channel
per poll for all of that host's sessions, only while something there is
running or watched. Route handlers that change the list (rename, delete, fork…)
publish list-changed directly (server.LIST_MUTATIONS).

Pure parts (Hub, diff, list_due, last_uuid, parse_watch, watch_acks) are
unit-tested without a server.
"""
import json
import queue
import threading
import time

from orchestrator.config import CHAT_JOBS, CHAT_LOCK, CLAUDE_DIR, transcript_path

TICK = 0.5            # seconds between watcher snapshots
LIST_MIN_GAP = 3.0    # a running transcript changes every tick; the list refetch must not
PING_EVERY = 25       # keepalive; the client treats ~2 missed pings as a dead stream
QUEUE_MAX = 256       # events buffered per subscriber before it is told to resync
TAIL_BYTES = 64 * 1024
WATCH_MAX = 4         # transcripts one client may watch (a phone or a browser shows one)
WATCH_FRAME_MAX = 4096
REMOTE_EVERY = 2.0    # seconds between one host's stat polls
REMOTE_BACKOFF = 15.0 # after a failed poll (host down or unreachable)
REMOTE_IDLE = 10.0    # a host poller nobody has asked about for this long exits


# ---- pub-sub ------------------------------------------------------------------

class Subscription:
    """One client's bounded event queue. A client too slow to drain it loses
    the backlog and gets one {"type": "resync"} instead — never a silent gap."""

    def __init__(self, maxsize=QUEUE_MAX):
        self._q = queue.Queue(maxsize)
        self._lock = threading.Lock()
        self._overflow = False
        self.closed = False
        self.watch = {}    # session id -> {"host", "agent", "path"}; a watch frame replaces it whole
        self.acked = {}    # session id -> the last "ok" this client was told

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

    def subscribers(self):
        with self._lock:
            return list(self._subs)

    def watched(self):
        """Every session some subscriber watches -> its spec (first one wins)."""
        out = {}
        for sub in self.subscribers():
            for sid, spec in sub.watch.items():
                out.setdefault(sid, spec)
        return out

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


def parse_watch(text):
    """A client's watch frame -> {session: {"host", "agent", "path"}}, or None
    when `text` is not a well-formed watch frame (ignored, never an error).
    Only the first WATCH_MAX valid entries count. The path is only a hint: it
    is resolved under the agent's own sessions root before anything is
    statted (local_transcript, remote.remote_*full_path)."""
    try:
        msg = json.loads(text)
    except (TypeError, ValueError):
        return None
    if not isinstance(msg, dict) or msg.get("type") != "watch" or not isinstance(msg.get("sessions"), list):
        return None
    out = {}
    for e in msg["sessions"]:
        if len(out) >= WATCH_MAX:
            break
        if not isinstance(e, dict):
            continue
        sid = e.get("session")
        host, agent, path = e.get("host") or "local", e.get("agent") or "claude", e.get("path") or ""
        if not (isinstance(sid, str) and 0 < len(sid) <= 200 and "/" not in sid
                and all(isinstance(v, str) and len(v) <= 1024 for v in (host, agent, path))):
            continue
        out[sid] = {"host": host, "agent": agent, "path": path}
    return out


def watch_acks(watch, acked, snap):
    """The "watching" answers a subscriber is owed: one per watched session
    whose visibility (its size known in `snap`) differs from what it was last
    told. Updates `acked` in place and forgets sessions no longer watched."""
    for sid in list(acked):
        if sid not in watch:
            del acked[sid]
    out = []
    for sid in sorted(watch):
        ok = (snap.get(sid) or {}).get("size") is not None
        if acked.get(sid) is not ok:
            acked[sid] = ok
            out.append({"type": "watching", "session": sid, "ok": ok})
    return out


# ---- transcripts on other hosts ------------------------------------------------------

def _remote_stat(host, specs, paths):
    """Sizes of `specs` ({session: spec}) on `host`, over ONE SFTP channel.
    `paths` caches session -> absolute remote path across polls (finding a
    Claude session by id is an exec `ls`, not per-poll cheap); a file that is
    gone drops its entry so it is looked up again. Raises when the host is
    unreachable — the caller backs off."""
    from orchestrator import remote
    for sid, spec in specs.items():
        if sid in paths:
            continue
        full = None
        if spec["path"]:
            full = (remote.remote_full_path(host, spec["path"]) if spec["agent"] == "claude"
                    else remote.remote_agent_full_path(host, spec["agent"], spec["path"]))
        elif spec["agent"] == "claude":
            found = remote.remote_resolve(host, sid)
            if found.get("found"):
                full = remote.remote_full_path(host, found["path"])
        # another agent's file is found only by the path its client names
        if full:
            paths[sid] = full
    sizes = {}
    with remote.SSH.sftp(host) as sftp:
        for sid in specs:
            if sid not in paths:
                continue
            try:
                sizes[sid] = sftp.stat(paths[sid]).st_size
            except FileNotFoundError:   # moved or deleted: resolve it again next poll. A dead
                paths.pop(sid, None)    # host raises another OSError: the whole poll backs off
    return sizes


class RemoteSizes:
    """Transcript sizes on other hosts, polled off the watcher's tick. want()
    names the whole set wanted now, by host; each host with something wanted
    gets one daemon thread that stats its sessions every REMOTE_EVERY seconds,
    waits REMOTE_BACKOFF after a failure (its sizes then read unknown, so a
    client is told ok=false and polls), and exits once its host is no longer
    wanted or nobody has called want() for REMOTE_IDLE seconds."""

    def __init__(self, stat=_remote_stat):
        self._stat = stat
        self._lock = threading.Lock()
        self._want = {}      # host -> {session: spec}
        self._sizes = {}     # host -> {session: size}
        self._threads = {}   # host -> Thread
        self._asked = 0.0

    def want(self, by_host):
        with self._lock:
            self._want = {h: dict(specs) for h, specs in by_host.items() if specs}
            self._asked = time.monotonic()
            for host in self._want:
                if host not in self._threads:
                    t = threading.Thread(target=self._run, args=(host,), daemon=True,
                                         name="events-remote")
                    self._threads[host] = t
                    t.start()

    def size(self, host, sid):
        with self._lock:
            return (self._sizes.get(host) or {}).get(sid)

    def polling(self):
        with self._lock:
            return set(self._threads)

    def _run(self, host):
        paths = {}
        while True:
            with self._lock:
                specs = self._want.get(host)
                if not specs or time.monotonic() - self._asked > REMOTE_IDLE:
                    self._threads.pop(host, None)
                    self._sizes.pop(host, None)
                    return
            try:
                sizes, pause = self._stat(host, specs, paths), REMOTE_EVERY
            except Exception as e:
                print(f"[events] remote stat on {host} failed: {e}", flush=True)
                sizes, pause = {}, REMOTE_BACKOFF
                paths.clear()
            with self._lock:
                self._sizes[host] = sizes
            time.sleep(pause)


# ---- the watcher ------------------------------------------------------------------

class Watcher:
    """Snapshots the polled state every TICK while the hub has subscribers and
    publishes the difference. Started by the hub's first subscriber; exits on
    its own when the last one leaves (atomically with ensure(), so a
    subscriber arriving at that moment always gets a running watcher)."""

    def __init__(self, hub, remote=None):
        self.hub = hub
        self.remote = remote or RemoteSizes()
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
                    self.remote.want({})
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
                for sub in self.hub.subscribers():
                    for ack in watch_acks(sub.watch, sub.acked, cur):
                        sub.put(ack)
                now = time.monotonic()
                if list_due(urgent, dirty, now, last_list):
                    self.hub.publish({"type": "list-changed"})
                    last_list, dirty = now, False
                prev, dirs = cur, cur_dirs
            except Exception as e:   # never let one bad tick end the stream for everyone
                print(f"[events] watcher tick failed: {e}", flush=True)

    def _snapshot(self):
        """{session: {running, status, size}} for every run this server owns
        and every session a client watches. A watched session no run owns is
        idle with no status: only its transcript can change."""
        with CHAT_LOCK:
            jobs = {sid: (job.get("host", "local"), job.get("agent") or "claude", job_state(job))
                    for sid, job in CHAT_JOBS.items()}
        specs = {sid: {"host": h, "agent": a, "path": ""} for sid, (h, a, _) in jobs.items()}
        specs.update(self.hub.watched())    # a client's path finds files an id cannot
        remote = {}
        for sid, spec in specs.items():
            if spec["host"] != "local":
                remote.setdefault(spec["host"], {})[sid] = spec
        self.remote.want(remote)
        snap = {}
        for sid, spec in specs.items():
            state = jobs[sid][2] if sid in jobs else {"running": False, "status": None}
            state["size"] = (self._size(sid, spec) if spec["host"] == "local"
                             else self.remote.size(spec["host"], sid))
            snap[sid] = state
        for sid in list(self._paths):
            if sid not in specs:
                self._paths.pop(sid, None)
        return snap

    def _size(self, sid, spec):
        path = self._paths.get(sid)
        if path is None:
            path = local_transcript(sid, spec)   # a new chat's file appears after its CLI starts
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


def local_transcript(sid, spec):
    """A session's transcript file on this machine: a Claude session by the
    client's projects/... path or else by its id; another agent's only by the
    path its client names, resolved under that agent's own root. None when
    absent, or when the path escapes its root (compared by path components)."""
    agent, rel = spec.get("agent") or "claude", spec.get("path") or ""
    if agent != "claude":
        from orchestrator.adapters import resolve_agent_session
        return resolve_agent_session(agent, rel) if rel else None
    if rel:
        try:
            full, root = (CLAUDE_DIR.parent / rel).resolve(), CLAUDE_DIR.resolve()
        except (OSError, RuntimeError):
            full = root = None
        if full and root in full.parents and full.is_file():
            return full
    return transcript_path(sid)


HUB = Hub()
WATCHER = Watcher(HUB, RemoteSizes())
HUB._on_first = WATCHER.ensure


def publish_list_changed():
    HUB.publish({"type": "list-changed"})


# ---- the WebSocket ------------------------------------------------------------------

def serve_ws(handler):
    """Hold one subscriber's stream until it hangs up. Runs on the dedicated
    thread PooledHTTPServer gives every WS_PATHS connection; a second small
    thread reads the client's watch frames and notices the close (a frame
    over WATCH_FRAME_MAX ends the connection)."""
    from orchestrator.browser import WSServer
    ws = WSServer.upgrade(handler)
    if not ws:
        return
    sub = HUB.subscribe()

    def _reader():
        try:
            while True:
                op, data = ws.recv(WATCH_FRAME_MAX)
                if op == 0x8:
                    break
                watch = parse_watch(data.decode("utf-8", "replace")) if op == 0x1 else None
                if watch is not None:
                    sub.watch = watch      # the watcher answers "watching" on its next tick
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
