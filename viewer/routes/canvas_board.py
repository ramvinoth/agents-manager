"""viewer.routes.canvas_board — CanvasBoardMixin: the shared project canvas.

GET  /api/canvas/board?project=<id> | ?id=<canvas>   snapshot (gzipped JSON)
GET  /api/canvas/file?canvas=&file=                   one content-addressed file
POST /api/canvas/file?canvas=&file=&mime=             raw body, first write wins
GET  /api/canvas/ws?canvas=<id>                       the room socket
GET  /api/canvas/agent/read?project=|canvas=          agent summary (ink, frames, refs)
POST /api/canvas/agent/patch {project|canvas, ops}    agent add/update/delete ops
GET  /api/canvas/agent/snapshot?project=|canvas=&group=|frame=|bbox=x0,y0,x1,y1   PNG
POST /api/canvas/revert {canvas, actor}               a person undoes an agent's last patch

Socket protocol (viewer/canvas_room.py holds the room):
  client → {"t":"hello","protocol":N}            mismatch → {"t":"reload"} + close
  client → {"t":"elements","elements":[...]}     → {"t":"ack","ids":[...]} and,
                                                    for losers, {"t":"reject","items":[...]}
  client → {"t":"presence", ...}                 relayed to peers, lossy
  server → {"t":"elements"|"presence"|"leave"|"checksum"|"resync"|"ping"}
The snapshot always comes over HTTP: on (re)connect a client fetches it, then
resends whatever it has not had acked.
"""
import json
import re
import threading
import time
import uuid

from viewer import canvas_reconcile as rec
from viewer import canvas_render, canvas_summary
from viewer import db
from viewer.canvas_room import ROOMS

MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_FRAME_BYTES = 8 * 1024 * 1024      # a 2000-element paste is ~1-2 MiB
MAX_BATCH = 2000                       # elements per message; the rest are refused
FILE_MIMES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}
PRESENCE_KEYS = ("pointer", "button", "selected", "name", "color")
AGENT_OPS_PER_SEC = 50                 # an agent loop must not flood the people drawing
_rate, _rate_lock = {}, threading.Lock()


def _rate_ok(actor, n):
    """A one-second window per actor; a refused patch spends nothing."""
    now = time.time()
    with _rate_lock:
        start, used = _rate.get(actor, (now, 0))
        if now - start >= 1.0:
            start, used = now, 0
        if used + n > AGENT_OPS_PER_SEC:
            return False
        _rate[actor] = (start, used + n)
        return True


def _resolve(kind, rid):
    """A harman:// tile's current title, or None when its object is gone."""
    row = db.card_get(rid) if kind == "card" else db.note_get(rid) if kind == "note" else None
    return (row or {}).get("title") if row else None


def can_edit(principal):
    """Viewers watch; everyone else with a login draws."""
    return principal.get("human_role") != "viewer"


def presence_payload(msg):
    """Only the known presence fields go to peers — never arbitrary client JSON."""
    return {k: msg[k] for k in PRESENCE_KEYS if k in msg}


def _q(req, name):
    return (req.query.get(name) or [""])[0]


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


class CanvasBoardMixin:
    def _canvas_from_query(self, req, key="canvas"):
        return self._canvas_target(None, _q(req, key))

    def _canvas_target(self, project, canvas):
        """The canvas id for a project (made on first use) or an explicit
        canvas id; sends the 404 itself and returns None."""
        pid = _int(project)
        if pid is not None:
            if not db.project_get(pid):
                self.send_json({"error": "no such project"}, status=404)
                return None
            return db.canvas_board_for("project", pid)["id"]
        cid = _int(canvas)
        if cid is None or not db.canvas_board_get(cid):
            self.send_json({"error": "no such canvas (pass project or canvas)"}, status=404)
            return None
        return cid

    def _g_canvas_board(self, req):
        cid = self._canvas_target(_q(req, "project"), _q(req, "id"))
        if cid is None:
            return
        snap = ROOMS.get(cid).snapshot()
        snap["editable"] = can_edit(req.principal)
        self.send_json(snap)

    def _g_canvas_file(self, req):
        cid = self._canvas_from_query(req)
        if cid is None:
            return
        fid = _q(req, "file")
        got = db.canvas_file_get(cid, fid) if rec.ID_RE.match(fid) else None
        if not got:
            self.send_json({"error": "no such file"}, status=404)
            return
        mime, data = got
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        # Content-addressed: the id never names different bytes.
        self.send_header("Cache-Control", "private, max-age=31536000, immutable")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "sandbox")   # an SVG never runs script
        self.end_headers()
        self.wfile.write(bytes(data))

    def _p_canvas_file(self, req):
        if not can_edit(req.principal):
            self.send_json({"error": "read-only"}, status=403)
            return
        cid = self._canvas_from_query(req)
        if cid is None:
            return
        fid, mime = _q(req, "file"), _q(req, "mime")
        if not rec.ID_RE.match(fid) or mime not in FILE_MIMES:
            self.send_json({"error": "bad file id or type"}, status=400)
            return
        length = _int(self.headers.get("Content-Length"))
        if length is None or length <= 0 or length > MAX_FILE_BYTES:
            self.send_json({"error": "file must be 1 byte to 4 MiB"}, status=413)
            return
        data = self.rfile.read(length)
        db.canvas_file_put(cid, fid, mime, data, req.principal["actor"])
        self.send_json({"ok": True, "file": fid})

    def _g_canvas_ws(self, req):
        if req.principal["kind"] != "app":   # agents use canvas_read/canvas_patch
            self.send_json({"error": "not allowed"}, status=403)
            return
        cid = self._canvas_from_query(req)
        if cid is None:
            return
        from viewer.browser import WSServer
        ws = WSServer.upgrade(self)
        if not ws:
            return
        room, peer = ROOMS.get(cid), uuid.uuid4().hex[:12]
        actor, editable = req.principal["actor"], can_edit(req.principal)
        joined = False
        try:
            op, payload = ws.recv(max_payload=MAX_FRAME_BYTES)
            hello = _json(payload) if op == 0x1 else None
            if not hello or hello.get("t") != "hello" or hello.get("protocol") != rec.PROTOCOL:
                ws.send_text(json.dumps({"t": "reload", "protocol": rec.PROTOCOL}))
                return
            ws.send_text(json.dumps({"t": "hello", "peer": peer, "editable": editable,
                                     "protocol": rec.PROTOCOL}))
            sub = room.join(peer, ws.send_text, on_close=ws.close)
            joined = True
            while sub.alive:
                op, payload = ws.recv(max_payload=MAX_FRAME_BYTES)
                if op == 0x8:
                    break
                msg = _json(payload) if op == 0x1 else None
                if not msg:
                    continue
                if msg.get("t") == "presence":
                    room.presence(peer, presence_payload(msg))
                elif msg.get("t") == "elements" and isinstance(msg.get("elements"), list):
                    self._canvas_apply(room, sub, peer, actor, editable, msg["elements"])
        except OSError:
            pass
        finally:
            if joined:
                room.leave(peer)
            ws.close()

    # -- agents (MCP project_canvas_*) ------------------------------------------
    def _g_canvas_agent_read(self, req):
        cid = self._canvas_target(_q(req, "project"), _q(req, "canvas"))
        if cid is None:
            return
        out = canvas_summary.summarize(ROOMS.get(cid).snapshot()["elements"], _resolve)
        out["canvas"] = cid
        self.send_json(out)

    def _p_canvas_agent_patch(self, req):
        p = req.principal
        if p["kind"] == "app":   # people draw through the socket
            self.send_json({"error": "agents only"}, status=403)
            return
        if not can_edit(p):
            self.send_json({"error": "read-only"}, status=403)
            return
        body = self.read_body() or {}
        ops = body.get("ops")
        if not isinstance(ops, list):
            self.send_json({"error": "ops must be a list"}, status=400)
            return
        cid = self._canvas_target(body.get("project"), body.get("canvas"))
        if cid is None:
            return
        if not _rate_ok(p["actor"], len(ops)):
            self.send_json({"error": f"slow down: at most {AGENT_OPS_PER_SEC} ops a second"}, status=429)
            return
        try:
            accepted, results = ROOMS.get(cid).patch(ops, p["actor"], own_only=p.get("level") == "ic")
        except ValueError as e:
            self.send_json({"error": str(e)}, status=400)
            return
        ok = sum(1 for r in results if r.get("ok"))
        db.audit_append(p["actor"], "canvas_patch", f"canvas:{cid}",
                        f"{ok}/{len(results)} ops, {len(accepted)} elements")
        self.send_json({"canvas": cid, "accepted": [e["id"] for e in accepted], "results": results})

    def _g_canvas_agent_snapshot(self, req):
        cid = self._canvas_target(_q(req, "project"), _q(req, "canvas"))
        if cid is None:
            return
        els = ROOMS.get(cid).snapshot()["elements"]
        raw = _q(req, "bbox")
        try:
            box = [float(v) for v in raw.split(",")] if raw else None
            picked, area = canvas_render.select(els, canvas_summary.ink_groups(els),
                                                group=_q(req, "group") or None,
                                                frame=_q(req, "frame") or None, box=box)
        except ValueError as e:
            self.send_json({"error": str(e)}, status=400)
            return
        if not picked:
            self.send_json({"error": "nothing drawn there"}, status=400)
            return
        png = canvas_render.render(picked, area)
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(png)))
        self.end_headers()
        self.wfile.write(png)

    def _p_canvas_revert(self, req):
        p = req.principal
        if p["kind"] != "app" or not can_edit(p):   # the human's net, never an agent's
            self.send_json({"error": "not allowed"}, status=403)
            return
        body = self.read_body() or {}
        actor = body.get("actor")
        cid = self._canvas_target(None, body.get("canvas"))
        if cid is None:
            return
        if not isinstance(actor, str) or not actor.startswith("session:"):
            self.send_json({"error": "actor must be an agent (session:…)"}, status=400)
            return
        undone = ROOMS.get(cid).revert(actor, by=p["actor"])
        if undone:
            db.audit_append(p["actor"], "canvas_revert", f"canvas:{cid}", f"{actor}: {len(undone)} elements")
        self.send_json({"ok": True, "reverted": len(undone)})

    @staticmethod
    def _canvas_apply(room, sub, peer, actor, editable, elements):
        """Ack what won; for every loser send the stored winner so the client
        reverts to it (None = the element does not exist on the server)."""
        batch, over = elements[:MAX_BATCH], elements[MAX_BATCH:]
        if editable:
            accepted, rejected = room.apply(batch, peer_id=peer, actor=actor)
        else:
            accepted, rejected = [], [(e.get("id") if isinstance(e, dict) else None,
                                       "read-only", None) for e in batch]
        refused = [(e.get("id") if isinstance(e, dict) else None, "batch too large", None)
                   for e in over]
        sub.offer({"t": "ack", "ids": [e["id"] for e in accepted]})
        items = [(i, why, win) for i, why, win in rejected + refused]
        if items:
            stored = room.stored([i for i, _, w in items if w is None and i])
            sub.offer({"t": "reject",
                       "items": [[i, why, win if win is not None else stored.get(i)]
                                 for i, why, win in items]})

def _json(payload):
    try:
        msg = json.loads(payload)
    except (TypeError, ValueError):
        return None
    return msg if isinstance(msg, dict) else None
