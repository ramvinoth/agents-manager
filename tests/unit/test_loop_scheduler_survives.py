"""The scheduler thread must outlive a failed pass (2026-11-04: a Postgres
restart made one pass raise, the thread died, and no loop fired for a day)."""
import time
from types import SimpleNamespace
from unittest import mock

import pytest

from orchestrator.runtime import scheduler


class _Stop(BaseException):
    pass


def test_a_raising_pass_does_not_end_the_scheduler():
    passes = []

    def flaky_pass(launch, now):
        passes.append(now)
        if len(passes) == 1:
            raise RuntimeError("the database system is shutting down")

    sleeps = iter([None, None, _Stop()])

    def fake_sleep(_):
        nxt = next(sleeps)
        if isinstance(nxt, BaseException):
            raise nxt

    # Swap the scheduler module's own `time` name, not time.sleep itself: the
    # latter is process-global, so any other thread that sleeps mid-test would
    # consume a scripted sleep and end the loop one pass early.
    fake_time = SimpleNamespace(sleep=fake_sleep, time=time.time)
    with mock.patch.object(scheduler, "_scheduler_pass", flaky_pass), \
            mock.patch.object(scheduler, "time", fake_time):
        with pytest.raises(_Stop):
            scheduler.loop_scheduler(lambda *a: True)
    assert len(passes) == 2  # the pass after the failure still ran
