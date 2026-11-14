"""The failure note a dead run leaves behind.

A run has no per-run log and its transcript is trimmed on the next resume, so
the last few stream lines are the only record of what a killed run was doing.
2026-11-12: a 30-minute silence killed a live run and the log held just one
line with nothing to diagnose.
"""
from collections import deque

from orchestrator.runtime.runners.claude import _fail_note


class _Err(Exception):
    pass


def test_fail_note_is_bare_error_when_no_lines():
    assert _fail_note(_Err("No output for 1800s (idle timeout)"), []) == \
        "_Err: No output for 1800s (idle timeout)"


def test_fail_note_appends_the_last_stream_lines():
    note = _fail_note(_Err("boom"), deque(["a", "b", "c"], maxlen=8))
    assert note == "_Err: boom\nlast stream lines:\na\nb\nc"


def test_fail_note_keeps_only_the_tail_lines():
    note = _fail_note(_Err("boom"), deque(["x", "y", "z", "w", "v", "u"], maxlen=8))
    # tail=5 of the last six
    assert note == "_Err: boom\nlast stream lines:\ny\nz\nw\nv\nu"


def test_fail_note_caps_the_note():
    note = _fail_note(_Err("e"), deque(["L" * 300 for _ in range(8)], maxlen=8))
    assert len(note) <= 4000
