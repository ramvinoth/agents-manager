"""session_mode_set + per-session permission mode + the push payload's deep-link
shape.

One goal, four contracts: a TRUSTED session can run without a Bash approval per
command, and the trust that grants it can only come from the owner:

- orglogic: session_mode_set is Red (a model never grants itself trust) and
  ic-scoped (anyone may REQUEST; the owner must consent).
- actions.execute: an agent's request QUEUES for the owner (the intent stored
  for replay; nothing written until approval); the owner at the UI self-
  approves and the write lands in session_meta; an invalid mode is rejected.
- engine.effective_permission_mode: the stored mode OVERRIDES the requested
  one (loop runs hardcode 'acceptEdits'; the owner's stored call wins); an
  unknown value or a DB hiccup leaves the requested mode untouched, so a
  storage failure can never change a run's security posture on its own.
- push.build_payload: tappable data must ride the ROOT `body` key —
  expo-notifications' EXNotificationSerializer exposes a REMOTE notification's
  content.data from that key only. Before this, the data was merged into the
  alert and a tap just opened the app instead of the chat.
- routes._p_session_mode: the target travels as `for_session` (the MCP
  transport overwrites the body's `session` with the caller's own id); a
  session may never target itself (the self-mutation rail); humans pass
  `session`.

db, the loop store and push are all faked: the logic under test is pure
policy over a db it only calls, so no Postgres and no network are needed.
"""
import pytest

from viewer import actions, engine, orglogic, push
from viewer.routes import orchestrator
from viewer.routes.orchestrator import OrchestratorMixin
from viewer.routes.sessions import SessionsMixin


# ── orglogic: the action's class and scope ─────────────────────────────────

def test_session_mode_set_is_red_and_ic_scoped():
    assert orglogic.classify_action("session_mode_set") == "red"
    assert orglogic.allowed("session_mode_set", "ic")
    assert orglogic.allowed("session_mode_set", "manager")
    assert orglogic.PERMISSION_MODES == ("default", "acceptEdits", "plan", "bypass")


# ── actions.execute: an agent queues, the owner writes ─────────────────────

class FakeDb:
    def __init__(self):
        self.meta = {}
        self.audit = []
        self.approvals = []

    def session_meta_get(self, sid):
        return dict(self.meta.get(sid, {}))

    def session_meta_patch(self, sid, fields):
        self.meta.setdefault(sid, {}).update(fields)
        return self.meta[sid]

    def audit_append(self, actor, action, target, outcome):
        self.audit.append((actor, action, target, outcome))

    def approval_open(self, kind, summary, detail, created_by):
        self.approvals.append({"id": f"ap{len(self.approvals) + 1}", "kind": kind,
                               "summary": summary, "detail": detail,
                               "created_by": created_by})
        return self.approvals[-1]


@pytest.fixture
def adb(monkeypatch):
    f = FakeDb()
    monkeypatch.setattr(actions, "db", f)
    return f


def test_agent_request_queues_for_the_owner(adb):
    resp, status = actions.execute(
        actions.intent("session_mode_set", {"session": "sess-rsi", "mode": "bypass"},
                       "employee:rsi"),
        "owner", "ic", acting_session="sess-rsi")
    assert status == 200 and resp.get("queued") is True
    assert "employee:rsi: session_mode_set" in adb.approvals[0]["summary"]
    assert adb.meta == {}, "nothing is written until the owner approves"


def test_owner_at_ui_self_approves_and_the_write_lands(adb):
    resp, status = actions.execute(
        actions.intent("session_mode_set", {"session": "sess-life", "mode": "bypass"},
                       "user:ram"),
        "owner", "")
    assert status == 200 and resp == {"session": "sess-life", "permission_mode": "bypass"}
    assert adb.meta["sess-life"]["permission_mode"] == "bypass"
    assert adb.approvals == [], "the owner's own click is the approval"


def test_invalid_mode_is_rejected(adb):
    resp, status = actions.execute(
        actions.intent("session_mode_set", {"session": "s", "mode": "superuser"},
                       "user:ram"),
        "owner", "")
    assert status == 200 and "error" in resp and "superuser" not in resp
    assert adb.meta == {}


# ── engine.effective_permission_mode: stored wins, failures are inert ──────

class MetaDb:
    def __init__(self, meta=None, raises=False):
        self.meta = meta or {}
        self.raises = raises

    def session_meta_get(self, sid):
        if self.raises:
            raise RuntimeError("db down")
        return dict(self.meta.get(sid, {}))


def test_stored_mode_overrides_the_requested_one(monkeypatch):
    monkeypatch.setattr(engine, "db", MetaDb({"s": {"permission_mode": "bypass"}}))
    assert engine.effective_permission_mode("s", "acceptEdits") == "bypass"


def test_no_stored_mode_keeps_the_requested_one(monkeypatch):
    monkeypatch.setattr(engine, "db", MetaDb({}))
    assert engine.effective_permission_mode("s", "acceptEdits") == "acceptEdits"


def test_an_unknown_stored_value_keeps_the_requested_one(monkeypatch):
    monkeypatch.setattr(engine, "db", MetaDb({"s": {"permission_mode": "superuser"}}))
    assert engine.effective_permission_mode("s", "acceptEdits") == "acceptEdits"


def test_a_db_hiccup_keeps_the_requested_one(monkeypatch):
    monkeypatch.setattr(engine, "db", MetaDb(raises=True))
    assert engine.effective_permission_mode("s", "acceptEdits") == "acceptEdits"


def test_an_empty_session_id_never_reaches_the_db(monkeypatch):
    def boom(_):
        raise AssertionError("no lookup for an empty session id")
    monkeypatch.setattr(engine, "db", type("D", (), {"session_meta_get": staticmethod(boom)}))
    assert engine.effective_permission_mode("", "acceptEdits") == "acceptEdits"


# ── push.build_payload: the deep-link data must ride the root `body` key ───

def test_payload_without_data_has_no_body_key():
    p = push.build_payload("T", "B")
    assert p == {"aps": {"alert": {"title": "T", "body": "B"}, "sound": "default"}}
    assert "body" not in p, "no tappable data → no body key"


def test_payload_data_lands_in_the_root_body():
    data = {"session": "s", "host": "local"}
    p = push.build_payload("T", "B", data)
    assert p["body"] == data, "EXNotificationSerializer reads content.data from here"
    assert p["aps"]["alert"] == {"title": "T", "body": "B"}


def test_payload_truncates_the_alert_body():
    p = push.build_payload("T", "B" * 400)
    assert len(p["aps"]["alert"]["body"]) == 300


# ── engine._perm_push_body: the owner can judge from the notification ──────

def test_bash_preview_collapses_whitespace():
    assert engine._perm_push_body("Bash", {"command": "git  status &&\n  ls -la"},
                                  "local") == "Approve Bash? — git status && ls -la"


def test_long_bash_is_truncated():
    body = engine._perm_push_body("Bash", {"command": "x" * 120}, "local")
    assert body.startswith("Approve Bash? — ") and body.endswith("…")
    assert len(body) < 100


def test_remote_host_is_named():
    assert engine._perm_push_body("Bash", {"command": "ls"}, "suha-ai") == \
        "Approve Bash? — ls (on suha-ai)"


def test_non_bash_tools_show_their_args():
    assert engine._perm_push_body("Edit", {"file_path": "/x"}, "local") == \
        'Approve Edit? — {"file_path": "/x"}'


# ── routes._p_session_mode: who may target what ────────────────────────────

class _Handler(SessionsMixin, OrchestratorMixin):
    def __init__(self, principal, body):
        self.req = type("Req", (), {"principal": principal})()
        self._body = body
        self.sent = None

    def read_body(self):
        return self._body

    def send_json(self, data, status=200):
        self.sent = (data, status)


def _it(principal, body):
    return _Handler(principal, body)


def test_agent_targets_another_session_via_for_session(monkeypatch):
    f = FakeDb()
    monkeypatch.setattr(actions, "db", f)
    h = _it({"actor": "employee:rsi", "human_role": "owner",
             "session_level": "ic", "session": "sess-rsi"},
            {"for_session": "sess-life", "mode": "bypass"})
    h._p_session_mode(h.req)
    assert h.sent[0].get("queued") is True, "Red → the owner decides"
    assert f.meta == {}
    assert f.audit and f.audit[-1][3] == "queued:red"


def test_agent_cannot_target_its_own_session(monkeypatch):
    f = FakeDb()
    monkeypatch.setattr(actions, "db", f)
    # The self-mutation denial is audited by the route itself (before any
    # action is dispatched), so it reads the orchestrator module's db seam.
    monkeypatch.setattr(orchestrator, "db", f)
    # The MCP transport mirrors the caller's id into `session`; with no
    # for_session the target falls onto the mirrored value = itself.
    h = _it({"actor": "employee:rsi", "human_role": "owner",
             "session_level": "ic", "session": "sess-rsi"},
            {"session": "sess-rsi", "mode": "bypass"})
    h._p_session_mode(h.req)
    assert h.sent[1] == 403 and h.sent[0].get("denied") is True
    assert f.approvals == [], "not even the request reaches the owner's queue"
    assert f.meta == {}
    assert f.audit[-1][1:] == ("self_mutation", {"session": "sess-rsi", "what": "its own permission mode"},
                               "denied:self_mutation")


def test_human_at_ui_passes_session_directly(monkeypatch):
    f = FakeDb()
    monkeypatch.setattr(actions, "db", f)
    h = _it({"actor": "user:ram", "human_role": "owner",
             "session_level": "", "session": ""},
            {"session": "sess-life", "mode": "bypass"})
    h._p_session_mode(h.req)
    assert h.sent == ({"session": "sess-life", "permission_mode": "bypass"}, 200)
    assert f.meta["sess-life"]["permission_mode"] == "bypass"


def test_no_target_is_a_plain_error(monkeypatch):
    f = FakeDb()
    monkeypatch.setattr(actions, "db", f)
    h = _it({"actor": "user:ram", "human_role": "owner",
             "session_level": "", "session": ""}, {"mode": "bypass"})
    h._p_session_mode(h.req)
    assert h.sent == ({"error": "session required"}, 400)
