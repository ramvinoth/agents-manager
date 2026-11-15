"""A newer skill_promote ask for the same skill closes the older open one
(card 548): two whole-file asks for one skill undo each other in approval
order, and the owner had no signal that they conflict."""
import pytest

from orchestrator import actions, inbox, orglogic, skills


class FakeDb:
    def __init__(self):
        self.rows, self.audit = [], []

    def audit_append(self, actor, action, target, outcome):
        self.audit.append((actor, action, outcome))

    def approval_open(self, kind, summary, detail, created_by):
        self.rows.append({"id": len(self.rows) + 1, "detail": detail, "summary": summary,
                          "created_by": created_by, "status": "open"})
        return self.rows[-1]

    def approval_list_open(self):
        return [r for r in self.rows if r["status"] == "open"]

    def approval_resolve(self, aid, resolution):
        for r in self.rows:
            if r["id"] == aid and r["status"] == "open":
                r.update(status="resolved", resolution=resolution)
                return r
        return None


@pytest.fixture
def adb(monkeypatch):
    f = FakeDb()
    told = []
    monkeypatch.setattr(actions, "db", f)
    monkeypatch.setattr(inbox, "deliver_red", lambda ap: None)
    monkeypatch.setattr(inbox, "tell_superseded", lambda row, by: told.append((row["id"], by)))
    f.told = told
    return f


def promote(name, sid, content="x"):
    return actions.execute(
        actions.intent("skill_promote", {"name": name, "content": content, "reason": "r"},
                       f"session:{sid}"), "owner", "ic", acting_session=sid)


def test_newer_ask_for_same_skill_closes_the_older(adb):
    promote("wake", "a")
    resp, status = promote("wake", "b")
    assert status == 200 and resp["approval"] == 2
    assert adb.rows[0]["status"] == "resolved"
    assert adb.rows[0]["resolution"] == "superseded by approval 2"
    assert adb.rows[1]["status"] == "open" and adb.rows[1]["detail"]["supersedes"] == [1]
    assert adb.told == [(1, 2)]
    assert ("session:b", "approval_supersede", "done") in adb.audit


def test_other_skills_and_actions_are_left_open(adb):
    promote("wake", "a")
    promote("other", "a")
    actions.execute(actions.intent("loop_delete", {"id": "l1", "reason": "r"}, "session:a"),
                    "owner", "ic", acting_session="a")
    actions.execute(actions.intent("loop_delete", {"id": "l1", "reason": "r"}, "session:a"),
                    "owner", "ic", acting_session="a")
    assert [r["status"] for r in adb.rows] == ["open"] * 4
    assert adb.told == []


def test_an_older_ask_already_decided_is_not_closed_again(adb):
    promote("wake", "a")
    adb.rows[0]["status"] = "resolved"  # owner approved it a moment ago
    promote("wake", "b")
    assert "supersedes" not in adb.rows[1]["detail"] and adb.told == []


def test_supersede_key_is_pure_and_needs_a_target():
    assert orglogic.supersede_key({"action": "skill_promote", "args": {"name": " w "}}) == ("skill_promote", "w")
    assert orglogic.supersede_key({"action": "skill_promote", "args": {}}) is None
    assert orglogic.supersede_key({"action": "card_delete", "args": {"card_id": 1}}) is None
    assert orglogic.supersede_key(None) is None


def test_replace_summary_shows_dropped_lines():
    assert skills.replace_summary(None, "a") == "new file"
    s = skills.replace_summary("a\nb\nc\n", "a\nz\n")
    assert s == "replaces the whole file: 3 lines now, 2 proposed, drops 2 current lines"
    assert "drops" not in skills.replace_summary("a\n", "a\nb\n")


def test_red_subject_names_size_and_replaced_ask(monkeypatch):
    monkeypatch.setattr(skills, "current_text", lambda name: "a\nb\n")
    s = inbox.red_subject({"action": "skill_promote", "supersedes": [40],
                           "args": {"name": "wake", "content": "a\n"}})
    assert s == ("wake; replaces the whole file: 2 lines now, 1 proposed, drops 1 current lines; "
                 "replaces open approval 40, now closed")
