"""Unit tests are hermetic: no live Postgres, no network.

Every repository opens its connection through `orchestrator.shared.postgres._get_pool()`.
Any test that reaches a real accessor — because a fixture mocked one seam but a handler
called another — is a bug in the test, and it must FAIL, not write into the production database. (Before this guard,
`test_board_deps.py::test_move_within_its_own_board_still_works` reached
`boardwatch.schedule_wake` -> `db.loop_upsert` and left a one-shot wake for the
fake session `sess-1` in the live `loops` table on every run; the scheduler then
fired it and logged a failed job_run each time — 18 phantom rows over one day.)

Tests that genuinely need a database belong in an integration suite against a
disposable database, not here.
"""
import urllib.request
from unittest.mock import Mock

import pytest

from orchestrator import config
from orchestrator.shared import postgres


@pytest.fixture(autouse=True)
def no_database_or_network(monkeypatch):
    monkeypatch.setattr(postgres, "_get_pool", Mock(side_effect=AssertionError("Live DB forbidden in unit tests")))
    monkeypatch.setattr(urllib.request.OpenerDirector, "open",
                        Mock(side_effect=AssertionError("Network forbidden in unit tests")))


@pytest.fixture(autouse=True)
def hermetic_call_recordings(tmp_path, monkeypatch):
    """Every run_bridge call auto-creates a CallRecorder; point its output at a
    throwaway dir so tests never touch the owner's real recordings (the 0700
    directory holding the owner's own voice). Tests that exercise the recorder
    itself re-point it again."""
    monkeypatch.setattr(config, "CALL_RECORDINGS_DIR", tmp_path / "call-recordings")
