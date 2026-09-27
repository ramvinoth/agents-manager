"""Notes — the knowledge ledger next to the board (viewer/db notes, the note_*
actions, the /api/org/notes routes, the MCP tools, and the session lifecycle
hooks). Hermetic: db is faked at the module seam, as in test_actions.
"""
import pytest

from viewer import actions, db, orglogic, viewer_mcp
from viewer.routes.orchestrator import OrchestratorMixin
from viewer.server import SessionViewerHandler


class FakeDB:
    def __init__(self):
        self.notes = {}
        self.audit = []
        self.approvals = []
        self.meta = {}

    def audit_append(self, actor, action, target=None, outcome=""):
        self.audit.append((action, outcome))

    def approval_open(self, kind, summary="", detail=None, created_by=""):
        row = {"id": len(self.approvals) + 1, "detail": detail}
        self.approvals.append(row)
        return row

    def note_create(self, title="", body="", kind="note", project_id=None, session_id=None,
                    created_by="", pinned=False):
        nid = len(self.notes) + 1
        self.notes[nid] = {"id": nid, "title": title, "body": body, "kind": kind,
                           "project_id": project_id, "session_id": session_id,
                           "created_by": created_by, "pinned": pinned, "archived": False}
        return self.notes[nid]

    def note_update(self, nid, **fields):
        row = self.notes.get(nid)
        if row:
            row.update(fields)
        return row

    def note_delete(self, nid):
        return bool(self.notes.pop(nid, None))

    def note_get(self, nid):
        return self.notes.get(nid)

    def note_list(self, session_id=None, project_id=None, archived=False):
        return [n for n in self.notes.values()
                if n["archived"] == archived
                and (session_id is None or n["session_id"] == session_id)
                and (project_id is None or n["project_id"] == project_id)]

    def session_meta_get(self, sid):
        return self.meta.get(sid)


@pytest.fixture
def fdb(monkeypatch):
    f = FakeDB()
    monkeypatch.setattr(actions, "db", f)
    import viewer.routes.orchestrator as orch
    monkeypatch.setattr(orch, "db", f)
    return f


class _Handler(OrchestratorMixin):
    def __init__(self, body=None):
        self.sent = None
        self._body = body

    def send_json(self, data, status=200):
        self.sent = (data, status)

    def read_body(self):
        return self._body


class _Req:
    def __init__(self, query=None, session="", level=""):
        self.query = query or {}
        self.principal = {"actor": "user:ram", "human_role": "owner",
                          "session_level": level, "session": session}


# ── policy tables ─────────────────────────────────────────────────────────────

def test_note_actions_are_registered_and_scoped():
    for a in ("note_create", "note_update", "note_delete"):
        assert a in actions.ACTIONS and orglogic._MIN_LEVEL[a] == "ic"
    assert orglogic.is_red("note_delete") and not orglogic.is_red("note_update")


def test_mcp_tools_and_routes_are_in_lockstep():
    """Every MCP tool proxies to a route the server actually serves, and every
    tool listed for the model has a proxy entry (no phantom tools)."""
    gets, posts = SessionViewerHandler.GET_ROUTES, SessionViewerHandler.POST_ROUTES
    for name, (method, path) in viewer_mcp._TOOLS.items():
        if name in viewer_mcp._PATH_ARG:
            continue
        table = gets if method == "GET" else posts
        assert path in table, (name, path)
    listed = {t["name"] for t in viewer_mcp._TOOL_LIST}
    assert listed <= set(viewer_mcp._TOOLS), listed - set(viewer_mcp._TOOLS)
    assert {"note_list", "note", "note_create", "note_update", "note_delete"} <= listed
    assert viewer_mcp._PROJECT_DEFAULT["note_list"] == "project"


# ── actions through the gate ─────────────────────────────────────────────────

def test_agent_create_and_archive_run_green(fdb):
    it = actions.intent("note_create", {"title": "Research", "body": "# x", "kind": "journal",
                                        "session": "s1", "project_id": 7}, "s1")
    payload, status = actions.execute(it, "owner", "ic", acting_session="s1")
    assert status == 200 and payload["kind"] == "journal" and payload["session_id"] == "s1"
    it = actions.intent("note_update", {"note_id": 1, "archived": True, "kind": "bogus"}, "s1")
    payload, _ = actions.execute(it, "owner", "ic", acting_session="s1")
    assert payload["archived"] is True
    assert ("note_update", "done") in fdb.audit


def test_agent_delete_queues_but_owner_deletes(fdb):
    fdb.note_create("t")
    it = actions.intent("note_delete", {"note_id": 1}, "s1")
    payload, _ = actions.execute(it, "owner", "ic", acting_session="s1")
    assert payload.get("queued") and 1 in fdb.notes
    payload, _ = actions.execute(it, "owner", "")
    assert payload == {"deleted": True} and 1 not in fdb.notes


# ── routes ───────────────────────────────────────────────────────────────────

def test_create_route_inherits_the_sessions_project(fdb):
    fdb.meta["s1"] = {"kanbanProject": "7"}
    h = _Handler({"title": "n", "session": "s1"})
    h._p_org_notes(_Req(session="s1"))
    data, status = h.sent
    assert status == 200 and data["project_id"] == 7 and data["created_by"] == "user:ram"


def test_list_route_filters_by_shelf_and_scope(fdb):
    fdb.note_create("a", session_id="s1", project_id=7)
    fdb.note_create("b", session_id="s2", project_id=7)
    fdb.note_update(2, archived=True)
    h = _Handler(); h._g_org_notes(_Req({"project": ["7"]}))
    assert [n["title"] for n in h.sent[0]["notes"]] == ["a"]
    h = _Handler(); h._g_org_notes(_Req({"project": ["7"], "archived": ["1"]}))
    assert [n["title"] for n in h.sent[0]["notes"]] == ["b"]
    h = _Handler(); h._g_org_notes(_Req({"session": ["s2"], "archived": ["true"]}))
    assert [n["title"] for n in h.sent[0]["notes"]] == ["b"]


def test_update_and_delete_routes_require_an_id(fdb):
    for fn in ("_p_org_notes_update", "_p_org_notes_delete"):
        h = _Handler({}); getattr(h, fn)(_Req())
        assert h.sent[1] == 400


def test_note_route_404s_on_missing(fdb):
    h = _Handler(); h._g_org_note(_Req({"id": ["9"]}))
    assert h.sent[1] == 404
    h = _Handler(); h._g_org_note(_Req())
    assert h.sent[1] == 400


# ── lifecycle hooks (the SQL helpers exist with the lifecycle signature) ─────

def test_lifecycle_helpers_exist():
    assert callable(db.notes_archive_for_session) and callable(db.notes_delete_for_session)
    assert "journal" in db.NOTE_KINDS
