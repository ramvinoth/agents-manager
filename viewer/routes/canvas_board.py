"""viewer.routes.canvas_board — CanvasBoardMixin: the shared project canvas.

GET  /api/canvas/board?project=<id> | ?id=<canvas> | ?session=<sid>   snapshot (gzipped JSON);
                                                      session = that chat's board project
GET  /api/canvas/file?canvas=&file=                   one content-addressed file
POST /api/canvas/file?canvas=&file=&mime=             raw body, first write wins
GET  /api/canvas/ws?canvas=<id>                       the room socket
GET  /api/canvas/agent/read?project=|canvas=          agent summary (ink, frames, refs)
POST /api/canvas/agent/patch {project|canvas, ops}    agent add/update/delete ops
GET  /api/canvas/agent/snapshot?project=|canvas=&group=|frame=|bbox=x0,y0,x1,y1   PNG
POST /api/canvas/revert {canvas, actor}               a person undoes an agent's last patch
POST /api/canvas/show {title, kind, content, project?} an agent places/replaces a doc tile

Socket protocol (viewer/canvas_room.py holds the room):
  client → {"t":"hello","protocol":N}            mismatch → {"t":"reload"} + close
  client → {"t":"elements","elements":[...]}     → {"t":"ack","ids":[...]} and,
                                                    for losers, {"t":"reject","items":[...]}
  client → {"t":"presence", ...}                 relayed to peers, lossy
  server → {"t":"elements"|"presence"|"leave"|"checksum"|"resync"|"ping"}
The snapshot always comes over HTTP: on (re)connect a client fetches it, then
resends whatever it has not had acked.
"""
import hashlib
import json
import re
import threading
import time
import uuid

from viewer import canvas_reconcile as rec
from viewer import canvas_render, canvas_summary
from viewer import db, engine, orglogic
from viewer.canvas_room import ROOMS

MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_FRAME_BYTES = 8 * 1024 * 1024      # a 2000-element paste is ~1-2 MiB
MAX_BATCH = 2000                       # elements per message; the rest are refused
FILE_MIMES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}
PRESENCE_KEYS = ("pointer", "button", "selected", "name", "color")
AGENT_OPS_PER_SEC = 50                 # an agent loop must not flood the people drawing
_rate, _rate_lock = {}, threading.Lock()
_show_lock = threading.Lock()

# Doc tiles (canvas_show): a markdown/mermaid/html/slides document an agent
# pins to its project's canvas. The content is a content-addressed canvas file;
# the tile is an embeddable whose link is agents://doc/<file id>.
DOC_KINDS = ("markdown", "mermaid", "html", "slides")
DOC_MIME = "text/plain; charset=utf-8"   # served under CSP sandbox, rendered by the client
MAX_CONTENT = 512 * 1024      # chars; a tile is a view, not a file store
MAX_TITLE = 120
MAX_PER_SESSION = 20
DOC_GAP = 40


SHORT_ACTOR = re.compile(r"^session:[0-9a-f]{8}$")


def actor_names(elements, name_of):
    """{actor: display name} for agent actors named only by a short session id
    (tiles from before agents were labelled). A doc tile records its session's
    full id, which name_of turns into the chat's title. Labelled actors
    (session:Manager) already read as names, so they are left out. Pure."""
    full = {}
    for e in elements:
        cd = e.get("customData") or {}
        actor, sid = cd.get("createdBy") or "", (cd.get("doc") or {}).get("session") or ""
        if SHORT_ACTOR.match(actor) and sid.startswith(actor[8:]):
            full[actor] = sid
    names = {}
    for actor, sid in full.items():
        name = name_of(sid)
        if name:
            names[actor] = name
    return names


def session_name(sid):
    explicit, first = engine._session_title(sid)
    return explicit or first


def validate(title, kind, content):
    """The error sentence for a bad doc tile, or None. Pure, for tests."""
    if not title:
        return "title required"
    if len(title) > MAX_TITLE:
        return f"title longer than {MAX_TITLE} characters"
    if kind not in DOC_KINDS:
        return f"kind must be one of: {', '.join(DOC_KINDS)}"
    if not content.strip():
        return "content required"
    if len(content) > MAX_CONTENT:
        return f"content larger than {MAX_CONTENT // 1024} KB — show a summary and link the file"
    return None


def doc_ops(elements, session, title, kind, file_id):
    """The patch that shows a doc: update the session's tile with this title,
    else add one below everything on the canvas. None = the session is at its
    tile cap. Pure, for tests."""
    live = [e for e in elements if not e.get("isDeleted")]
    mine = [e for e in live if ((e.get("customData") or {}).get("doc") or {}).get("session") == session]
    doc = {"title": title, "kind": kind, "file": file_id, "session": session}
    link = f"agents://doc/{file_id}"
    same = next((e for e in mine if e["customData"]["doc"].get("title") == title), None)
    if same:
        return [{"op": "update", "id": same["id"], "set": {
            "link": link, "customData": {**same["customData"], "doc": doc}}}]
    if len(mine) >= MAX_PER_SESSION:
        return None
    y = max((float(e.get("y") or 0) + float(e.get("height") or 0) for e in live), default=-DOC_GAP) + DOC_GAP
    return [{"op": "add", "element": {"type": "embeddable", "x": 0, "y": y,
                                      "link": link, "customData": {"doc": doc}}}]


def migrate_legacy_canvases():
    """Boot, before any room loads: every row of the retired per-session
    `canvases` pane becomes a doc tile on its project's canvas (else the
    session's), then the table goes. Idempotent: the table's absence is the
    done-marker, and a re-run after a crash re-shows by title (no duplicates).
    Returns how many docs moved."""
    from viewer import canvas_patch
    rows = db.legacy_canvases()
    if rows is None:
        return 0
    for r in rows:
        sid = r["session_id"]
        pid = _int((db.session_meta_get(sid) or {}).get("kanbanProject"))
        board = (db.canvas_board_for("project", pid) if pid is not None and db.project_get(pid)
                 else db.canvas_board_for("session", sid))
        data = (r["content"] or "").encode("utf-8")
        fid = hashlib.sha256(data).hexdigest()
        stored = {e["id"]: e for e in db.canvas_elements_load(board["id"])}
        kind = r["kind"] if r["kind"] in DOC_KINDS else "markdown"
        ops = doc_ops(list(stored.values()), sid, r["title"][:MAX_TITLE], kind, fid)
        if ops is None:
            continue
        actor = f"session:{sid[:8]}"
        out, _ = canvas_patch.build(stored, ops, actor, False)
        db.canvas_file_put(board["id"], fid, DOC_MIME, data, actor)
        db.canvas_elements_upsert(board["id"], out, actor)
    db.legacy_canvases_drop()
    return len(rows)


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


def resolver():
    """How a canvas's agents:// tiles resolve: the object's current title, or
    None when it is gone. A Sift id has no cheap lookup, so it names itself."""

    def resolve(kind, rid):
        if kind == "card":
            return (db.card_get(rid) or {}).get("title")
        if kind == "note":
            return (db.note_get(rid) or {}).get("title")
        if kind == "inbox":
            row = db.inbox_get(rid)
            return ((row.get("body") or "").strip().splitlines() or ["(empty message)"])[0][:80] if row else None
        return rid
    return resolve


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
        project, sid = _q(req, "project"), _q(req, "session")
        if sid and not project and not _q(req, "id"):
            meta = db.session_meta_get(sid) or {}
            project = orglogic.resolve_board_project(None, meta.get("kanbanProject"))
            if project is None:
                self.send_json({"error": "this chat has no board yet — pick a project on the company screen"}, status=404)
                return
        cid = self._canvas_target(project, _q(req, "id"))
        if cid is None:
            return
        snap = ROOMS.get(cid).snapshot()
        snap["editable"] = can_edit(req.principal)
        snap["actors"] = actor_names(snap["elements"], session_name)
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
        out = canvas_summary.summarize(ROOMS.get(cid).snapshot()["elements"], resolver())
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

    def _p_canvas_show(self, req):
        """Place or replace a doc tile on the session's project canvas. Agents
        only: it is the session's output — a person edits by asking the agent
        (or by drawing beside it). Showing a title again replaces it in place."""
        p = req.principal
        if p["kind"] != "mcp":
            self.send_json({"error": "only an agent session shows docs"}, status=403)
            return
        if not can_edit(p):
            self.send_json({"error": "read-only"}, status=403)
            return
        body = self.read_body() or {}
        title = str(body.get("title") or "").strip()
        kind = str(body.get("kind") or "markdown").strip().lower()
        content = str(body.get("content") or "")
        err = validate(title, kind, content)
        if err:
            self.send_json({"error": err}, status=400)
            return
        meta = db.session_meta_get(p["session"]) or {}
        pid = orglogic.resolve_board_project(_int(body.get("project")), meta.get("kanbanProject"))
        if pid is None:
            self.send_json({"error": "this chat has no project yet, so it has no canvas — "
                                     "pass project, or ask the owner to attach one"}, status=409)
            return
        cid = self._canvas_target(pid, None)
        if cid is None:
            return
        data = content.encode("utf-8")
        fid = hashlib.sha256(data).hexdigest()
        room = ROOMS.get(cid)
        db.canvas_file_put(cid, fid, DOC_MIME, data, p["actor"])
        # Snapshot -> patch as one step: two shows of one title must replace,
        # not add twice (and the cap must count the first).
        with _show_lock:
            ops = doc_ops(room.snapshot()["elements"], p["session"], title, kind, fid)
            if ops is None:
                self.send_json({"error": f"this session already shows {MAX_PER_SESSION} docs — "
                                         "replace one by reusing its title, or delete one with canvas_patch"},
                               status=409)
                return
            accepted, results = room.patch(ops, p["actor"], own_only=p.get("level") == "ic")
        if not results[0].get("ok"):
            self.send_json({"error": results[0].get("error") or "not shown"}, status=409)
            return
        db.audit_append(p["actor"], "canvas_show", f"canvas:{cid}", f"{kind}: {title}")
        self.send_json({"shown": True, "title": title, "kind": kind, "canvas": cid,
                        "project": pid, "element": results[0]["ids"][0]})

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
