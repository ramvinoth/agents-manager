"""orchestrator.live — invalidation events for the realtime surfaces.

One Postgres LISTEN thread (channel `agents_events`, fed by the row triggers
shared.schema._install_live_triggers installs) plus in-process `publish()` for state that
lives in memory (the engine's tool-approval registry). Every event is keys
only — {table, id, op, project_id} — and fans out to every connected client;
a client refetches what it shows through the ordinary GET routes, so the
channel carries no row content and needs no authorization of its own beyond
the socket's login. Filtering by project is the client's job (cheap: the
payload is a handful of bytes).

Backpressure: each subscriber owns a bounded queue drained by its own writer
thread. When a burst overflows it (a bulk reorder touches hundreds of rows),
the queue collapses into ONE {"t":"resync"} — the client refetches
everything, which is always correct because events only ever say "look
again". Memory stays bounded and nobody is disconnected for being busy; a
dead socket is found by the writer's send failing.
"""
import json
import queue
import select
import threading
import time

CHANNEL = "agents_events"
QUEUE_MAX = 256
PING_S = 25          # idle keepalive so proxies keep the socket open
LISTEN_POLL_S = 5    # select() timeout: how fast the listener notices shutdown
BACKOFF_MAX_S = 30


def parse_event(payload):
    """A NOTIFY payload → event dict, or None when it is not one of ours."""
    try:
        ev = json.loads(payload)
    except (TypeError, ValueError):
        return None
    if not isinstance(ev, dict) or not ev.get("table"):
        return None
    return {"t": "change", "table": str(ev["table"]), "id": ev.get("id"),
            "op": ev.get("op") or "", "project_id": ev.get("project_id")}


class Subscriber:
    def __init__(self, send, on_close=None):
        self.send = send             # send(str) -> None; raises OSError when gone
        self.on_close = on_close     # called once the writer stops, for any reason
        self.q = queue.Queue(QUEUE_MAX)
        self.alive = True
        self._offer_lock = threading.Lock()   # producers: listener + engine threads

    def offer(self, msg, lossy=False):
        """Queue without blocking; on overflow collapse to one resync.
        `lossy` messages (cursor presence) are simply dropped once the queue is
        half full, so they never push real changes into a resync.
        False only when the subscriber is already dead."""
        if not self.alive:
            return False
        if lossy and self.q.qsize() >= QUEUE_MAX // 2:
            return True
        with self._offer_lock:
            try:
                self.q.put_nowait(msg)
            except queue.Full:
                while True:
                    try:
                        self.q.get_nowait()
                    except queue.Empty:
                        break
                self.q.put_nowait({"t": "resync"})
        return True

    def run(self):
        """Writer loop: drain the queue, ping when idle, stop on any send error."""
        while self.alive:
            try:
                msg = self.q.get(timeout=PING_S)
            except queue.Empty:
                msg = {"t": "ping"}
            if msg is None:
                break
            try:
                self.send(json.dumps(msg))
            except Exception:
                break
        self.alive = False
        if self.on_close:
            try:
                self.on_close()
            except Exception:
                pass

    def stop(self):
        self.alive = False
        try:
            self.q.put_nowait(None)
        except queue.Full:
            pass


class Hub:
    def __init__(self):
        self._lock = threading.Lock()
        self._subs = set()
        self._listener = None

    def subscribe(self, send, on_close=None):
        sub = Subscriber(send, on_close)
        with self._lock:
            self._subs.add(sub)
        threading.Thread(target=sub.run, daemon=True, name="live-writer").start()
        self._ensure_listener()
        return sub

    def unsubscribe(self, sub):
        sub.stop()
        with self._lock:
            self._subs.discard(sub)

    def count(self):
        with self._lock:
            return len(self._subs)

    def dispatch(self, msg):
        """Fan one message out; a subscriber found dead is removed."""
        with self._lock:
            subs = list(self._subs)
        for sub in subs:
            if not sub.offer(msg):
                self.unsubscribe(sub)

    def _ensure_listener(self):
        with self._lock:
            if self._listener and self._listener.is_alive():
                return
            self._listener = threading.Thread(target=self._listen_forever,
                                              daemon=True, name="live-listen")
            self._listener.start()

    def _listen_forever(self):
        """LISTEN on a dedicated autocommit connection (never the pool's).
        On any error: back off, reconnect, and tell every client to resync —
        notifications sent while we were away are gone for good."""
        import psycopg2
        from orchestrator import db
        backoff = 1
        first = True
        while True:
            conn = None
            try:
                conn = psycopg2.connect(db.DATABASE_URL)
                conn.autocommit = True
                conn.cursor().execute(f"LISTEN {CHANNEL}")
                if not first:
                    self.dispatch({"t": "resync"})
                first, backoff = False, 1
                while True:
                    if select.select([conn], [], [], LISTEN_POLL_S) == ([], [], []):
                        continue
                    conn.poll()
                    while conn.notifies:
                        ev = parse_event(conn.notifies.pop(0).payload)
                        if ev:
                            self.dispatch(ev)
            except Exception as e:
                print(f"[live] listener error: {e}; retry in {backoff}s", flush=True)
                time.sleep(backoff)
                backoff = min(BACKOFF_MAX_S, backoff * 2)
            finally:
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass


HUB = Hub()


def publish(table, id=None, op="UPDATE", project_id=None):
    """In-process change for state Postgres never sees (the engine's
    tool-approval registry). Never raises: liveness is best-effort."""
    try:
        HUB.dispatch({"t": "change", "table": table, "id": id, "op": op,
                      "project_id": project_id})
    except Exception:
        pass
