"""viewer.events: the pub-sub, the snapshot diff, the list throttle and the
watcher's lifecycle — all without a server or a database."""
import json
import threading
import time

from viewer import events


# ---- Hub / Subscription ---------------------------------------------------------

def test_publish_fans_out_to_every_subscriber():
    hub = events.Hub()
    a, b = hub.subscribe(), hub.subscribe()
    hub.publish({"type": "list-changed"})
    assert a.get(timeout=0.1) == {"type": "list-changed"}
    assert b.get(timeout=0.1) == {"type": "list-changed"}
    assert hub.count() == 2


def test_unsubscribed_gets_nothing_and_count_drops():
    hub = events.Hub()
    a = hub.subscribe()
    hub.unsubscribe(a)
    hub.publish({"type": "list-changed"})
    assert hub.count() == 0
    assert a.get(timeout=0.05) is None


def test_get_times_out_with_none():
    sub = events.Hub().subscribe()
    t0 = time.monotonic()
    assert sub.get(timeout=0.05) is None
    assert time.monotonic() - t0 >= 0.04


def test_overflow_drops_backlog_and_yields_one_resync():
    hub = events.Hub()
    sub = hub.subscribe(maxsize=3)
    for i in range(10):
        hub.publish({"type": "transcript-changed", "session": "s", "size": i})
    assert sub.get(timeout=0.1) == {"type": "resync"}
    assert sub.get(timeout=0.05) is None          # the stale backlog is gone
    hub.publish({"type": "list-changed"})          # and the stream carries on
    assert sub.get(timeout=0.1) == {"type": "list-changed"}


def test_close_wakes_a_blocked_get():
    sub = events.Hub().subscribe()
    got = []
    t = threading.Thread(target=lambda: got.append(sub.get(timeout=5)))
    t.start()
    time.sleep(0.05)
    sub.close()
    t.join(1)
    assert not t.is_alive() and got == [None]


def test_first_subscriber_hook_runs_on_every_subscribe():
    calls = []
    hub = events.Hub(on_first=lambda: calls.append(1))
    hub.subscribe()
    hub.subscribe()
    assert len(calls) == 2    # Watcher.ensure is idempotent; the hub need not count


# ---- diff ---------------------------------------------------------------------------

def _st(running=False, status=(0, (), 0, 0, False), size=None):
    return {"running": running, "status": status, "size": size}


def test_turn_start_and_end_are_urgent():
    ev, urgent, dirty = events.diff({"a": _st(False)}, {"a": _st(True)})
    assert ev == [{"type": "turn-start", "session": "a"}] and urgent and not dirty
    ev, urgent, _ = events.diff({"a": _st(True)}, {"a": _st(False)})
    assert ev == [{"type": "turn-end", "session": "a"}] and urgent


def test_new_running_job_starts_and_vanished_one_ends():
    ev, urgent, _ = events.diff({}, {"a": _st(True, size=10)})
    assert ev == [{"type": "turn-start", "session": "a"}] and urgent   # no size event on first sight
    ev, urgent, _ = events.diff({"a": _st(True)}, {})
    assert ev == [{"type": "turn-end", "session": "a"}] and urgent


def test_new_idle_job_is_silent():
    assert events.diff({}, {"a": _st(False)}) == ([], False, False)


def test_status_change_without_turn_boundary():
    prev = {"a": _st(True, status=(0, (), 1, 0, False))}
    cur = {"a": _st(True, status=(1, ("q1",), 1, 0, False))}
    ev, urgent, dirty = events.diff(prev, cur)
    assert ev == [{"type": "status-changed", "session": "a"}] and not urgent and not dirty


def test_transcript_growth_is_dirty_not_urgent():
    ev, urgent, dirty = events.diff({"a": _st(True, size=10)}, {"a": _st(True, size=42)})
    assert ev == [{"type": "transcript-changed", "session": "a", "size": 42}]
    assert dirty and not urgent


def test_transcript_appearing_after_cli_start_counts_as_change():
    ev, _, dirty = events.diff({"a": _st(True, size=None)}, {"a": _st(True, size=5)})
    assert ev == [{"type": "transcript-changed", "session": "a", "size": 5}] and dirty


def test_unchanged_snapshot_is_silent():
    s = {"a": _st(True, size=7), "b": _st(False, size=3)}
    assert events.diff(s, dict(s)) == ([], False, False)


def test_turn_end_and_final_write_both_reported():
    ev, _, _ = events.diff({"a": _st(True, size=1)}, {"a": _st(False, size=9)})
    assert [e["type"] for e in ev] == ["turn-end", "transcript-changed"]


def test_job_state_signature_tracks_what_status_poll_shows():
    base = {"running": True, "queue": [], "pending_approvals": [], "turns": 1}
    a = events.job_state(base)
    assert a["running"] is True
    assert events.job_state(dict(base, queue=["x"]))["status"] != a["status"]
    assert events.job_state(dict(base, pending_approvals=[{"id": "p1"}]))["status"] != a["status"]
    assert events.job_state(dict(base, turns=2))["status"] != a["status"]
    assert events.job_state(dict(base, stdout="noise"))["status"] == a["status"]


# ---- list throttle --------------------------------------------------------------------

def test_list_due_urgent_always_dirty_throttled():
    assert events.list_due(True, False, now=100.0, last_emit=99.9)
    assert not events.list_due(False, True, now=100.0, last_emit=99.0, gap=3)
    assert events.list_due(False, True, now=103.0, last_emit=100.0, gap=3)
    assert not events.list_due(False, False, now=1e9, last_emit=0)


# ---- last_uuid -------------------------------------------------------------------------

def test_last_uuid_skips_cut_first_line_and_blank_tail():
    tail = (b'ial":"cut line"}\n'
            + json.dumps({"uuid": "u1"}).encode() + b"\n"
            + json.dumps({"uuid": "u2", "type": "assistant"}).encode() + b"\n\n")
    assert events.last_uuid(tail) == "u2"


def test_last_uuid_ignores_lines_without_uuid_and_partial_last_line():
    tail = json.dumps({"uuid": "u1"}).encode() + b"\n" + json.dumps({"type": "summary"}).encode() + b"\n{\"uuid\": \"u3"
    assert events.last_uuid(tail) == "u1"
    assert events.last_uuid(b"") == ""


# ---- Watcher lifecycle ----------------------------------------------------------------

def test_watcher_publishes_diffs_and_exits_with_last_subscriber(monkeypatch, tmp_path):
    monkeypatch.setattr(events, "TICK", 0.02)
    monkeypatch.setattr(events, "CLAUDE_DIR", tmp_path)
    jobs = {}
    monkeypatch.setattr(events, "CHAT_JOBS", jobs)
    transcript = tmp_path / "proj" / "s1.jsonl"
    transcript.parent.mkdir()
    transcript.write_text(json.dumps({"uuid": "u0"}) + "\n")
    monkeypatch.setattr(events, "transcript_path", lambda sid: transcript if sid == "s1" else None)

    hub = events.Hub()
    watcher = events.Watcher(hub)
    hub._on_first = watcher.ensure
    sub = hub.subscribe()
    time.sleep(0.06)                       # baseline taken

    jobs["s1"] = {"running": True, "queue": [], "host": "local"}
    seen = _collect(sub, {"turn-start", "list-changed"})
    assert {"turn-start", "list-changed"} <= seen

    with open(transcript, "a") as f:
        f.write(json.dumps({"uuid": "u1"}) + "\n")
    ev = _wait_for(sub, "transcript-changed")
    assert ev["session"] == "s1" and ev["uuid"] == "u1" and ev["size"] == transcript.stat().st_size

    jobs["s1"]["running"] = False
    assert _wait_for(sub, "turn-end")["session"] == "s1"

    hub.unsubscribe(sub)
    deadline = time.monotonic() + 1
    while watcher._thread is not None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert watcher._thread is None         # no subscribers, no polling thread

    sub2 = hub.subscribe()                 # and a new subscriber revives it
    assert watcher._thread is not None
    hub.unsubscribe(sub2)


def test_remote_job_transcript_is_not_statted(monkeypatch, tmp_path):
    monkeypatch.setattr(events, "CHAT_JOBS", {"r": {"running": True, "host": "box"}})
    looked = []
    monkeypatch.setattr(events, "transcript_path", lambda sid: looked.append(sid))
    snap = events.Watcher(events.Hub())._snapshot()
    assert snap["r"]["size"] is None and looked == []


def _wait_for(sub, kind, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ev = sub.get(timeout=0.1)
        if ev and ev["type"] == kind:
            return ev
    raise AssertionError(f"no {kind} event")


def _collect(sub, kinds, timeout=2.0):
    seen, deadline = set(), time.monotonic() + timeout
    while not kinds <= seen and time.monotonic() < deadline:
        ev = sub.get(timeout=0.1)
        if ev:
            seen.add(ev["type"])
    return seen
