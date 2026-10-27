"""viewer.maintenance — the hourly maintenance window (Card 133). Storage is
faked; preflight and the process exit are injected, so nothing restarts."""
import datetime

import pytest

from viewer import actions, config, db, inbox, maintenance, orglogic


@pytest.fixture
def store(monkeypatch):
    settings, reqs, audit, told, pushed = {}, [], [], [], []
    monkeypatch.setattr(db, "setting_get", lambda k, d=None: settings.get(k, d))
    monkeypatch.setattr(db, "setting_set", lambda k, v: settings.__setitem__(k, v))

    def add(by, sid, commit, reason):
        r = {"id": len(reqs) + 1, "requested_by": by, "session_id": sid,
             "commit_sha": commit, "reason": reason, "status": "queued", "created_at": 0}
        reqs.append(r)
        return dict(r)
    monkeypatch.setattr(db, "restart_request_add", add)
    monkeypatch.setattr(db, "restart_requests_by_status",
                        lambda s: [dict(r) for r in reqs if r["status"] == s])

    def set_status(ids, s):
        for r in reqs:
            if r["id"] in ids:
                r["status"] = s
    monkeypatch.setattr(db, "restart_requests_set_status", set_status)
    monkeypatch.setattr(db, "audit_append", lambda *a: audit.append(a))
    monkeypatch.setattr(inbox, "deliver_message", lambda *a, **k: told.append(a))
    monkeypatch.setattr(inbox, "_push_owner", lambda *a: pushed.append(a))
    monkeypatch.setattr(maintenance, "supervised", lambda: True)
    monkeypatch.setattr(maintenance, "busy", lambda: 0)
    monkeypatch.setattr(maintenance, "_git_head", lambda: "abc")
    return {"settings": settings, "reqs": reqs, "audit": audit, "told": told, "pushed": pushed}


def _ts(h, m):
    return datetime.datetime(2026, 10, 6, h, m).timestamp()


def test_window_is_the_last_ten_minutes_of_each_hour():
    assert maintenance.window_key(_ts(14, 49)) is None
    assert maintenance.window_key(_ts(14, 50)) == "2026-10-06 14"
    assert maintenance.window_key(_ts(14, 59)) == "2026-10-06 14"
    assert maintenance.next_window(_ts(14, 10)) == _ts(14, 50)
    assert maintenance.next_window(_ts(14, 50)) == _ts(15, 50)


def test_tick_with_nothing_queued_does_nothing_once_per_hour(store, monkeypatch):
    started = []
    monkeypatch.setattr(maintenance.threading, "Thread",
                        lambda **k: type("T", (), {"start": lambda s: started.append(k)})())
    assert maintenance.tick(_ts(14, 30)) is False          # outside the window
    assert maintenance.tick(_ts(14, 50)) is False          # window, empty queue
    maintenance.request("agent", "s1", "", "deploy")
    assert maintenance.tick(_ts(14, 55)) is False          # this hour already handled
    assert maintenance.tick(_ts(15, 50)) is True
    assert started[0]["kwargs"]["trigger"] == "window 2026-10-06 15:50"
    assert maintenance.tick(_ts(15, 51)) is False          # one window per hour


def test_restart_applies_every_queued_request_once(store):
    maintenance.request("a", "s1", "c1", "fix")
    maintenance.request("b", "s2", "c2", "feature")
    left = []
    out = maintenance.run_window("t", check=lambda: (True, "ok"), leave=lambda: left.append(1))
    assert out == "restarting" and left == [1]
    assert {r["status"] for r in store["reqs"]} == {"restarting"}
    rec = store["settings"]["maintenance_pending"]
    assert [r["by"] for r in rec["requests"]] == ["a", "b"] and rec["preflight"] == "ok"
    assert store["audit"] == []    # the NEW process writes the single entry


def test_empty_queue_is_idle(store):
    assert maintenance.run_window("t", check=lambda: pytest.fail("no preflight"),
                                  leave=lambda: pytest.fail("no exit")) == "idle"


def test_waits_for_quiet_up_to_the_cap(store, monkeypatch):
    maintenance.request("a", "s1", "", "x")
    monkeypatch.setattr(maintenance, "busy", lambda: 2)
    slept = []
    maintenance.run_window("t", quiet_cap=45, check=lambda: (True, "ok"),
                           leave=lambda: None, sleep=slept.append)
    assert sum(slept) == 45
    rec = store["settings"]["maintenance_pending"]
    assert rec["waited_s"] == 45 and rec["turns_cut"] == 2


def test_failed_preflight_keeps_the_old_server_and_tells_requesters(store):
    maintenance.request("a", "s1", "", "x")
    out = maintenance.run_window("t", check=lambda: (False, "SyntaxError"),
                                 leave=lambda: pytest.fail("must not exit"))
    assert out == "preflight_failed"
    assert store["reqs"][0]["status"] == "failed"
    assert store["audit"][0][1] == "maintenance_restart"
    assert store["audit"][0][3] == "preflight_failed"
    assert store["told"][0][3] == "s1" and "SyntaxError" in store["told"][0][4]


def test_unsupervised_server_refuses_to_exit(store, monkeypatch):
    monkeypatch.setattr(maintenance, "supervised", lambda: False)
    maintenance.request("a", "s1", "", "x")
    assert maintenance.run_window("t", check=lambda: pytest.fail("no preflight"),
                                  leave=lambda: pytest.fail("must not exit")) == "unsupervised"
    assert store["audit"][0][3] == "unsupervised"


def test_new_process_writes_the_single_audit_entry(store):
    maintenance.request("a", "s1", "", "x")
    maintenance.request("owner", "", "", "restart now")
    maintenance.run_window("t", check=lambda: (True, "ok"), leave=lambda: None)
    rec = maintenance.finish_after_boot(sleep=lambda s: None, health=lambda: {"ok": True})
    assert rec["version_after"] == config.VERSION and rec["health"] == {"ok": True}
    assert {r["status"] for r in store["reqs"]} == {"done"}
    assert len(store["audit"]) == 1 and store["audit"][0][3] == "restarted"
    assert store["settings"]["maintenance_pending"] is None
    assert [t[3] for t in store["told"]] == ["s1"] and len(store["pushed"]) == 1
    assert maintenance.finish_after_boot(sleep=lambda s: None) is None   # once only


def test_restart_outside_the_window_closes_requests_it_already_applied(store):
    maintenance.request("a", "s1", "abc", "x")    # filed before this process booted (created_at 0)
    rec = maintenance.finish_after_boot(sleep=lambda s: None, health=lambda: {"ok": True})
    assert rec["trigger"] == "restart outside the window"
    assert {r["status"] for r in store["reqs"]} == {"done"}
    assert len(store["audit"]) == 1 and [t[3] for t in store["told"]] == ["s1"]


def test_request_filed_after_boot_waits_for_its_window(store):
    maintenance.request("a", "s1", "", "x")
    store["reqs"][0]["created_at"] = maintenance.BOOT_TIME + 1
    assert maintenance.finish_after_boot(sleep=lambda s: None) is None
    assert store["reqs"][0]["status"] == "queued" and not store["audit"]


def test_unhealthy_boot_is_recorded_as_such(store):
    maintenance.request("a", "s1", "", "x")
    maintenance.run_window("t", check=lambda: (True, "ok"), leave=lambda: None)
    maintenance.finish_after_boot(sleep=lambda s: None, health=lambda: {"ok": False})
    assert store["audit"][0][3] == "unhealthy"


def test_restart_now_is_red_and_request_is_not():
    assert "restart_now" in orglogic._RED_ACTIONS
    assert "restart_request" not in orglogic._RED_ACTIONS
    assert "restart_request" in actions.ACTIONS and "restart_now" in actions.ACTIONS


def test_request_needs_a_reason(store):
    assert "error" in actions._restart_request({"reason": "  "})
    assert store["reqs"] == []
