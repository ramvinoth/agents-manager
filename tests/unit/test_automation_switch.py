"""Unit tests for the automation master switch AND the loop-control mode.

The scheduler has TWO unattended paths and TWO facts gated inside it, both enforced in
`engine.loop_scheduler` at one point:

- the **master switch** (`orchestrator.automation_enabled`) is the runtime halt on
  everything autonomous: off, Harman's manager tick does not run and no agent-origin
  (harman) loop fires.
- the **loop-control mode** (`orchestrator.loop_mode` → `loops.allowed_origins`)
  licenses which loop ORIGINS may fire. The two INTERSECT at fire time: a loop fires
  only if its origin is licensed by the mode AND (for the agent origin) the switch is
  on. The owner's own (user) loops follow the mode alone — a human's asking is not
  paused by the machine being unattended. This is the property the user asked for
  ("tied to the automation enable system"), so it is pinned here beside the switch.

Both gates live in one thread, so they are tested together against one driver rather
than split across two files where neither would assert the thing the user relies on.

Storage is the `settings`/`loops` Postgres tables, so the seams are the db accessors,
not files: a single in-memory FakeDB stands in for Postgres (mirroring
tests/unit/test_actions.py's `monkeypatch.setattr(actions, "db", f)`), which keeps the
suite hermetic while asserting the exact accessor calls the real code makes.

`loop_scheduler` is an infinite loop, so it is driven one pass at a time by a fake
`time.sleep` that raises on the second call. That is deliberate: asserting on the real
scheduler body is the only way to catch someone later moving a launch above a gate.
"""
import pytest

from viewer import board_wake, engine, orchestrator, orglogic


class _StopAfterOnePass(Exception):
    pass


class FakeDB:
    """In-memory stand-in for viewer.db — only the accessors the scheduler and the
    orchestrator config actually call. `settings` backs the harman config; `loops`
    backs the schedule. Every write is recorded so a test can assert that a paused
    pass consumed nothing."""

    def cards_needing_attention(self):
        return []

    def __init__(self):
        self.settings = {}          # key -> value (harman config lives here)
        self.loops = []             # schedule rows (dicts, each with an id)
        self.loop_updates = []      # (lid, fields) — proof of nextRun/runs bumps
        self.tokens_deleted = []    # sessions whose token was reaped
        self._run_seq = 0

    # settings (the master switch's storage) ------------------------------
    def setting_get(self, key, default=None):
        return self.settings.get(key, default)

    def setting_set(self, key, value):
        self.settings[key] = value

    # loops (the schedule) ------------------------------------------------
    def loops_due(self, now, origins=None):
        """Mirrors db.loops_due: enabled + overdue, and (when `origins` is given)
        only loops whose origin is licensed. A row with no origin defaults to
        'user', exactly like the column default."""
        due = [dict(lp) for lp in self.loops
               if lp.get("enabled", True) and lp.get("nextRun", 0) <= now]
        if origins is not None:
            due = [lp for lp in due if lp.get("origin", "user") in origins]
        return due

    def loop_update(self, lid, fields):
        self.loop_updates.append((lid, dict(fields)))
        for lp in self.loops:
            if lp["id"] == lid:
                lp.update(fields)
                return dict(lp)
        return None

    # job-run history + retention (housekeeping, runs even while paused) ---
    def job_run_start(self, loop_id, session_id, prompt):
        self._run_seq += 1
        return self._run_seq

    def job_run_finish(self, run_id, rc, detail=""):
        pass

    def retention_config(self):
        return {"job_runs_days": 90, "job_runs_per_loop": 500}

    def job_runs_purge(self, max_age_days, max_per_loop):
        return 0

    # reaping ------------------------------------------------------------
    def session_token_delete(self, sid):
        self.tokens_deleted.append(sid)


@pytest.fixture
def fdb(monkeypatch):
    """One fake Postgres shared by both modules the switch spans."""
    f = FakeDB()
    monkeypatch.setattr(orchestrator, "db", f)
    monkeypatch.setattr(engine, "db", f)
    # The scheduler pass also runs board_wake.sweep() under 'harman'/'both'. Until
    # 2026-09-20 that module kept the REAL db here, so every run of this file
    # stamped the production sweep clock and queued real card wakes (11 sweeps'
    # worth of audit rows for cards 12/14/19 came from pytest, not the server).
    monkeypatch.setattr(board_wake, "db", f)
    return f


def _one_pass(monkeypatch, launched):
    """Run exactly one iteration of loop_scheduler and return."""
    calls = {"n": 0}

    def fake_sleep(_secs):
        calls["n"] += 1
        if calls["n"] > 1:
            raise _StopAfterOnePass()

    monkeypatch.setattr(engine.time, "sleep", fake_sleep)
    # Force the hourly retention purge to run this pass (a stale module global from
    # an earlier test would otherwise skip it); the fake's purge is a no-op.
    monkeypatch.setattr(engine, "_last_purge", 0.0)
    with pytest.raises(_StopAfterOnePass):
        engine.loop_scheduler(lambda *a, **k: launched.append(a))


@pytest.fixture
def due_loop(monkeypatch, fdb):
    """One user-origin loop that is overdue, so anything but a gate would fire it.
    Origin is explicit because loop firing is now gated by origin, not the master
    switch; a test that wants an agent loop overrides `loops[0]["origin"]`."""
    fdb.loops = [{"id": "l1", "session": "sid", "path": "p.jsonl", "prompt": "go",
                  "interval": 60, "nextRun": 0, "enabled": True, "origin": "user"}]
    monkeypatch.setattr(engine, "CHAT_JOBS", {})
    return fdb


# ── the flag itself: every unreadable state must mean OFF ────────────────────

class TestAutomationEnabledFailsSafe:
    def test_missing_row_is_off(self, fdb):
        assert orchestrator.automation_enabled() is False

    def test_config_predating_the_key_is_off(self, fdb):
        """An install upgraded from before this switch existed must not start
        running unattended work the moment it restarts."""
        fdb.settings["harman"] = {"enabled": True, "projects": [1]}
        assert orchestrator.automation_enabled() is False

    def test_corrupt_row_is_off(self, fdb):
        """A malformed row (not the expected dict shape) leaves the fail-safe
        defaults intact instead of crashing or flipping the switch on."""
        fdb.settings["harman"] = "{not json"
        assert orchestrator.automation_enabled() is False

    def test_on_only_when_explicitly_on(self, fdb):
        fdb.settings["harman"] = {"automation_enabled": True}
        assert orchestrator.automation_enabled() is True

    def test_set_automation_round_trips_the_switch(self, fdb):
        assert orchestrator.set_automation(True)["automation_enabled"] is True
        assert orchestrator.automation_enabled() is True
        assert orchestrator.set_automation(False)["automation_enabled"] is False
        assert orchestrator.automation_enabled() is False

    def test_set_config_cannot_touch_the_switch(self, fdb):
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


# ── the scheduler, gate 1: the master switch covers ONLY Harman's tick ───────

class TestMasterSwitchGatesHarmanTick:
    """The master switch is the halt on everything autonomous: Harman's manager
    tick and (below) the agent side of loop firing. These tests pin that off
    neither runs the tick nor strands the owner's own loops — a human's asking
    keeps running while the machine's autonomy is paused."""

    def test_off_suppresses_harman_tick_but_not_the_owners_loop(self, monkeypatch, due_loop):
        """The property the user asked for: pausing Harman's autonomy must NOT stop
        the owner's own scheduled loops. A version that gated loops on this switch
        would fail here — the user loop fires while the tick stays silent."""
        ticked = []
        monkeypatch.setattr(orchestrator, "harman_tick", lambda *a, **k: ticked.append(1))
        launched = []
        _one_pass(monkeypatch, launched)
        assert ticked == []                       # Harman paused
        assert [a[0] for a in launched] == ["sid"]  # owner's loop still ran

    def test_on_runs_the_harman_tick(self, monkeypatch, due_loop):
        """Sanity: with the switch on the tick fires, so the gate above is passing
        for the right reason rather than because the tick never runs."""
        due_loop.settings["harman"] = {"automation_enabled": True}
        ticked = []
        monkeypatch.setattr(orchestrator, "harman_tick", lambda *a, **k: ticked.append(1))
        _one_pass(monkeypatch, [])
        assert ticked == [1]

    def test_unreadable_switch_suppresses_the_tick(self, monkeypatch, due_loop):
        """If reading the flag raises, the tick must be treated as off. Failing open
        here would let a disk/permissions fault silently un-pause Harman."""
        def boom():
            raise RuntimeError("cannot read config")

        monkeypatch.setattr(orchestrator, "automation_enabled", boom)
        ticked = []
        monkeypatch.setattr(orchestrator, "harman_tick", lambda *a, **k: ticked.append(1))
        _one_pass(monkeypatch, [])
        assert ticked == []


# ── the scheduler, gate 2: loop-control mode covers WHICH origins fire ────────

class TestLoopModeGatesLoopFiring:
    """Each mode licenses a set of origins; a due loop fires only if its origin is
    licensed — and the agent origin additionally needs the master switch on.
    `harman_tick` is stubbed out so these tests isolate the loop path."""

    def _no_tick(self, monkeypatch):
        monkeypatch.setattr(orchestrator, "harman_tick", lambda *a, **k: None)

    def test_default_user_mode_fires_a_user_loop(self, monkeypatch, due_loop):
        """No loop_control row → 'user' default → the owner's own loop fires."""
        self._no_tick(monkeypatch)
        launched = []
        _one_pass(monkeypatch, launched)
        assert [a[0] for a in launched] == ["sid"]
        assert due_loop.loops[0]["runs"] == 1     # consumed the schedule exactly once

    def test_none_mode_fires_nothing(self, monkeypatch, due_loop):
        """'none' licenses no origin: an overdue loop must not fire, and — paused,
        not skipped — its row is left untouched so it resumes on its own schedule."""
        due_loop.settings["loop_control"] = {"mode": "none"}
        self._no_tick(monkeypatch)
        launched = []
        _one_pass(monkeypatch, launched)
        assert launched == []
        assert due_loop.loop_updates == []
        assert due_loop.loops[0]["nextRun"] == 0

    def test_user_mode_suppresses_an_agent_loop(self, monkeypatch, due_loop):
        """A harman-origin loop must NOT fire under the 'user' default, or licensing
        the owner's loops would silently license agent-made ones too."""
        due_loop.loops[0]["origin"] = "harman"
        self._no_tick(monkeypatch)
        launched = []
        _one_pass(monkeypatch, launched)
        assert launched == []
        assert due_loop.loop_updates == []

    def test_harman_mode_fires_an_agent_loop_only(self, monkeypatch, due_loop):
        """'harman' licenses agent loops and NOT the human's — the mirror of the
        default, so the two origins can be controlled separately. The switch is ON:
        it licenses nothing, it only halts, so agent firing needs mode + switch."""
        due_loop.settings["harman"] = {"automation_enabled": True}
        due_loop.settings["loop_control"] = {"mode": "harman"}
        due_loop.loops = [
            {"id": "u", "session": "us", "path": "p", "prompt": "go", "interval": 60,
             "nextRun": 0, "enabled": True, "origin": "user"},
            {"id": "h", "session": "hs", "path": "p", "prompt": "go", "interval": 60,
             "nextRun": 0, "enabled": True, "origin": "harman"},
        ]
        self._no_tick(monkeypatch)
        launched = []
        _one_pass(monkeypatch, launched)
        assert [a[0] for a in launched] == ["hs"]   # only the agent loop

    def test_both_mode_fires_every_origin(self, monkeypatch, due_loop):
        due_loop.settings["harman"] = {"automation_enabled": True}
        due_loop.settings["loop_control"] = {"mode": "both"}
        due_loop.loops = [
            {"id": "u", "session": "us", "path": "p", "prompt": "go", "interval": 60,
             "nextRun": 0, "enabled": True, "origin": "user"},
            {"id": "h", "session": "hs", "path": "p", "prompt": "go", "interval": 60,
             "nextRun": 0, "enabled": True, "origin": "harman"},
        ]
        self._no_tick(monkeypatch)
        launched = []
        _one_pass(monkeypatch, launched)
        assert sorted(a[0] for a in launched) == ["hs", "us"]

    def test_the_master_switch_does_not_license_loops(self, monkeypatch, due_loop):
        """The switch HALTS, it does not LICENSE: turning automation ON must not
        fire a loop that the mode ('none') forbids. If the switch could license,
        this agent could resume its own scheduled work by flipping automation."""
        due_loop.settings["harman"] = {"automation_enabled": True}
        due_loop.settings["loop_control"] = {"mode": "none"}
        self._no_tick(monkeypatch)
        launched = []
        _one_pass(monkeypatch, launched)
        assert launched == []

    def test_switch_off_halts_only_the_agent_side(self, monkeypatch, due_loop):
        """The property the user asked for, in one assertion: with the switch OFF
        and mode 'both', the owner's own loop still fires while the agent's is
        PAUSED — its row keeps its schedule untouched (paused, not skipped), so a
        resume fires it once on its own cadence instead of replaying the pause."""
        due_loop.loops = [
            {"id": "u", "session": "us", "path": "p", "prompt": "go", "interval": 60,
             "nextRun": 0, "enabled": True, "origin": "user"},
            {"id": "h", "session": "hs", "path": "p", "prompt": "go", "interval": 60,
             "nextRun": 0, "enabled": True, "origin": "harman"},
        ]
        due_loop.settings["loop_control"] = {"mode": "both"}
        self._no_tick(monkeypatch)
        launched = []
        _one_pass(monkeypatch, launched)
        assert [a[0] for a in launched] == ["us"]
        # The paused agent row must be untouched: no nextRun bump, no run
        # recorded — only the fired user loop may appear in the update log.
        by_id = {lp["id"]: lp for lp in due_loop.loops}
        assert by_id["h"]["nextRun"] == 0
        assert all(lid != "h" for lid, _ in due_loop.loop_updates)

    def test_harman_mode_with_switch_off_fires_nothing(self, monkeypatch, due_loop):
        """Mode 'harman' licenses ONLY the agent origin, and the switch halts it:
        nothing may fire, and the row stays paused (schedule untouched)."""
        due_loop.loops = [
            {"id": "h", "session": "hs", "path": "p", "prompt": "go", "interval": 60,
             "nextRun": 0, "enabled": True, "origin": "harman"},
        ]
        due_loop.settings["loop_control"] = {"mode": "harman"}
        self._no_tick(monkeypatch)
        launched = []
        _one_pass(monkeypatch, launched)
        assert launched == []
        assert due_loop.loop_updates == []
        assert due_loop.loops[0]["nextRun"] == 0

    def test_unreadable_switch_halts_the_agent_side(self, monkeypatch, due_loop):
        """If reading the switch raises, it is treated as OFF — the fail-safe
        direction. The owner's loop still fires; the agent's does not. Failing
        open here would let a DB fault silently un-pause the machine's autonomy."""
        def boom():
            raise RuntimeError("cannot read config")

        monkeypatch.setattr(orchestrator, "automation_enabled", boom)
        due_loop.loops = [
            {"id": "u", "session": "us", "path": "p", "prompt": "go", "interval": 60,
             "nextRun": 0, "enabled": True, "origin": "user"},
            {"id": "h", "session": "hs", "path": "p", "prompt": "go", "interval": 60,
             "nextRun": 0, "enabled": True, "origin": "harman"},
        ]
        due_loop.settings["loop_control"] = {"mode": "both"}
        self._no_tick(monkeypatch)
        launched = []
        _one_pass(monkeypatch, launched)
        assert [a[0] for a in launched] == ["us"]


# ── housekeeping runs regardless of either gate ──────────────────────────────

class TestReapingIsUngated:
    def test_reaping_still_runs_while_paused(self, monkeypatch, fdb):
        """Pausing must not strand session tokens: a finished job's credential is
        still expired while off, or "paused" would mean "holding live secrets"."""
        monkeypatch.setattr(engine, "CHAT_JOBS", {
            "old": {"running": False, "finished": 0.0},
        })
        _one_pass(monkeypatch, [])
        assert fdb.tokens_deleted == ["old"] and engine.CHAT_JOBS == {}
