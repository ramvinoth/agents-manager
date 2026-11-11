"""The scheduler thread must outlive a failed pass (2026-11-04: a Postgres
restart made one pass raise, the thread died, and no loop fired for a day)."""
from unittest import mock

import pytest

from orchestrator import engine


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

    with mock.patch.object(engine, "_scheduler_pass", flaky_pass), \
            mock.patch.object(engine.time, "sleep", fake_sleep):
        with pytest.raises(_Stop):
            engine.loop_scheduler(lambda *a: True)
    assert len(passes) == 2  # the pass after the failure still ran
