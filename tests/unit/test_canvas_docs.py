"""Doc tiles (canvas_show) on the project canvas, and the boot move of the
retired per-session pane into them. Storage is faked: no Postgres."""
import pytest

from viewer import canvas_room as cr
from viewer import db
from viewer.routes import canvas_board as cb

AGENT = {"kind": "mcp", "session": "sess-a", "actor": "session:sess-a", "human_role": "owner", "level": "ic"}
HUMAN = {"kind": "app", "session": "", "actor": "user:o", "human_role": "owner"}


def test_validate_rejects_each_bad_field():
    assert cb.validate("", "markdown", "x") == "title required"
    assert "title longer" in cb.validate("t" * 121, "markdown", "x")
    assert "kind must be" in cb.validate("t", "pdf", "x")
    assert cb.validate("t", "mermaid", "  \n") == "content required"
    assert "larger than" in cb.validate("t", "html", "x" * (cb.MAX_CONTENT + 1))
    assert cb.validate("t", "slides", "a\n---\nb") is None


def _tile(i, session, title, y=0, h=320, deleted=False):
    return {"id": i, "type": "embeddable", "y": y, "height": h, "isDeleted": deleted,
            "customData": {"doc": {"session": session, "title": title}}}


def test_doc_ops_replaces_by_title_and_adds_below_everything():
    els = [_tile("a", "s1", "Plan", y=0), {"id": "r", "type": "rectangle", "y": 500, "height": 100}]
    (op,) = cb.doc_ops(els, "s1", "Plan", "markdown", "f" * 64)
    assert op["op"] == "update" and op["id"] == "a"
    assert op["set"]["link"] == "agents://doc/" + "f" * 64
    (op,) = cb.doc_ops(els, "s1", "Other", "mermaid", "e" * 64)
    assert op["op"] == "add" and op["element"]["y"] == 640    # 600 bottom + gap
    # another session's tile of the same title is not mine to replace
    assert cb.doc_ops(els, "s2", "Plan", "markdown", "f" * 64)[0]["op"] == "add"
    # a deleted tile neither matches nor counts
    assert cb.doc_ops([_tile("d", "s1", "Plan", deleted=True)], "s1", "Plan", "markdown", "f" * 64)[0]["op"] == "add"


def test_doc_ops_cap_blocks_a_new_title_but_not_a_replace():
    els = [_tile(f"t{i}", "s1", f"T{i}") for i in range(cb.MAX_PER_SESSION)]
    assert cb.doc_ops(els, "s1", "New", "markdown", "f" * 64) is None
    assert cb.doc_ops(els, "s1", "T3", "markdown", "f" * 64)[0]["op"] == "update"


class _Req:
    def __init__(self, principal):
        self.principal = principal
        self.query = {}


class _Handler(cb.CanvasBoardMixin):
    def __init__(self, body):
        self._body, self.sent = body, None

    def read_body(self):
        return self._body

    def send_json(self, data, status=200):
        self.sent = (data, status)


@pytest.fixture
def canvas(monkeypatch):
    reg = cr.Registry(loader=lambda cid: [], saver=lambda *a: None)
    files, audit = {}, []
    monkeypatch.setattr(cb, "ROOMS", reg)
    monkeypatch.setattr(db, "session_meta_get", lambda sid: {"kanbanProject": "15"})
    monkeypatch.setattr(db, "project_get", lambda pid: {"id": pid} if pid == 15 else None)
    monkeypatch.setattr(db, "canvas_board_for", lambda kind, rid: {"id": 7})
    monkeypatch.setattr(db, "canvas_file_put", lambda cid, fid, mime, data, actor: files.__setitem__(fid, data))
    monkeypatch.setattr(db, "audit_append", lambda *a: audit.append(a))
    return reg.get(7), files, audit


def show(principal, **body):
    h = _Handler({"title": "Plan", "kind": "markdown", "content": "# hi", **body})
    h._p_canvas_show(_Req(principal))
    return h.sent


def test_show_places_then_replaces_one_tile(canvas):
    room, files, audit = canvas
    data, status = show(AGENT)
    assert status == 200 and data["project"] == 15 and data["canvas"] == 7
    data2, _ = show(AGENT, content="# v2")
    live = [e for e in room.snapshot()["elements"] if not e.get("isDeleted")]
    assert len(live) == 1 and live[0]["id"] == data["element"] == data2["element"]
    assert live[0]["type"] == "embeddable" and live[0]["link"].startswith("agents://doc/")
    assert files[live[0]["link"].rsplit("/", 1)[1]] == b"# v2"
    assert [a[1] for a in audit] == ["canvas_show", "canvas_show"]


def test_show_refuses_humans_viewers_bad_input_and_no_project(canvas, monkeypatch):
    assert show(HUMAN)[1] == 403
    assert show({**AGENT, "human_role": "viewer"})[1] == 403
    assert show(AGENT, kind="pdf")[1] == 400
    monkeypatch.setattr(db, "session_meta_get", lambda sid: {})
    assert show(AGENT)[1] == 409
    assert show(AGENT, project=99)[1] == 404          # named a project that does not exist


def test_show_cap_is_409_and_replace_still_works(canvas, monkeypatch):
    monkeypatch.setattr(cb, "MAX_PER_SESSION", 2)
    assert show(AGENT, title="A")[1] == 200
    assert show(AGENT, title="B")[1] == 200
    assert show(AGENT, title="C")[1] == 409
    assert show(AGENT, title="A", content="again")[1] == 200


@pytest.fixture
def legacy(monkeypatch):
    rows = [{"session_id": "aaaaaaaa-1", "title": "Plan", "kind": "markdown", "content": "# a"},
            {"session_id": "aaaaaaaa-1", "title": "Plan", "kind": "markdown", "content": "# a2"},
            {"session_id": "bbbbbbbb-2", "title": "Loose", "kind": "weird", "content": "x"}]
    state = {"table": True, "boards": {}, "files": {}}
    meta = {"aaaaaaaa-1": {"kanbanProject": "15"}, "bbbbbbbb-2": {}}

    def board_for(kind, rid):
        return {"id": 1 if kind == "project" else 2}

    def upsert(cid, els, actor):
        cur = state["boards"].setdefault(cid, {})
        for e in els:
            cur[e["id"]] = e

    monkeypatch.setattr(db, "legacy_canvases", lambda: list(rows) if state["table"] else None)
    monkeypatch.setattr(db, "legacy_canvases_drop", lambda: state.__setitem__("table", False))
    monkeypatch.setattr(db, "session_meta_get", lambda sid: meta.get(sid))
    monkeypatch.setattr(db, "project_get", lambda pid: {"id": pid} if pid == 15 else None)
    monkeypatch.setattr(db, "canvas_board_for", board_for)
    monkeypatch.setattr(db, "canvas_elements_load", lambda cid: list(state["boards"].get(cid, {}).values()))
    monkeypatch.setattr(db, "canvas_elements_upsert", upsert)
    monkeypatch.setattr(db, "canvas_file_put", lambda cid, fid, m, d, a: state["files"].__setitem__(fid, d))
    return state


def test_migration_moves_each_doc_once_then_drops_the_table(legacy):
    assert cb.migrate_legacy_canvases() == 3
    proj, sess = legacy["boards"][1], legacy["boards"][2]
    (tile,) = proj.values()                                # the same title replaced, not duplicated
    assert legacy["files"][tile["link"].rsplit("/", 1)[1]] == b"# a2"
    assert tile["customData"]["createdBy"] == "session:aaaaaaaa"
    (loose,) = sess.values()                               # no project: the session's own board
    assert loose["customData"]["doc"]["kind"] == "markdown"  # unknown kind falls back
    assert legacy["table"] is False
    assert cb.migrate_legacy_canvases() == 0               # done-marker: nothing again


def board(**query):
    req = _Req(HUMAN)
    req.query = {k: [v] for k, v in query.items()}
    h = _Handler({})
    h._g_canvas_board(req)
    return h.sent


def test_board_by_session_uses_that_chats_project_else_a_plain_404(canvas, monkeypatch):
    data, status = board(session="sess-a")
    assert status == 200 and data["canvas"] == 7 and data["editable"] is True
    monkeypatch.setattr(db, "session_meta_get", lambda sid: None)
    data, status = board(session="sess-new")
    assert status == 404 and "no board yet" in data["error"]
    assert board(session="sess-new", project="15")[1] == 200     # an explicit project still wins


def test_actor_names_names_only_short_session_actors_from_their_tile():
    full = "65cf166a-e3e9-4b72-8a9e-15f8d8d2dd49"
    els = [
        {"id": "a", "customData": {"createdBy": "session:65cf166a", "doc": {"session": full}}},
        {"id": "b", "customData": {"createdBy": "session:Manager", "doc": {"session": full}}},
        {"id": "c", "customData": {"createdBy": "session:dbd49b66", "doc": {"session": full}}},  # wrong prefix
        {"id": "d", "customData": {"createdBy": "session:0000aaaa"}},                            # no tile
        {"id": "e", "customData": {"createdBy": "user:o"}},
        {"id": "f"},
    ]
    asked = []
    names = cb.actor_names(els, lambda sid: asked.append(sid) or "Jarvis")
    assert names == {"session:65cf166a": "Jarvis"}
    assert asked == [full]
    assert cb.actor_names(els, lambda sid: "") == {}
