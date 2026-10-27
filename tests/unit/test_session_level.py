"""Manager authority level per session — the org-side twin of permission mode.

Two layers, one each, never duplicated:
- permission mode (session_mode_set) gates the CLI's OWN tools inside a run;
- level (session_level_set) gates the org actions a session asks the server for.

Contracts pinned here:
- engine.resolve_level: owner's per-chat override → the agent role's level →
  'ic'; unknown values and a DB hiccup land on 'ic' (never an escalation).
- session_level_set: Red + ic scope; an agent's ask queues, the owner's click
  writes; "" clears the override; a bad level is rejected.
- actions.execute: an agent asking ABOVE its level queues for the owner (with
  a reason) instead of a flat 403 — but only when the human could do it.
"""
import pytest

from viewer import actions, engine, inbox, orglogic


class MetaDb:
    def __init__(self, meta=None, templates=None, raises=False):
        self.meta, self.templates, self.raises = meta or {}, templates or {}, raises

    def session_meta_get(self, sid):
        if self.raises:
            raise RuntimeError("db down")
        return dict(self.meta.get(sid, {}))

    def agent_template_get(self, tid):
        return self.templates.get(tid)


# ── engine.resolve_level ───────────────────────────────────────────────────

def test_override_beats_the_role(monkeypatch):
    monkeypatch.setattr(engine, "db", MetaDb({"s": {"level": "manager", "agentTemplate": 1}},
                                             {1: {"level": "lead"}}))
    assert engine.resolve_level("s") == "manager"


def test_role_level_when_no_override(monkeypatch):
    monkeypatch.setattr(engine, "db", MetaDb({"s": {"agentTemplate": 1, "level": None}},
                                             {1: {"level": "lead"}}))
    assert engine.resolve_level("s") == "lead"


def test_plain_chat_is_ic(monkeypatch):
    monkeypatch.setattr(engine, "db", MetaDb({}))
    assert engine.resolve_level("s") == "ic"


def test_unknown_values_fall_to_ic(monkeypatch):
    monkeypatch.setattr(engine, "db", MetaDb({"s": {"level": "god", "agentTemplate": 9}},
                                             {9: {"level": "ceo"}}))
    assert engine.resolve_level("s") == "ic"


def test_deleted_role_falls_to_ic(monkeypatch):
    monkeypatch.setattr(engine, "db", MetaDb({"s": {"agentTemplate": 9}}))
    assert engine.resolve_level("s") == "ic"


def test_db_hiccup_is_ic(monkeypatch):
    monkeypatch.setattr(engine, "db", MetaDb(raises=True))
    assert engine.resolve_level("s") == "ic"


# ── session_level_set through execute ──────────────────────────────────────

class FakeDb:
    def __init__(self):
        self.meta, self.audit, self.approvals = {}, [], []

    def session_meta_patch(self, sid, fields):
        self.meta.setdefault(sid, {}).update(fields)
        return self.meta[sid]

    def audit_append(self, actor, action, target, outcome):
        self.audit.append((actor, action, outcome))

    def approval_open(self, kind, summary, detail, created_by):
        self.approvals.append({"id": f"ap{len(self.approvals) + 1}", "detail": detail,
                               "summary": summary, "created_by": created_by})
        return self.approvals[-1]


@pytest.fixture
def adb(monkeypatch):
    f = FakeDb()
    monkeypatch.setattr(actions, "db", f)
    monkeypatch.setattr(inbox, "deliver_red", lambda ap: None)
    return f


def test_agent_ask_for_a_level_queues(adb):
    resp, status = actions.execute(
        actions.intent("session_level_set", {"session": "x", "level": "manager", "reason": "needs loops"},
                       "session:RSI"), "owner", "ic", acting_session="rsi")
    assert status == 200 and resp["queued"] is True
    assert adb.meta == {}
    assert adb.approvals[0]["detail"]["queued"] == "red"


def test_owner_sets_and_clears_a_level(adb):
    resp, status = actions.execute(
        actions.intent("session_level_set", {"session": "x", "level": "lead"}, "user:ram"), "owner", "")
    assert status == 200 and adb.meta["x"]["level"] == "lead"
    actions.execute(actions.intent("session_level_set", {"session": "x", "level": ""}, "user:ram"),
                    "owner", "")
    assert adb.meta["x"]["level"] is None  # resolve_level reads None as "use the role"


def test_bad_level_rejected(adb):
    resp, _ = actions.execute(
        actions.intent("session_level_set", {"session": "x", "level": "ceo"}, "user:ram"), "owner", "")
    assert "error" in resp and adb.meta == {}


# ── Part 1: above-level asks queue instead of a 403 ─────────────────────────

def test_ic_agent_above_its_level_queues_for_the_owner(adb):
    resp, status = actions.execute(
        actions.intent("project_create", {"name": "Ops", "reason": "new client work"}, "session:RSI"),
        "owner", "ic", acting_session="rsi")
    assert status == 200 and resp["queued"] is True
    assert ("session:RSI", "project_create", "queued:scope") in adb.audit
    assert adb.approvals[0]["detail"]["queued"] == "scope"
    assert adb.approvals[0]["detail"]["session"] == "rsi"


def test_above_level_ask_without_a_reason_bounces(adb):
    resp, status = actions.execute(
        actions.intent("project_create", {"name": "Ops"}, "session:RSI"), "owner", "ic")
    assert status == 400 and "reason" in resp["error"] and adb.approvals == []


def test_above_the_humans_ceiling_is_still_403(adb):
    """A viewer-role human cannot be made to approve what they could not do."""
    assert not orglogic.allowed("project_create", orglogic.effective_level("viewer", ""))
    _, status = actions.execute(
        actions.intent("project_create", {"name": "Ops", "reason": "r"}, "session:RSI"),
        "viewer", "ic")
    assert status == 403 and adb.approvals == []


def test_unknown_action_is_403_not_queued(adb):
    _, status = actions.execute(
        actions.intent("nuke_everything", {"reason": "r"}, "session:RSI"), "owner", "ic")
    assert status == 403 and adb.approvals == []


def test_scope_queue_card_explains_the_level(adb):
    assert inbox.red_risk({"action": "project_create", "queued": "scope"}) == inbox.SCOPE_RISK
    assert inbox.red_risk({"action": "card_delete"}) == orglogic.RED_RISK["card_delete"]
