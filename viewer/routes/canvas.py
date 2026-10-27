"""viewer.routes.canvas — CanvasMixin: the on-demand visual pane.

A session opens a canvas when a picture beats prose — a flow it is designing, a
comparison, a walkthrough, a small interactive HTML mock — and the owner's
client shows it beside the chat. Canvases are SESSION OUTPUT, like the
transcript: only the session itself writes them (its MCP principal), so they
skip the org action gate and the audit log (a diagram revised twenty times is
not twenty org decisions). The owner reads any session's canvases and may
close (delete) one; a viewer-role human may only read.

Rows are keyed by (session, title): showing a title again replaces it, so an
agent revises in place instead of piling up tabs.
"""
from viewer import db

KINDS = ("markdown", "mermaid", "html", "slides")
MAX_CONTENT = 512 * 1024      # chars; a canvas is a view, not a file store
MAX_TITLE = 120
MAX_PER_SESSION = 20


def validate(title, kind, content):
    """The error sentence for a bad canvas, or None. Pure, for tests."""
    if not title:
        return "title required"
    if len(title) > MAX_TITLE:
        return f"title longer than {MAX_TITLE} characters"
    if kind not in KINDS:
        return f"kind must be one of: {', '.join(KINDS)}"
    if not content.strip():
        return "content required"
    if len(content) > MAX_CONTENT:
        return f"content larger than {MAX_CONTENT // 1024} KB — show a summary and link the file"
    return None


class CanvasMixin:
    def _canvas_session(self, req, value):
        """The session a request addresses. An agent is pinned to its own
        session (whatever the body says); the owner names one by id or path."""
        p = req.principal
        if p["kind"] == "mcp":
            return p["session"]
        value = str(value or "")
        return self.sid_from_path(value) or value.rsplit("/", 1)[-1].removesuffix(".jsonl")

    def _g_canvas(self, req):
        """List a session's canvases (no content), or read one with ?title=."""
        q = req.query
        sid = self._canvas_session(req, (q.get("session") or [""])[0])
        if not sid:
            self.send_json({"error": "session required"}, status=400)
            return
        title = (q.get("title") or [""])[0].strip()
        if title:
            row = db.canvas_get(sid, title)
            if not row:
                self.send_json({"error": f"no canvas titled {title!r}"}, status=404)
                return
            self.send_json(row)
            return
        self.send_json({"canvases": db.canvas_list(sid)})

    def _p_canvas_show(self, req):
        """Create or replace a canvas. Agents only: it is the session's own
        output, and a human edits by telling the agent, not by overwriting."""
        p = req.principal
        if p["kind"] != "mcp":
            self.send_json({"error": "only an agent session shows canvases"}, status=403)
            return
        body = self.read_body() or {}
        title = str(body.get("title") or "").strip()
        kind = str(body.get("kind") or "markdown").strip().lower()
        content = str(body.get("content") or "")
        err = validate(title, kind, content)
        if err:
            self.send_json({"error": err}, status=400)
            return
        row = db.canvas_upsert(p["session"], title, kind, content, MAX_PER_SESSION)
        if row is None:
            self.send_json({"error": f"this session already has {MAX_PER_SESSION} canvases — "
                                     "replace one by reusing its title, or canvas_delete one"},
                           status=409)
            return
        self.send_json({"shown": True, "title": row["title"], "kind": row["kind"],
                        "version": row["version"]})

    def _p_canvas_delete(self, req):
        """Remove one canvas: the agent from its own session, or a human who
        may act (operator/owner) from any session."""
        p = req.principal
        if p["kind"] == "app" and p.get("human_role") == "viewer":
            self.send_json({"error": "not allowed"}, status=403)
            return
        body = self.read_body() or {}
        sid = self._canvas_session(req, body.get("session"))
        title = str(body.get("title") or "").strip()
        if not sid or not title:
            self.send_json({"error": "session and title required"}, status=400)
            return
        if not db.canvas_delete(sid, title):
            self.send_json({"error": f"no canvas titled {title!r}"}, status=404)
            return
        self.send_json({"deleted": True})
