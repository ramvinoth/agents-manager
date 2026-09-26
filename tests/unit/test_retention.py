"""Unit tests for the two job-history DB helpers that carry real Python logic on
top of their SQL: retention purge (viewer.db.job_runs_purge) and the fire hook
(viewer.db.loops_disable_for_employee).

The SQL itself needs Postgres, but the parts worth a regression test are pure
control flow — which statements run for which caps, how the removed counts sum,
and the blank-id short-circuit — so a tiny cursor fake pins them hermetically
(matching `make unit`'s no-DB contract). We assert on the statements issued and
the returned counts, never on SQL semantics a fake can't honour.
"""
from contextlib import contextmanager

import pytest

from viewer import db


class _FakeCursor:
    """Records executed statements and hands back pre-scripted fetchall() results,
    one per execute() in order — enough to exercise the helpers' branching."""

    def __init__(self, results=None):
        self._results = list(results or [])
        self.executed = []      # normalised SQL text, in call order
        self._last = []

    def execute(self, sql, params=None):
        self.executed.append(" ".join(sql.split()))
        self._last = self._results.pop(0) if self._results else []

    def fetchall(self):
        return self._last

    def fetchone(self):
        return self._last[0] if self._last else None


@pytest.fixture
def cursor(monkeypatch):
    """Swap viewer.db._db for a context manager yielding a scriptable fake cursor."""
    cur = _FakeCursor()

    @contextmanager
    def fake_db():
        yield cur

    monkeypatch.setattr(db, "_db", fake_db)
    return cur


# ── retention: two independent caps, whichever removes a row first ───────────

class TestJobRunsPurge:
    def test_no_caps_touches_nothing(self, cursor):
        """Both caps off (0/None) must issue no DELETE and remove nothing — a
        misconfigured retention row can't accidentally wipe history."""
        assert db.job_runs_purge(0, 0) == 0
        assert cursor.executed == []

    def test_age_cap_only_runs_the_age_delete(self, cursor):
        cursor._results = [[{"id": 1}, {"id": 2}]]   # two aged-out rows
        assert db.job_runs_purge(90, 0) == 2
        assert len(cursor.executed) == 1
        assert "started_at <" in cursor.executed[0]

    def test_count_cap_only_runs_the_per_loop_delete(self, cursor):
        cursor._results = [[{"id": 9}]]              # one over-cap row
        assert db.job_runs_purge(0, 500) == 1
        assert len(cursor.executed) == 1
        # The per-loop cap is a windowed rank, and it only touches attached runs.
        assert "row_number()" in cursor.executed[0]
        assert "loop_id IS NOT NULL" in cursor.executed[0]

    def test_both_caps_sum_their_removals(self, cursor):
        """The return value is the total rows removed across both caps, so a caller
        can log/monitor how much history is being reclaimed each hour."""
        cursor._results = [[{"id": 1}, {"id": 2}], [{"id": 3}]]  # 2 aged + 1 over-cap
        assert db.job_runs_purge(90, 500) == 3
        assert len(cursor.executed) == 2

    def test_negative_caps_are_treated_as_off(self, cursor):
        """A garbage/negative cap must not run a DELETE with a nonsense bound."""
        assert db.job_runs_purge(-5, -1) == 0
        assert cursor.executed == []


# ── the fire hook: disable an employee's loops by their provider link ────────

class TestLoopsDisableForEmployee:
    def test_blank_provider_disables_nothing_and_hits_no_db(self, cursor):
        """An employee with no provider link owns no agent sessions; firing them
        must never disable UNrelated loops, so it short-circuits before any query."""
        assert db.loops_disable_for_employee("") == 0
        assert cursor.executed == []

    def test_matching_provider_disables_and_counts_its_loops(self, cursor):
        cursor._results = [[{"id": "l1"}, {"id": "l2"}]]
        assert db.loops_disable_for_employee("prov-123") == 2
        assert len(cursor.executed) == 1
        sql = cursor.executed[0]
        # Disable (reversible), scoped to sessions linked by that provider id.
        assert "SET enabled = FALSE" in sql
        assert "data->>'provider'" in sql


# ── boot reconciliation: runs orphaned by a server death ─────────────────────

class TestJobRunsAbandonRunning:
    def test_closes_only_running_rows_as_errors(self, cursor):
        """A row stays 'running' until the thread that spawned the run finalizes
        it; after a restart that thread is gone, so the boot pass must close every
        such row — and only such rows — with an error status the history can show."""
        cursor._results = [[{"id": 127}, {"id": 133}]]
        assert db.job_runs_abandon_running() == 2
        (sql,) = cursor.executed
        assert "UPDATE job_runs SET status = 'error', rc = -1" in sql
        assert "WHERE status = 'running'" in sql

    def test_nothing_to_close_returns_zero(self, cursor):
        assert db.job_runs_abandon_running() == 0


# ── stale run credentials: rows the per-job reaper can never see ─────────────

class TestSessionTokensPurgeStale:
    def test_keeps_live_jobs_and_young_rows(self, cursor):
        """A token is dropped only when it is BOTH older than the age floor AND
        not held by a live job; either condition alone keeps a still-legitimate
        credential (a child that outlived a restart) authorized."""
        cursor._results = [[{"session_id": "old-dead"}]]
        assert db.session_tokens_purge_stale(["live-1", "live-2"], 86400) == 1
        (sql,) = cursor.executed
        assert "DELETE FROM session_tokens WHERE created_at <" in sql
        assert "NOT (session_id = ANY(%s))" in sql

    def test_no_live_jobs_is_a_valid_input(self, cursor):
        assert db.session_tokens_purge_stale([], 86400) == 0
        assert "DELETE FROM session_tokens" in cursor.executed[0]
