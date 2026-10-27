"""Note discussions — the message board under every note (viewer/discussion,
the note_comment / note_vote actions, their routes and MCP tools). Hermetic:
db, push and the wake are faked at the module seams."""
import pytest

from viewer import actions, boardwatch, discussion, orglogic, viewer_mcp
from viewer.routes.orchestrator import OrchestratorMixin
from viewer.server import SessionViewerHandler


def _c(id, parent=None, at=None, score=0, author="session:a"):
    return {"id": id, "parent_id": parent, "created_at": at if at is not None else id,
            "score": score, "author": author}


# ── pure thread logic ────────────────────────────────────────────────────────

def test_thread_nests_replies_and_ranks_best_by_score_then_age():
    flat = [_c(1), _c(2, score=3), _c(3, parent=1), _c(4, parent=1, score=2), _c(5, score=3)]
    t = discussion.thread(flat, "best")
    assert [c["id"] for c in t] == [2, 5, 1]                    # ties: the first answer stays on top
    assert [c["id"] for c in t[2]["replies"]] == [4, 3]


def test_thread_new_and_old_orders_and_orphans_are_never_lost():
    flat = [_c(1), _c(2), _c(3, parent=99)]                     # parent gone → promoted to top
    assert [c["id"] for c in discussion.thread(flat, "new")] == [3, 2, 1]
    assert [c["id"] for c in discussion.thread(flat, "old")] == [1, 2, 3]
    assert [c["id"] for c in discussion.thread(flat, "bogus")] == [1, 2, 3]   # falls back to best


def test_runaway_needs_a_full_window_of_agents():
    agents = [_c(i) for i in range(discussion.RUNAWAY_LIMIT)]
    assert discussion.runaway(agents)
    assert not discussion.runaway(agents[:-1])                  # not enough yet
    assert not discussion.runaway(agents[:-1] + [_c(99, author="user:ram")])


def test_recipients_skip_the_commenter_and_dedupe():
    note, parent = {"session_id": "s1"}, {"session_id": "s2"}
    assert discussion.recipients(note, parent, "s3") == ["s1", "s2"]
    assert discussion.recipients(note, parent, "s1") == ["s2"]   # never a self-wake
    assert discussion.recipients(note, {"session_id": "s1"}, "") == ["s1"]
    assert discussion.recipients({"session_id": None}, None, "") == []


def test_deleting_a_session_clears_its_notes_recipient_wakes(monkeypatch):
    """A note's discussion wakes are addressed to the REPLIERS (nd<note>:<other>),
    not the note's owner — so deleting the owner's session and its loops
    (loop_delete_for_session) would leave those wakes to fire against a note that
    is gone. purge_session_notes closes that leak: delete the notes AND clear
    each one's wakes, and touch no other note's."""
    f = FakeDB()                                  # note 1 → s1, note 2 → s9
    monkeypatch.setattr(discussion, "db", f)
    f.loops = {"nd1:s2": {}, "nd1:s5": {},        # note 1's wakes, addressed to repliers
               "nd2:s3": {}}                       # a different note's wake — must survive
    removed = discussion.purge_session_notes("s1")
    assert removed == 1 and 1 not in f.notes
    assert "nd1:s2" not in f.loops and "nd1:s5" not in f.loops, "the owner's note's wakes must go"
    assert "nd2:s3" in f.loops, "another note's wake must be untouched"


# ── actions + follow-up through the gate ─────────────────────────────────────

class FakeDB:
    def __init__(self):
        self.notes = {1: {"id": 1, "title": "Pricing research", "session_id": "s1",
                          "created_by": "user:ram"},
                      2: {"id": 2, "title": "Other", "session_id": "s9",
                          "created_by": "session:x"}}
        self.comments, self.votes, self.audit = [], {}, []

    def audit_append(self, *a, **k):
        self.audit.append(a[1])

    def note_get(self, nid):
        return self.notes.get(nid)

    def note_comment_add(self, note_id, parent_id, author, session_id, body):
        row = {"id": len(self.comments) + 1, "note_id": note_id, "parent_id": parent_id,
               "author": author, "session_id": session_id, "body": body,
               "created_at": len(self.comments)}
        self.comments.append(row)
        return {**row, "score": 0, "my_vote": 0}

    def note_comment_get(self, cid):
        return next((c for c in self.comments if c["id"] == cid), None)

    def note_comment_list(self, note_id, voter=""):
        return [c for c in self.comments if c["note_id"] == note_id]

    def note_vote_set(self, cid, voter, value):
        if value:
            self.votes[(cid, voter)] = value
        else:
            self.votes.pop((cid, voter), None)
        return sum(v for (c, _), v in self.votes.items() if c == cid)

    # -- session-delete cleanup surface ------------------------------------
    def notes_delete_for_session(self, session_id):
        gone = [nid for nid, n in self.notes.items() if n.get("session_id") == session_id]
        for nid in gone:
            del self.notes[nid]
        return gone

    def loop_delete_prefix(self, prefix):
        self.loops = getattr(self, "loops", {})
        gone = [lid for lid in self.loops if lid.startswith(prefix)]
        for lid in gone:
            del self.loops[lid]
        return len(gone)


@pytest.fixture
def env(monkeypatch):
    f = FakeDB()
    wakes, pushes = [], []
    monkeypatch.setattr(actions, "db", f)
    monkeypatch.setattr(discussion, "db", f)
    monkeypatch.setattr(boardwatch, "schedule_once",
                        lambda lid, sid, prompt, origin: wakes.append((lid, sid, origin, prompt)))
    from viewer import push
    monkeypatch.setattr(push, "notify_all", lambda t, b, data=None: pushes.append((t, data)))
    return f, wakes, pushes


def _comment(note_id, body, actor, session="", parent=None, level="ic"):
    it = actions.intent("note_comment", {"note_id": note_id, "parent_id": parent, "body": body,
                                         "author": actor, "session_id": session}, actor)
    return actions.execute(it, "owner", level if session else "", acting_session=session)


def test_actions_registered_green_at_ic():
    for a in ("note_comment", "note_vote"):
        assert a in actions.ACTIONS and orglogic._MIN_LEVEL[a] == "ic"
        assert not orglogic.is_red(a)


def test_agent_comment_wakes_note_session_and_pushes_owner_on_their_note(env):
    f, wakes, pushes = env
    payload, status = _comment(1, "Competitor X charges $49", "session:researcher", "s2")
    assert status == 200 and payload["author"] == "session:researcher" and payload["session_id"] == "s2"
    assert [(w[0], w[1], w[2]) for w in wakes] == [("nd1:s1", "s1", "harman")]
    assert "note_comments note_id=1" in wakes[0][3] and "parent_id=1" in wakes[0][3]
    assert pushes == [("Note 1 · Pricing research", {"note": 1})]   # the owner wrote the note


def test_owner_reply_wakes_both_sessions_as_user_origin_and_never_pushes(env):
    f, wakes, pushes = env
    _comment(1, "first", "session:researcher", "s2")
    wakes.clear(); pushes.clear()
    _comment(1, "Use $39", "user:ram", "", parent=1)
    assert sorted((w[1], w[2]) for w in wakes) == [("s1", "user"), ("s2", "user")]
    assert pushes == []


def test_agent_to_agent_never_pages_the_owner_and_never_self_wakes(env):
    f, wakes, pushes = env
    payload, _ = _comment(2, "draft", "session:x", "s9")             # own note, own session
    assert wakes == [] and pushes == []
    _comment(2, "challenge", "session:y", "s3", parent=payload["id"])
    assert [w[1] for w in wakes] == ["s9"] and pushes == []


def test_agent_reply_to_the_owner_pushes(env):
    f, wakes, pushes = env
    owner, _ = _comment(2, "question?", "user:ram", "")
    pushes.clear()
    _comment(2, "answer", "session:x", "s9", parent=owner["id"])
    assert pushes == [("Note 2 · Other", {"note": 2})]


def test_runaway_guard_stops_agent_wakes_until_a_human_speaks(env):
    f, wakes, pushes = env
    for i in range(discussion.RUNAWAY_LIMIT):
        _comment(2, f"agent {i}", "session:y", "s3")
    wakes.clear()
    _comment(2, "one more", "session:y", "s3")
    assert wakes == []
    _comment(2, "humans can always wake", "user:ram", "")
    assert [w[1] for w in wakes] == ["s9"]


def test_comment_rejects_empty_missing_and_cross_note_parent(env):
    f, wakes, pushes = env
    assert _comment(1, "  ", "user:ram")[0] == {"error": "empty comment"}
    assert _comment(9, "x", "user:ram")[0] == {"error": "not found"}
    other, _ = _comment(2, "on note 2", "user:ram")
    assert _comment(1, "x", "user:ram", parent=other["id"])[0]["error"].startswith("parent")


def test_vote_one_per_voter_never_own_and_withdrawable(env):
    f, _, _ = env
    c, _ = _comment(1, "claim", "session:researcher", "s2")

    def vote(value, voter):
        it = actions.intent("note_vote", {"comment_id": c["id"], "value": value, "voter": voter}, voter)
        return actions.execute(it, "owner", "")[0]
    assert vote(1, "user:ram")["score"] == 1
    assert vote(1, "user:ram")["score"] == 1                         # idempotent
    assert vote(-1, "s3")["score"] == 0
    assert vote(0, "s3")["score"] == 1
    assert "own" in vote(1, "s2")["error"]                          # the author's session
    assert "value" in vote(5, "user:ram")["error"]


# ── routes + MCP ─────────────────────────────────────────────────────────────

class _Handler(OrchestratorMixin):
    def __init__(self, body=None):
        self.sent, self._body = None, body

    def send_json(self, data, status=200):
        self.sent = (data, status)

    def read_body(self):
        return self._body


class _Req:
    def __init__(self, query=None, session="", actor="user:ram"):
        self.query = query or {}
        self.principal = {"actor": actor, "human_role": "owner",
                          "session_level": "ic" if session else "", "session": session}


def test_routes_stamp_author_and_session_from_the_principal(env, monkeypatch):
    f, _, _ = env
    import viewer.routes.orchestrator as orch
    monkeypatch.setattr(orch, "db", f)
    h = _Handler({"note_id": 1, "body": "hi", "author": "user:forged", "session_id": "forged"})
    h._p_org_note_comment(_Req(session="s2", actor="session:researcher"))
    assert h.sent[0]["author"] == "session:researcher" and h.sent[0]["session_id"] == "s2"
    h = _Handler(); h._g_org_note_comments(_Req({"note_id": ["1"]}))
    assert h.sent[0]["count"] == 1 and h.sent[0]["comments"][0]["replies"] == []
    h = _Handler(); h._g_org_note_comments(_Req())
    assert h.sent[1] == 400


def test_mcp_tools_proxy_to_served_routes():
    gets, posts = SessionViewerHandler.GET_ROUTES, SessionViewerHandler.POST_ROUTES
    listed = {t["name"] for t in viewer_mcp._TOOL_LIST}
    for name in ("note_comments", "note_comment", "note_vote"):
        method, path = viewer_mcp._TOOLS[name]
        assert name in listed and path in (gets if method == "GET" else posts)
