"""orchestrator.events: the pub-sub, the snapshot diff, the list throttle and the
watcher's lifecycle — all without a server or a database."""
import json
import threading
import time

from orchestrator import events


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


class _FakeRemote:
    """RemoteSizes' surface without threads: records want(), serves sizes."""

    def __init__(self, sizes=None):
        self.sizes, self.wanted = sizes or {}, []

    def want(self, by_host):
        self.wanted.append(by_host)

    def size(self, host, sid):
        return self.sizes.get((host, sid))


def test_remote_job_is_asked_of_its_host_never_statted_locally(monkeypatch):
    monkeypatch.setattr(events, "CHAT_JOBS", {"r": {"running": True, "host": "box"}})
    looked = []
    monkeypatch.setattr(events, "transcript_path", lambda sid: looked.append(sid))
    remote = _FakeRemote()
    snap = events.Watcher(events.Hub(), remote)._snapshot()
    assert snap["r"]["size"] is None and looked == []
    assert remote.wanted == [{"box": {"r": {"host": "box", "agent": "claude", "path": ""}}}]
    remote.sizes[("box", "r")] = 42
    assert events.Watcher(events.Hub(), remote)._snapshot()["r"]["size"] == 42


# ---- watch frames -----------------------------------------------------------------------

def test_parse_watch_reads_specs_with_defaults():
    got = events.parse_watch(json.dumps({"type": "watch", "sessions": [
        {"session": "a"}, {"session": "b", "host": "box", "agent": "codex", "path": "2026/x.jsonl"}]}))
    assert got == {"a": {"host": "local", "agent": "claude", "path": ""},
                   "b": {"host": "box", "agent": "codex", "path": "2026/x.jsonl"}}


def test_parse_watch_rejects_other_frames_and_bad_entries():
    for text in ("", "not json", "[]", json.dumps({"type": "ping"}),
                 json.dumps({"type": "watch", "sessions": "a"})):
        assert events.parse_watch(text) is None
    got = events.parse_watch(json.dumps({"type": "watch", "sessions": [
        "a", {"session": ""}, {"session": "x/y"}, {"session": 3}, {"session": "ok", "path": 5},
        {"session": "z" * 201}, {"session": "fine"}]}))
    assert list(got) == ["fine"]
    assert events.parse_watch(json.dumps({"type": "watch", "sessions": []})) == {}


def test_parse_watch_caps_the_count():
    many = [{"session": f"s{i}"} for i in range(events.WATCH_MAX + 3)]
    got = events.parse_watch(json.dumps({"type": "watch", "sessions": many}))
    assert list(got) == [f"s{i}" for i in range(events.WATCH_MAX)]


def test_watch_acks_tell_each_change_of_visibility_once():
    acked = {}
    watch = {"a": {}, "b": {}}
    snap = {"a": {"size": 10}, "b": {"size": None}}
    assert events.watch_acks(watch, acked, snap) == [
        {"type": "watching", "session": "a", "ok": True},
        {"type": "watching", "session": "b", "ok": False}]
    assert events.watch_acks(watch, acked, snap) == []          # nothing changed
    snap["a"]["size"] = 20
    assert events.watch_acks(watch, acked, snap) == []          # growth is not visibility
    snap["b"] = {"size": 5}                                     # the remote stat landed
    assert events.watch_acks(watch, acked, snap) == [{"type": "watching", "session": "b", "ok": True}]
    assert events.watch_acks({"b": {}}, acked, snap) == [] and list(acked) == ["b"]
    assert events.watch_acks({"a": {}, "b": {}}, acked, snap) == [
        {"type": "watching", "session": "a", "ok": True}]       # re-watched: told again


def test_hub_watched_is_the_union_first_wins():
    hub = events.Hub()
    s1, s2 = hub.subscribe(), hub.subscribe()
    s1.watch = {"a": {"host": "local"}}
    s2.watch = {"a": {"host": "box"}, "b": {"host": "local"}}
    got = hub.watched()
    assert set(got) == {"a", "b"} and got["b"] == {"host": "local"}


def test_local_transcript_confines_a_claude_path_to_the_projects_root(monkeypatch, tmp_path):
    root = tmp_path / "projects"
    (root / "p").mkdir(parents=True)
    f = root / "p" / "s.jsonl"
    f.write_text("{}\n")
    outside = tmp_path / "projects-evil" / "s.jsonl"
    outside.parent.mkdir()
    outside.write_text("{}\n")
    monkeypatch.setattr(events, "CLAUDE_DIR", root)
    monkeypatch.setattr(events, "transcript_path", lambda sid: "by-id")
    spec = {"agent": "claude", "path": "projects/p/s.jsonl"}
    assert events.local_transcript("s", spec) == f.resolve()
    for bad in ("projects/../projects-evil/s.jsonl", "../etc/passwd", "projects/p/missing.jsonl"):
        assert events.local_transcript("s", {"agent": "claude", "path": bad}) == "by-id"
    assert events.local_transcript("s", {"agent": "claude", "path": ""}) == "by-id"


def test_local_transcript_of_another_agent_needs_its_path(monkeypatch):
    calls = []
    monkeypatch.setattr("orchestrator.adapters.resolve_agent_session",
                        lambda agent, rel: calls.append((agent, rel)) or "resolved")
    assert events.local_transcript("s", {"agent": "codex", "path": ""}) is None
    assert events.local_transcript("s", {"agent": "codex", "path": "a/b.jsonl"}) == "resolved"
    assert calls == [("codex", "a/b.jsonl")]


def test_watched_session_no_run_owns_reports_growth_and_ack(monkeypatch, tmp_path):
    monkeypatch.setattr(events, "TICK", 0.02)
    monkeypatch.setattr(events, "CLAUDE_DIR", tmp_path / "projects")
    monkeypatch.setattr(events, "CHAT_JOBS", {})
    f = tmp_path / "projects" / "p" / "cli.jsonl"
    f.parent.mkdir(parents=True)
    f.write_text(json.dumps({"uuid": "u0"}) + "\n")
    monkeypatch.setattr(events, "transcript_path", lambda sid: None)
    hub = events.Hub()
    watcher = events.Watcher(hub, _FakeRemote())
    hub._on_first = watcher.ensure
    sub = hub.subscribe()
    sub.watch = events.parse_watch(json.dumps({"type": "watch", "sessions": [
        {"session": "cli", "path": "projects/p/cli.jsonl"}, {"session": "gone"}]}))
    acks = {}
    deadline = time.monotonic() + 2
    while len(acks) < 2 and time.monotonic() < deadline:
        ev = sub.get(timeout=0.1)
        if ev and ev["type"] == "watching":
            acks[ev["session"]] = ev["ok"]
    assert acks == {"cli": True, "gone": False}
    with open(f, "a") as fh:
        fh.write(json.dumps({"uuid": "u1"}) + "\n")
    ev = _wait_for(sub, "transcript-changed")
    assert ev["session"] == "cli" and ev["uuid"] == "u1"
    hub.unsubscribe(sub)


# ---- RemoteSizes ------------------------------------------------------------------------

def test_remote_sizes_polls_each_wanted_host_and_stops_when_unwanted(monkeypatch):
    monkeypatch.setattr(events, "REMOTE_EVERY", 0.01)
    calls = []

    def stat(host, specs, paths):
        calls.append((host, sorted(specs)))
        return {sid: 7 for sid in specs}

    rs = events.RemoteSizes(stat)
    rs.want({"box": {"a": {}}, "empty": {}})
    deadline = time.monotonic() + 2
    while rs.size("box", "a") is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert rs.size("box", "a") == 7 and rs.polling() == {"box"}
    assert all(h == "box" for h, _ in calls)
    rs.want({})
    deadline = time.monotonic() + 2
    while rs.polling() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert rs.polling() == set() and rs.size("box", "a") is None


def test_remote_sizes_failure_reads_unknown_then_recovers(monkeypatch):
    monkeypatch.setattr(events, "REMOTE_EVERY", 0.01)
    monkeypatch.setattr(events, "REMOTE_BACKOFF", 0.05)
    state = {"fail": False, "paths_seen": []}

    def stat(host, specs, paths):
        state["paths_seen"].append(dict(paths))
        if state["fail"]:
            raise OSError("host unreachable")
        paths["a"] = "/home/u/.claude/projects/p/a.jsonl"
        return {"a": 3}

    rs = events.RemoteSizes(stat)
    rs.want({"box": {"a": {}}})
    _until(lambda: rs.size("box", "a") == 3)
    state["fail"] = True
    _until(lambda: rs.size("box", "a") is None)
    state["fail"] = False
    _until(lambda: rs.size("box", "a") == 3)
    assert {} in state["paths_seen"][1:]      # a failed poll forgets resolved paths
    rs.want({})


def test_remote_sizes_thread_exits_when_nobody_asks(monkeypatch):
    monkeypatch.setattr(events, "REMOTE_EVERY", 0.01)
    monkeypatch.setattr(events, "REMOTE_IDLE", 0.05)
    rs = events.RemoteSizes(lambda h, s, p: {})
    rs.want({"box": {"a": {}}})               # and never again (a crashed watcher)
    _until(lambda: not rs.polling())


def test_remote_stat_resolves_once_and_stats_on_one_channel(monkeypatch):
    from contextlib import contextmanager
    from orchestrator import remote
    opened, resolved = [], []

    class St:
        st_size = 11

    class Sftp:
        def stat(self, p):
            if p.endswith("gone.jsonl"):
                raise FileNotFoundError("no such file")
            return St()

    @contextmanager
    def sftp(host):
        opened.append(host)
        yield Sftp()

    monkeypatch.setattr(remote.SSH, "sftp", sftp)
    monkeypatch.setattr(remote, "remote_resolve",
                        lambda h, sid: resolved.append(sid) or {"found": True, "path": f"projects/p/{sid}.jsonl"})
    monkeypatch.setattr(remote, "remote_full_path", lambda h, rel: "/h/.claude/" + rel)
    monkeypatch.setattr(remote, "remote_agent_full_path", lambda h, a, rel: f"/h/.{a}/" + rel)
    specs = {"job": {"host": "box", "agent": "claude", "path": ""},
             "cx": {"host": "box", "agent": "codex", "path": "x.jsonl"},
             "nopath": {"host": "box", "agent": "codex", "path": ""},
             "gone": {"host": "box", "agent": "claude", "path": "projects/p/gone.jsonl"}}
    paths = {}
    assert events._remote_stat("box", specs, paths) == {"job": 11, "cx": 11}
    assert opened == ["box"] and resolved == ["job"]
    assert "gone" not in paths and paths["cx"] == "/h/.codex/x.jsonl"
    events._remote_stat("box", specs, paths)
    assert resolved == ["job"] and opened == ["box", "box"]   # cached, one channel per poll


def _until(cond, timeout=2.0):
    deadline = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > deadline:
            raise AssertionError("condition never held")
        time.sleep(0.01)


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
