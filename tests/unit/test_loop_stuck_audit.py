"""Card 549: the scheduler flags stuck loops, and every loop on/off is audited."""
from orchestrator import db
from orchestrator.loops import audit_toggle, stuck_loops, USER_ORIGIN, AGENT_ORIGIN
from orchestrator.runtime import scheduler

NOW = 1_700_000_000.0
ORIGINS = frozenset({USER_ORIGIN, AGENT_ORIGIN})


def _loop(**kw):
    base = {"enabled": True, "origin": USER_ORIGIN, "nextRun": NOW + 60, "lastRc": 0, "prompt": "p"}
    base.update(kw)
    return base


def test_overdue_loop_is_flagged():
    out = stuck_loops({"a": _loop(nextRun=NOW - 3600)}, NOW, ORIGINS)
    assert [(l, r) for l, r, _ in out] == [("a", "overdue")]


def test_failed_last_run_is_flagged_and_healthy_or_paused_are_not():
    loops = {"f": _loop(lastRc=1, lastRun=5), "ok": _loop(), "off": _loop(enabled=False, nextRun=1),
             "agent": _loop(origin=AGENT_ORIGIN, nextRun=1)}
    out = stuck_loops(loops, NOW, frozenset({USER_ORIGIN}))
    assert [(l, r) for l, r, _ in out] == [("f", "failed")]


def test_check_pushes_once_per_incident(monkeypatch):
    from orchestrator import inbox
    pushed = []
    monkeypatch.setattr(inbox, "_push_owner", lambda *a, **k: pushed.append(a))
    monkeypatch.setattr(db, "loop_list", lambda s=None: {"a": _loop(nextRun=NOW - 3600)})
    monkeypatch.setattr("orchestrator.orchestrator.automation_enabled", lambda: True)
    monkeypatch.setattr("orchestrator.orchestrator.loop_mode", lambda: "both")
    scheduler._stuck_alerted.clear()
    scheduler.check_stuck_loops(NOW)
    scheduler.check_stuck_loops(NOW)
    assert len(pushed) == 1


def test_audit_toggle_writes_only_on_change(monkeypatch):
    rows = []
    monkeypatch.setattr(db, "audit_append", lambda *a, **k: rows.append(a))
    audit_toggle("ram", "x", True, True)
    audit_toggle("ram", "x", True, False)
    audit_toggle("ram", "x", False, True)
    assert [r[1] for r in rows] == ["loop_disable", "loop_enable"]
    assert rows[0][0] == "ram"
