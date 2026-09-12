"""Unit tests for the automation master switch.

The switch exists to make ONE claim: "off means nothing runs on its own." That claim
spans two modules — `orchestrator.automation_enabled` reads it, `engine.loop_scheduler`
enforces it — so it is tested here as one property rather than split across two files
where neither would assert the thing the user actually relies on.

`loop_scheduler` is an infinite loop, so it is driven one pass at a time by a fake
`time.sleep` that raises on the second call. That is deliberate: asserting on the real
scheduler body is the only way to catch someone later moving a launch above the gate.
"""
import json

import pytest

from viewer import engine, orchestrator, orglogic


class _StopAfterOnePass(Exception):
    pass


def _one_pass(monkeypatch, launched):
    """Run exactly one iteration of loop_scheduler and return."""
    calls = {"n": 0}

    def fake_sleep(_secs):
        calls["n"] += 1
        if calls["n"] > 1:
            raise _StopAfterOnePass()

    monkeypatch.setattr(engine.time, "sleep", fake_sleep)
    monkeypatch.setattr(engine, "save_json_file", lambda *a, **k: None)
    with pytest.raises(_StopAfterOnePass):
        engine.loop_scheduler(lambda *a, **k: launched.append(a))


@pytest.fixture
def due_loop(monkeypatch):
    """One loop that is overdue, so anything but the gate would fire it."""
    monkeypatch.setattr(engine, "LOOPS", {
        "l1": {"session": "sid", "path": "p.jsonl", "prompt": "go",
               "interval": 60, "nextRun": 0, "enabled": True},
    })
    monkeypatch.setattr(engine, "CHAT_JOBS", {})


@pytest.fixture
def harman_file(monkeypatch, tmp_path):
    """Point the config at a temp file so tests never read or write the real one."""
    p = tmp_path / "harman.json"
    monkeypatch.setattr(orchestrator, "HARMAN_FILE", p)
    return p


# ── the flag itself: every unreadable state must mean OFF ────────────────────

class TestAutomationEnabledFailsSafe:
    def test_missing_file_is_off(self, harman_file):
        assert orchestrator.automation_enabled() is False

    def test_config_predating_the_key_is_off(self, harman_file):
        """An install upgraded from before this switch existed must not start
        running unattended work the moment it restarts."""
        harman_file.write_text(json.dumps({"enabled": True, "projects": [1]}))
        assert orchestrator.automation_enabled() is False

    def test_corrupt_file_is_off(self, harman_file):
        harman_file.write_text("{not json")
        assert orchestrator.automation_enabled() is False

    def test_on_only_when_explicitly_on(self, harman_file):
        harman_file.write_text(json.dumps({"automation_enabled": True}))
        assert orchestrator.automation_enabled() is True

    def test_set_automation_round_trips_the_switch(self, harman_file):
        assert orchestrator.set_automation(True)["automation_enabled"] is True
        assert orchestrator.automation_enabled() is True
        assert orchestrator.set_automation(False)["automation_enabled"] is False
        assert orchestrator.automation_enabled() is False

    def test_set_config_cannot_touch_the_switch(self, harman_file):
        """The bulk config writer must not be a second door onto the master switch:
        if it were, `harman_config` (a plain manager-level, non-Red action) would
        let an agent un-pause itself by tacking one key onto a config write."""
        orchestrator.set_automation(False)
        cfg = orchestrator.set_config({"automation_enabled": True, "budget": 3})
        assert cfg["automation_enabled"] is False   # ignored
        assert cfg["budget"] == 3                   # the rest of the patch still lands


# ── who may flip it: pausing is cheap, resuming is Red ───────────────────────

class TestResumingIsHarderThanPausing:
    """The switch is only a kill switch if the thing it stops cannot restart
    itself. A Harman-role session resolves to `manager` (engine._emp_level) and
    `harman_config` is a plain manager-level green action — so before this split,
    an agent could POST its own resume. These tests pin the asymmetry."""

    def test_any_session_may_pause(self):
        for level in ("ic", "lead", "manager"):
            eff = orglogic.effective_level("owner", level)
            assert orglogic.allowed("automation_pause", eff), level

    def test_pausing_is_not_red(self):
        """Stopping the machine must never sit in a queue waiting for approval."""
        assert orglogic.is_red("automation_pause") is False

    def test_resuming_is_red(self):
        assert orglogic.is_red("automation_resume") is True

    def test_an_agent_cannot_resume_itself_even_at_manager_level(self):
        """Red + a non-empty session_level means no self-approval: a model-chosen
        resume queues for a human instead of executing."""
        assert orglogic.self_approves("owner", "manager") is False

    def test_the_owner_at_the_ui_resumes_without_ceremony(self):
        """No agent session in the loop → nobody left to escalate to, so the
        owner's tap runs rather than opening an approval addressed to themselves."""
        assert orglogic.self_approves("owner", "") is True


# ── the scheduler: the switch covers BOTH unattended paths ───────────────────

class TestSwitchGatesTheScheduler:
    def test_off_launches_no_loop_and_no_harman_tick(self, monkeypatch, due_loop, harman_file):
        """The property the user asked for. Both paths are asserted in one test
        because "everything is paused" is a single claim — a version of this that
        checked only loops would pass while Harman kept spawning sessions."""
        ticked = []
        monkeypatch.setattr(orchestrator, "harman_tick", lambda *a, **k: ticked.append(1))
        launched = []
        _one_pass(monkeypatch, launched)
        assert launched == [] and ticked == []

    def test_off_does_not_consume_the_loop_schedule(self, monkeypatch, due_loop, harman_file):
        """Paused, not skipped: `nextRun`/`runs` are untouched while off, so a loop
        resumes on its own schedule instead of being silently marked as run."""
        _one_pass(monkeypatch, [])
        assert engine.LOOPS["l1"]["nextRun"] == 0
        assert "runs" not in engine.LOOPS["l1"]

    def test_on_launches_the_due_loop(self, monkeypatch, due_loop, harman_file):
        """Sanity: without this the gate could be passing for the wrong reason."""
        harman_file.write_text(json.dumps({"automation_enabled": True}))
        monkeypatch.setattr(orchestrator, "harman_tick", lambda *a, **k: None)
        launched = []
        _one_pass(monkeypatch, launched)
        assert [a[0] for a in launched] == ["sid"]

    def test_unreadable_switch_pauses_rather_than_runs(self, monkeypatch, due_loop, harman_file):
        """If reading the flag raises, the scheduler must treat automation as off.
        Failing open here would mean a disk or permissions fault silently
        un-pauses the machine."""
        def boom():
            raise RuntimeError("cannot read config")

        monkeypatch.setattr(orchestrator, "automation_enabled", boom)
        launched = []
        _one_pass(monkeypatch, launched)
        assert launched == []

    def test_reaping_still_runs_while_paused(self, monkeypatch, harman_file):
        """Pausing must not strand session tokens: a finished job's credential is
        still expired while off, or "paused" would mean "holding live secrets"."""
        monkeypatch.setattr(engine, "LOOPS", {})
        monkeypatch.setattr(engine, "CHAT_JOBS", {
            "old": {"running": False, "finished": 0.0},
        })
        deleted = []
        monkeypatch.setattr("viewer.db.session_token_delete", lambda sid: deleted.append(sid))
        _one_pass(monkeypatch, [])
        assert deleted == ["old"] and engine.CHAT_JOBS == {}
