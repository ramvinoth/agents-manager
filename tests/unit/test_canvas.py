"""Canvas routes: an agent writes only its own session's canvases; the owner
reads any session's and may close one; a viewer-role human only reads.
Storage is monkeypatched (unit tests never touch Postgres)."""
import pytest

from viewer import db
from viewer.routes import canvas
from viewer.routes.canvas import CanvasMixin

AGENT = {"kind": "mcp", "session": "sess-a", "human_role": "owner"}
OWNER = {"kind": "app", "session": "", "human_role": "owner"}
VIEWER = {"kind": "app", "session": "", "human_role": "viewer"}


class _Req:
    def __init__(self, principal, query=None):
        self.principal = principal
        self.query = query or {}


class _Handler(CanvasMixin):
    sid_from_path = staticmethod(lambda rel: None)

    def __init__(self, body=None):
        self._body = body
        self.sent = None

    def read_body(self):
        return self._body

    def send_json(self, data, status=200):
        self.sent = (data, status)


@pytest.fixture
def store(monkeypatch):
    rows = {}

    def upsert(sid, title, kind, content, cap):
        key = (sid, title)
        if key not in rows and sum(1 for k in rows if k[0] == sid) >= cap:
            return None
        v = rows[key]["version"] + 1 if key in rows else 1
        rows[key] = {"session_id": sid, "title": title, "kind": kind,
                     "content": content, "version": v}
        return dict(rows[key])

    monkeypatch.setattr(db, "canvas_upsert", upsert)
    monkeypatch.setattr(db, "canvas_get", lambda sid, t: rows.get((sid, t)))
    monkeypatch.setattr(db, "canvas_list", lambda sid: [r for k, r in rows.items() if k[0] == sid])
    monkeypatch.setattr(db, "canvas_delete", lambda sid, t: rows.pop((sid, t), None) is not None)
    return rows


def test_validate_rejects_each_bad_field():
    assert canvas.validate("", "markdown", "x") == "title required"
    assert "title longer" in canvas.validate("t" * 121, "markdown", "x")
    assert "kind must be" in canvas.validate("t", "pdf", "x")
    assert canvas.validate("t", "mermaid", "  \n") == "content required"
    assert "larger than" in canvas.validate("t", "html", "x" * (canvas.MAX_CONTENT + 1))
    assert canvas.validate("t", "slides", "# a\n---\n# b") is None


def test_agent_show_lands_in_its_own_session_whatever_the_body_says(store):
    h = _Handler({"title": "Flow", "kind": "mermaid", "content": "graph TD;A-->B",
                  "session": "someone-else"})
    h._p_canvas_show(_Req(AGENT))
    assert h.sent == ({"shown": True, "title": "Flow", "kind": "mermaid", "version": 1}, 200)
    assert list(store) == [("sess-a", "Flow")]


def test_reshowing_a_title_replaces_and_bumps_version(store):
    for content in ("v1", "v2"):
        h = _Handler({"title": "Plan", "kind": "markdown", "content": content})
        h._p_canvas_show(_Req(AGENT))
    assert h.sent[0]["version"] == 2 and store[("sess-a", "Plan")]["content"] == "v2"


def test_cap_refuses_a_new_title_but_still_updates_an_existing_one(store, monkeypatch):
    monkeypatch.setattr(canvas, "MAX_PER_SESSION", 1)
    _Handler({"title": "A", "kind": "markdown", "content": "a"})._p_canvas_show(_Req(AGENT))
    h = _Handler({"title": "B", "kind": "markdown", "content": "b"})
    h._p_canvas_show(_Req(AGENT))
    assert h.sent[1] == 409
    h = _Handler({"title": "A", "kind": "markdown", "content": "a2"})
    h._p_canvas_show(_Req(AGENT))
    assert h.sent[1] == 200


def test_a_human_cannot_write_a_canvas(store):
    h = _Handler({"title": "X", "kind": "markdown", "content": "x", "session": "sess-a"})
    h._p_canvas_show(_Req(OWNER))
    assert h.sent[1] == 403 and not store


def test_owner_lists_and_reads_any_session_by_id(store):
    _Handler({"title": "Flow", "kind": "mermaid", "content": "g"})._p_canvas_show(_Req(AGENT))
    h = _Handler()
    h._g_canvas(_Req(OWNER, {"session": ["sess-a"]}))
    assert [c["title"] for c in h.sent[0]["canvases"]] == ["Flow"]
    h._g_canvas(_Req(OWNER, {"session": ["sess-a"], "title": ["Flow"]}))
    assert h.sent[0]["content"] == "g"
    h._g_canvas(_Req(OWNER, {"session": ["sess-a"], "title": ["Nope"]}))
    assert h.sent[1] == 404


def test_owner_without_a_session_is_a_400(store):
    h = _Handler()
    h._g_canvas(_Req(OWNER))
    assert h.sent[1] == 400


def test_agent_reads_only_its_own_session(store):
    store[("sess-b", "Secret")] = {"title": "Secret", "content": "s"}
    h = _Handler()
    h._g_canvas(_Req(AGENT, {"session": ["sess-b"], "title": ["Secret"]}))
    assert h.sent[1] == 404


def test_delete_owner_yes_viewer_no_agent_only_own(store):
    store[("sess-a", "A")] = {"title": "A"}
    store[("sess-b", "B")] = {"title": "B"}
    h = _Handler({"session": "sess-a", "title": "A"})
    h._p_canvas_delete(_Req(VIEWER))
    assert h.sent[1] == 403 and ("sess-a", "A") in store
    h = _Handler({"session": "sess-b", "title": "B"})
    h._p_canvas_delete(_Req(AGENT))       # pinned to sess-a: no B there
    assert h.sent[1] == 404 and ("sess-b", "B") in store
    h = _Handler({"session": "sess-a", "title": "A"})
    h._p_canvas_delete(_Req(OWNER))
    assert h.sent == ({"deleted": True}, 200) and ("sess-a", "A") not in store
