"""Intake channels (viewer/intake.py): a URL + token onto one board.

Covers the pure shaping (payload → card), the token contract (hash stored,
constant-time verify, never in a view), delivery through actions.execute
(rate limit, authority, created_by ledger), the public door's HTTP refusals,
the owner's in-app feedback routing, and the Red gate on opening a door.
The db is faked; nothing here touches Postgres or the network.
"""
import pytest

from viewer import actions, db, intake
from viewer.routes.intake import IntakeMixin
from viewer.routes.usage import UsageMixin

CH = {"id": "ch_abc", "name": "Website form", "project_id": 15,
      "session_id": "sess-1", "token_hash": intake.hash_token("hin_good")}


# -- pure ---------------------------------------------------------------------
def test_card_fields_title_body_and_leftover_payload():
    title, body = intake.card_fields("Form", {"title": "  Hi\nthere ", "text": "Long text",
                                              "from": "a@b.c", "url": "https://x",
                                              "plan": "pro", "token": "hin_secret"}, "an external sender")
    assert title == "Hi there"
    assert body.startswith('Via intake channel "Form" from an external sender.')
    assert "Sender: a@b.c" in body and "Link: https://x" in body and "Long text" in body
    assert '"plan": "pro"' in body
    assert "hin_secret" not in body          # a token in the body never lands on the card


def test_card_fields_fallbacks_and_truncation():
    assert intake.card_fields("CI", {}, "x")[0] == "Event from CI"
    assert intake.card_fields("CI", "plain string", "x")[0] == "plain string"
    t, b = intake.card_fields("CI", {"text": "w" * 500, "blob": "z" * 20000}, "x")
    assert len(t) == intake.TITLE_MAX and t.endswith("…")
    assert len(b) == intake.BODY_MAX


def test_token_hash_verify_and_view():
    tok, digest = intake.new_token()
    assert tok.startswith("hin_") and digest == intake.hash_token(tok) and tok not in digest
    ch = {"id": "ch_1", "token_hash": digest}
    assert intake.verify(ch, tok)
    assert not intake.verify(ch, tok + "x") and not intake.verify(ch, "") and not intake.verify(None, tok)
    v = intake.view(ch)
    assert "token_hash" not in v and v["path"] == "/api/intake/ch_1"


def test_channel_id_of_reads_only_a_door_card():
    assert intake.channel_id_of({"created_by": "intake:ch_feedback"}) == "ch_feedback"
    assert intake.channel_id_of({"created_by": "user:ram"}) == ""
    assert intake.channel_id_of({}) == "" and intake.channel_id_of(None) == ""


def test_door_session_is_the_doors_binding_for_its_own_unbound_cards():
    door = {"id": "ch_1", "session_id": "sess-x"}
    card = {"created_by": "intake:ch_1", "session_id": ""}
    assert intake.door_session(card, door) == "sess-x"
    assert intake.door_session(dict(card, session_id="sess-y"), door) == "", "already bound: kept"
    assert intake.door_session(dict(card, created_by="intake:ch_2"), door) == "", "another door"
    assert intake.door_session(dict(card, created_by="user:ram"), door) == "", "typed on the board"
    assert intake.door_session(card, dict(door, session_id="")) == "", "door wakes nobody"
    assert intake.door_session(card, None) == "" and intake.door_session(None, door) == ""


# -- deliver ------------------------------------------------------------------
class FakeDB:
    def __init__(self):
        self.cards, self.audit, self.approvals, self.intakes = [], [], [], []

    def audit_append(self, actor, action, target=None, outcome=""):
        self.audit.append((actor, action, outcome))

    def approval_open(self, kind, summary="", detail=None, created_by=""):
        self.approvals.append(detail)
        return {"id": len(self.approvals)}

    def board_columns_list(self, project_id):
        return [{"id": 70, "name": "Todo", "position": 0}, {"id": 77, "name": "Done", "position": 7}]

    def card_create(self, title, body="", column_id=None, project_id=None,
                    session_id=None, position=1.0, created_by=""):
        row = {"id": 9, "title": title, "body": body, "column_id": column_id,
               "project_id": project_id, "session_id": "", "created_by": created_by}
        self.cards.append(row)
        return row

    def project_get(self, pid):
        return {"id": pid} if pid == 15 else None

    def intake_create(self, cid, name, project_id, session_id, token_hash, app_feedback, created_by):
        row = {"id": cid, "name": name, "project_id": project_id, "session_id": session_id,
               "token_hash": token_hash, "app_feedback": app_feedback}
        self.intakes.append(row)
        return row


@pytest.fixture
def fdb(monkeypatch):
    f = FakeDB()
    monkeypatch.setattr(actions, "db", f)
    monkeypatch.setattr(db, "intake_touch", lambda cid: 1)
    return f


def test_outside_sender_creates_a_todo_card_at_least_authority(fdb):
    resp, status = intake.deliver(CH, {"title": "Help"}, "an external sender")
    assert status == 200 and resp["id"] == 9
    card = fdb.cards[0]
    assert card["column_id"] == 70 and card["project_id"] == 15
    assert card["created_by"] == "intake:ch_abc"
    assert fdb.audit[-1][0] == "intake:ch_abc"


def test_owner_feedback_keeps_owner_actor_but_channel_ledger(fdb):
    intake.deliver(CH, {"text": "bad"}, "user:ram", human_role="owner", session_level="", actor="user:ram")
    assert fdb.cards[0]["created_by"] == "intake:ch_abc"
    assert fdb.audit[-1][0] == "user:ram"


def test_rate_limit_refuses_before_any_card(fdb, monkeypatch):
    monkeypatch.setattr(db, "intake_touch", lambda cid: intake.RATE_PER_HOUR + 1)
    resp, status = intake.deliver(CH, {"title": "x"}, "s")
    assert status == 429 and not fdb.cards


def test_opening_a_door_is_red_for_an_agent_and_token_only_on_owner_create(fdb):
    it = actions.intent("intake_create", {"name": "Form", "project_id": 15, "reason": "stale"}, "agent:x")
    resp, _ = actions.execute(it, "owner", "lead", "sess-x")
    assert resp.get("queued") and not fdb.intakes and "token" not in resp
    resp, status = actions.execute(actions.intent("intake_create", {"name": "Form", "project_id": 15},
                                                  "user:ram"), "owner", "")
    assert status == 200 and resp["token"].startswith("hin_") and "token_hash" not in resp
    assert not any(resp["token"] in str(d) for d in fdb.approvals)


def test_intake_create_validates(fdb):
    for args in ({"name": "", "project_id": 15}, {"name": "F"}, {"name": "F", "project_id": 99}):
        resp, _ = actions.execute(actions.intent("intake_create", args, "user:ram"), "owner", "")
        assert "error" in resp
    assert not fdb.intakes


# -- the public door ------------------------------------------------------------
class _Req:
    def __init__(self, path, query=None):
        self.path, self.query = path, query or {}


class _Door(IntakeMixin):
    def __init__(self, body, headers):
        self._body, self.headers, self.sent = body, headers, None

    def read_body(self):
        return self._body

    def send_json(self, data, status=200):
        self.sent = (data, status)


@pytest.fixture
def door(monkeypatch):
    calls = []
    monkeypatch.setattr(db, "intake_get", lambda cid: CH if cid == "ch_abc" else None)
    monkeypatch.setattr(intake, "deliver", lambda ch, body, origin, **kw: (calls.append(body) or ({"id": 5}, 200)))

    def post(body=None, headers=None, path="/api/intake/ch_abc", query=None):
        h = _Door(body, {"Content-Length": "10", **(headers or {})})
        h._p_intake(_Req(path, query))
        return h.sent
    post.calls = calls
    return post


def test_door_refusals(door):
    assert door({"a": 1}, path="/api/intake/ch_nope")[1] == 404
    assert door({"a": 1}, {"Content-Length": str(10 ** 6)}, )[1] == 413
    assert door(None, {"X-Intake-Token": "hin_good"})[1] == 400
    assert door({"a": 1}, {"X-Intake-Token": "hin_bad"})[1] == 401
    assert door({"a": 1})[1] == 401
    assert not door.calls


@pytest.mark.parametrize("headers,query,body", [
    ({"X-Intake-Token": "hin_good"}, None, {"t": 1}),
    ({"Authorization": "Bearer hin_good"}, None, {"t": 1}),
    ({}, {"token": ["hin_good"]}, {"t": 1}),
    ({}, None, {"t": 1, "token": "hin_good"}),
])
def test_door_accepts_every_token_carrier(door, headers, query, body):
    assert door(body, headers, query=query) == ({"ok": True, "card": 5}, 200)


# -- in-app feedback routing ----------------------------------------------------
class _Usage(UsageMixin):
    pass


NOTE = {"kind": "feedback", "surface": "profile", "detail": "UI is bad", "client": "ios"}
P = {"actor": "user:ram", "human_role": "owner"}


class FeedbackDB:
    """The db surface feedback_channel() resolves through."""

    def __init__(self, flagged=None, existing=None, create_raises=False):
        self.flagged, self.existing, self.create_raises = flagged, existing, create_raises
        self.created, self.updated, self.ensured = [], [], []

    def intake_feedback_channel(self):
        return self.flagged

    def intake_get(self, cid):
        return self.existing if self.existing and self.existing["id"] == cid else None

    def intake_update(self, cid, **fields):
        self.updated.append((cid, fields))
        return {**self.existing, **fields}

    def project_ensure(self, host, cwd, name, created_by=""):
        self.ensured.append((host, cwd, name))
        return {"id": 15}

    def intake_create(self, cid, name, project_id, session_id, token_hash, app_feedback, created_by):
        if self.create_raises:
            self.existing = {"id": cid, "project_id": 15, "app_feedback": True}
            raise RuntimeError("duplicate key")
        row = {"id": cid, "name": name, "project_id": project_id, "session_id": session_id,
               "token_hash": token_hash, "app_feedback": app_feedback, "created_by": created_by}
        self.created.append(row)
        return row


def _patch_feedback_db(monkeypatch, f):
    for name in ("intake_feedback_channel", "intake_get", "intake_update",
                 "project_ensure", "intake_create"):
        monkeypatch.setattr(db, name, getattr(f, name))


def test_feedback_channel_prefers_the_owners_pick(monkeypatch):
    f = FeedbackDB(flagged=CH)
    _patch_feedback_db(monkeypatch, f)
    assert intake.feedback_channel() is CH
    assert not f.created and not f.updated and not f.ensured


def test_feedback_channel_opens_the_built_in_one_on_the_servers_own_project(monkeypatch):
    from viewer import config
    f = FeedbackDB()
    _patch_feedback_db(monkeypatch, f)
    ch = intake.feedback_channel()
    assert ch["id"] == intake.FEEDBACK_CHANNEL_ID and ch["app_feedback"] is True
    assert ch["project_id"] == 15 and ch["session_id"] == "" and ch["created_by"] == "system"
    assert f.ensured == [("local", str(config.STATIC_DIR), config.STATIC_DIR.name)]
    assert len(ch["token_hash"]) == 64          # a hash only: the token itself is discarded


def test_feedback_channel_reflags_the_built_in_one_never_duplicates(monkeypatch):
    f = FeedbackDB(existing={"id": intake.FEEDBACK_CHANNEL_ID, "project_id": 15, "app_feedback": False})
    _patch_feedback_db(monkeypatch, f)
    ch = intake.feedback_channel()
    assert ch["app_feedback"] is True and not f.created
    assert f.updated == [(intake.FEEDBACK_CHANNEL_ID, {"app_feedback": True})]


def test_feedback_channel_concurrent_open_uses_the_winner(monkeypatch):
    f = FeedbackDB(create_raises=True)
    _patch_feedback_db(monkeypatch, f)
    assert intake.feedback_channel()["id"] == intake.FEEDBACK_CHANNEL_ID


def test_deliver_into_a_named_column_finds_or_creates_it(fdb, monkeypatch):
    asked = []
    monkeypatch.setattr(db, "board_column_ensure",
                        lambda pid, name: (asked.append((pid, name)) or {"id": 88, "name": name}))
    intake.deliver(CH, {"text": "bad"}, "user:ram", human_role="owner", session_level="",
                   actor="user:ram", column=intake.FEEDBACK_COLUMN)
    assert asked == [(15, "Feedback")] and fdb.cards[0]["column_id"] == 88


def test_feedback_goes_to_the_feedback_column_as_the_owner(monkeypatch):
    seen = []
    monkeypatch.setattr(intake, "feedback_channel", lambda: CH)
    monkeypatch.setattr(intake, "deliver", lambda ch, payload, origin, **kw:
                        (seen.append((ch, payload, origin, kw)) or ({"id": 42}, 200)))
    assert _Usage()._feedback_to_board(P, [NOTE]) == [42]
    ch, payload, origin, kw = seen[0]
    assert ch is CH and payload["title"] == "Feedback · profile: UI is bad"
    assert "user:ram" in origin and "ios profile screen" in origin
    assert kw == {"human_role": "owner", "session_level": "", "actor": "user:ram",
                  "column": "Feedback"}


def test_feedback_delivery_failure_never_fails_the_post(monkeypatch):
    def boom():
        raise RuntimeError("db down")
    monkeypatch.setattr(intake, "feedback_channel", boom)
    assert _Usage()._feedback_to_board(P, [NOTE]) == []


# -- keyed posts: one thing, one card ------------------------------------------
class KeyedDB(FakeDB):
    """FakeDB plus the card thread, enough for an update to run through actions."""

    def __init__(self):
        super().__init__()
        self.comments, self.keys = [], {}

    def card_get(self, card_id):
        return next((c for c in self.cards if c["id"] == card_id), None)

    def card_update(self, card_id, **fields):
        card = self.card_get(card_id)
        card.update(fields)
        return card

    def card_move(self, card_id, column_id, position=None):
        return self.card_update(card_id, column_id=column_id)

    def card_comment_add(self, card_id, author, body):
        self.comments.append((card_id, author, body))
        return {"id": len(self.comments), "card_id": card_id, "author": author, "body": body}

    def __getattr__(self, name):          # board bookkeeping the handlers touch: no-ops
        return lambda *a, **k: None


@pytest.fixture
def kdb(monkeypatch):
    f = KeyedDB()
    monkeypatch.setattr(actions, "db", f)
    monkeypatch.setattr(db, "intake_touch", lambda cid: 1)
    monkeypatch.setattr(db, "board_columns_list", f.board_columns_list)
    monkeypatch.setattr(db, "card_get", f.card_get)
    monkeypatch.setattr(db, "intake_card", lambda cid, key: next(
        (f.card_get(i) for i, k in f.keys.items() if k == key), None))
    monkeypatch.setattr(db, "intake_card_key", lambda card_id, key: f.keys.__setitem__(card_id, key) or True)
    pushes = []
    from viewer import push
    monkeypatch.setattr(push, "notify_all", lambda title, body, data=None: pushes.append((title, body)))
    f.pushes = pushes
    return f


UNBOUND = dict(CH, session_id="")


def test_options_reads_key_and_done_strictly():
    assert intake.options({"key": " mem_1 ", "done": True}) == ("mem_1", True)
    assert intake.options({"key": {"x": 1}, "done": "true"}) == ("", False), "only a string key, only a real true"
    assert intake.options("plain text") == ("", False)
    title, body = intake.card_fields("C", {"title": "t", "key": "k", "done": True, "kind": "sale"}, "s")
    assert '"key"' not in body and '"done"' not in body and '"kind"' in body


def test_done_event_lands_in_done_tagged_and_pushes_when_no_session_reads_it(kdb):
    resp, status = intake.deliver(UNBOUND, {"title": "Sale: Pro", "text": "x bought Pro", "key": "mem_1", "done": True}, "s")
    assert status == 200 and kdb.cards[0]["column_id"] == 77
    assert kdb.keys == {9: "mem_1"}
    assert kdb.pushes == [("Card 9 · Sale: Pro", "x bought Pro")]


def test_bound_door_does_not_push_its_session_reads_it(kdb):
    intake.deliver(dict(CH, session_id="s1"), {"title": "t", "key": "k"}, "s")
    assert kdb.pushes == []


def test_owner_feedback_never_pushes_the_owner(kdb):
    intake.deliver(UNBOUND, {"text": "bad"}, "user:ram", human_role="owner", session_level="", actor="user:ram")
    assert kdb.pushes == []


def test_same_key_updates_the_card_comments_and_files_it_done(kdb):
    intake.deliver(UNBOUND, {"title": "Sale: Pro", "text": "bought", "key": "mem_1"}, "s")
    assert kdb.cards[0]["column_id"] == 70
    resp, status = intake.deliver(UNBOUND, {"title": "Sale: Pro (cancelled)", "text": "cancelled", "key": "mem_1", "done": True}, "s")
    assert status == 200 and resp.get("updated") and len(kdb.cards) == 1
    card = kdb.cards[0]
    assert card["title"] == "Sale: Pro (cancelled)" and card["column_id"] == 77
    assert kdb.comments == [(9, "intake:ch_abc", "cancelled")]


def test_another_key_opens_another_card(kdb):
    intake.deliver(UNBOUND, {"title": "a", "key": "mem_1"}, "s")
    kdb.card_create = lambda *a, **k: (FakeDB.card_create(kdb, *a, **k) | {"id": 10})
    intake.deliver(UNBOUND, {"title": "b", "key": "mem_2"}, "s")
    assert len(kdb.cards) == 2


def test_update_is_rate_limited_too(kdb, monkeypatch):
    intake.deliver(UNBOUND, {"title": "a", "key": "mem_1"}, "s")
    monkeypatch.setattr(db, "intake_touch", lambda cid: intake.RATE_PER_HOUR + 1)
    resp, status = intake.deliver(UNBOUND, {"title": "b", "key": "mem_1"}, "s")
    assert status == 429 and kdb.comments == []
