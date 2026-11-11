"""orchestrator.canvas_room — the live, in-memory copy of one shared canvas.

A room is loaded from Postgres on first use and from then on is the source of
truth for that canvas: every edit (a browser over /api/canvas/ws, an agent
through canvas_patch) goes through `Room.apply`, which merges with the
canvas_reconcile rules, relays the winners to every OTHER peer and marks them
dirty. One background thread flushes dirty elements in batches (at most once
a second, and on unload), broadcasts a checksum every 20 s so a client that
silently diverged refetches, and unloads rooms nobody has touched for 5 min.

Peers reuse orchestrator.live.Subscriber: a bounded queue per socket, overflow
collapses to one resync (the client refetches the snapshot — always correct),
and cursor presence is lossy so it is the first thing dropped under load.
"""
import collections
import threading
import time

from orchestrator import canvas_patch
from orchestrator import canvas_reconcile as rec
from orchestrator.live import Subscriber

FLUSH_S = 1.0
CHECKSUM_S = 20.0
IDLE_UNLOAD_S = 300.0
UNDO_DEPTH = 20                  # agent patches a person can take back, per room


class Room:
    def __init__(self, canvas_id, elements, saver):
        self.canvas_id = canvas_id
        self.lock = threading.Lock()
        self.elements = {e["id"]: e for e in elements if isinstance(e, dict) and e.get("id")}
        self.dirty = {}               # id -> actor of the latest accepted write
        self.peers = {}               # peer id -> Subscriber
        self.saver = saver
        self.touched = time.time()
        self.undo = collections.deque(maxlen=UNDO_DEPTH)   # (actor, [(id, element before | None, version written)])

    # -- reads --------------------------------------------------------------
    def snapshot(self):
        with self.lock:
            els = list(self.elements.values())
        return {"canvas": self.canvas_id, "protocol": rec.PROTOCOL,
                "elements": els, "checksum": rec.checksum(els)}

    def stored(self, ids):
        """The current copy of each id that exists (for a rejected write)."""
        with self.lock:
            return {i: self.elements[i] for i in ids if i in self.elements}

    def checksum(self):
        with self.lock:
            return rec.checksum(self.elements.values())

    # -- peers --------------------------------------------------------------
    def join(self, peer_id, send, on_close=None):
        sub = Subscriber(send, on_close)
        with self.lock:
            self.peers[peer_id] = sub
            self.touched = time.time()
        threading.Thread(target=sub.run, daemon=True, name="canvas-writer").start()
        return sub

    def leave(self, peer_id):
        with self.lock:
            sub = self.peers.pop(peer_id, None)
            self.touched = time.time()
        if sub:
            sub.stop()
            self._relay({"t": "leave", "peer": peer_id})   # peers drop its cursor

    def _relay(self, msg, exclude=None, lossy=False):
        with self.lock:
            peers = [(pid, s) for pid, s in self.peers.items() if pid != exclude]
        for pid, sub in peers:
            if not sub.offer(msg, lossy=lossy):
                self.leave(pid)

    # -- writes -------------------------------------------------------------
    def apply(self, elements, peer_id=None, actor=""):
        """Merge a batch; relay what won. Returns (accepted, rejected) — the
        sender is acked the accepted ids and adopts each rejected winner."""
        with self.lock:
            accepted, rejected = rec.merge(self.elements, elements)
            for el in accepted:
                self.dirty[el["id"]] = actor
            self.touched = time.time()
        if accepted:
            self._relay({"t": "elements", "elements": accepted, "from": peer_id or actor},
                        exclude=peer_id)
        return accepted, rejected

    def patch(self, ops, actor, own_only):
        """An agent's ops (canvas_patch) applied like any peer's write, plus an
        undo record so the person watching can take the whole patch back."""
        with self.lock:
            out, results = canvas_patch.build(self.elements, ops, actor, own_only)
            before = {el["id"]: self.elements.get(el["id"]) for el in out}
            accepted, _ = rec.merge(self.elements, out)
            for el in accepted:
                self.dirty[el["id"]] = actor
            if accepted:
                self.undo.append((actor, [(el["id"], before[el["id"]], el["version"]) for el in accepted]))
            self.touched = time.time()
        if accepted:
            self._relay({"t": "elements", "elements": accepted, "from": actor})
        return accepted, results

    def revert(self, actor, by):
        """Undo `actor`'s latest patch; the undo itself is written as `by`.
        Returns the elements written ([] when there is nothing to undo)."""
        with self.lock:
            idx = next((i for i in range(len(self.undo) - 1, -1, -1) if self.undo[i][0] == actor), None)
            if idx is None:
                return []
            _, prior = self.undo[idx]
            del self.undo[idx]
            accepted, _ = rec.merge(self.elements, canvas_patch.revert(self.elements, prior))
            for el in accepted:
                self.dirty[el["id"]] = by
            self.touched = time.time()
        if accepted:
            self._relay({"t": "elements", "elements": accepted, "from": by})
        return accepted

    def presence(self, peer_id, data):
        self._relay({"t": "presence", "peer": peer_id, **(data or {})},
                    exclude=peer_id, lossy=True)

    def flush(self):
        """Write dirty elements. On a DB error they stay dirty for the next pass."""
        with self.lock:
            if not self.dirty:
                return 0
            batch, self.dirty = self.dirty, {}
            by_actor = {}
            for eid, actor in batch.items():
                if eid in self.elements:
                    by_actor.setdefault(actor, []).append(self.elements[eid])
        try:
            for actor, els in by_actor.items():
                self.saver(self.canvas_id, els, actor)
        except Exception as e:
            print(f"[canvas] flush of canvas {self.canvas_id} failed: {e}", flush=True)
            with self.lock:
                for eid, actor in batch.items():
                    self.dirty.setdefault(eid, actor)
            return 0
        return len(batch)

    def broadcast_checksum(self):
        self._relay({"t": "checksum", "checksum": self.checksum()})

    def idle(self, now):
        with self.lock:
            return not self.peers and not self.dirty and now - self.touched > IDLE_UNLOAD_S


class Registry:
    def __init__(self, loader=None, saver=None):
        from orchestrator import db
        self.loader = loader or db.canvas_elements_load
        self.saver = saver or db.canvas_elements_upsert
        self._lock = threading.Lock()
        self._rooms = {}
        self._thread = None

    def get(self, canvas_id):
        """The room for a canvas, loaded from the DB on first use. The load
        runs under the registry lock so two first joins never build two rooms."""
        canvas_id = int(canvas_id)
        with self._lock:
            room = self._rooms.get(canvas_id)
            if room is None:
                room = Room(canvas_id, self.loader(canvas_id), self.saver)
                self._rooms[canvas_id] = room
            self._ensure_thread()
        return room

    def loaded(self):
        with self._lock:
            return list(self._rooms.values())

    def tick(self, now, with_checksum=False):
        """One pass of the background loop (separate so tests drive it)."""
        for room in self.loaded():
            room.flush()
            if with_checksum:
                room.broadcast_checksum()
            if room.idle(now):
                with self._lock:
                    if room.idle(now):
                        self._rooms.pop(room.canvas_id, None)

    def flush_all(self):
        for room in self.loaded():
            room.flush()

    def _ensure_thread(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, daemon=True, name="canvas-rooms")
        self._thread.start()

    def _run(self):
        last_sum = time.time()
        while True:
            time.sleep(FLUSH_S)
            now = time.time()
            due = now - last_sum >= CHECKSUM_S
            if due:
                last_sum = now
            try:
                self.tick(now, with_checksum=due)
            except Exception as e:
                print(f"[canvas] tick error: {e}", flush=True)


ROOMS = Registry()
