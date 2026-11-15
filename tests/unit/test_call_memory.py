import time
from unittest import mock

from orchestrator import callbrain, calllive


def test_day_bounds_words_and_dates():
    now = time.mktime((2026, 11, 14, 15, 0, 0, 0, 0, -1))
    s, e = callbrain._day_bounds("today", now)
    assert s <= now < e and abs((e - s) - 86400) < 4000
    ys, ye = callbrain._day_bounds("yesterday", now)
    assert ye == s
    assert callbrain._day_bounds("2026-11-14", now)[0] == s
    assert callbrain._day_bounds("someday", now) is None


def test_call_log_formats_and_handles_empty():
    rows = [{"who": "caller", "text": "hi", "at": 1.0}, {"who": "agent", "text": "hello", "at": 2.0}]
    with mock.patch.object(callbrain.db, "call_turns_between", return_value=rows):
        out = callbrain._call_log("today")
    assert "caller: hi" in out and "agent: hello" in out
    with mock.patch.object(callbrain.db, "call_turns_between", return_value=[]):
        assert "No call lines" in callbrain._call_log("yesterday")
    assert "date" in callbrain._call_log("nope")


def test_recent_history_starts_on_a_caller_turn():
    rows = [{"who": "agent", "text": "a", "at": 1}, {"who": "caller", "text": "b", "at": 2},
            {"who": "agent", "text": "c", "at": 3}]
    with mock.patch.object(callbrain.db, "call_turns_between", return_value=rows):
        h = callbrain.recent_call_history(now=10)
    assert [m["content"] for m in h] == ["b", "c"] and h[0]["role"] == "user"


def _bridge():
    b = calllive.Bridge.__new__(calllive.Bridge)
    import threading
    b.lock = threading.Lock()
    b.updates, b.thinking, b.last_asr = [], 0, 0.0
    b.voice = mock.Mock()
    b.voice._busy.return_value = False
    return b


def test_updates_queue_and_cap():
    b = _bridge()
    for i in range(calllive.UPDATE_LIMIT + 3):
        b.enqueue(f"u{i}")
    assert len(b.updates) == calllive.UPDATE_LIMIT and b.updates[-1] == f"u{calllive.UPDATE_LIMIT + 2}"


def test_quiet_waits_for_caller_agent_and_brain():
    b = _bridge()
    assert b._quiet()
    b.last_asr = time.monotonic()
    assert not b._quiet()
    b.last_asr = 0.0
    b.thinking = 1
    assert not b._quiet()
    b.thinking = 0
    b.voice._busy.return_value = True
    assert not b._quiet()
