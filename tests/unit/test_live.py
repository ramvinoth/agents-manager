"""orchestrator.live: payload parsing, fan-out, backpressure drop, writer lifecycle."""
import json
import threading
import time

from orchestrator import live


def test_parse_event_accepts_ours_and_rejects_noise():
    ev = live.parse_event('{"table":"cards","id":"7","op":"INSERT","project_id":3}')
    assert ev == {"t": "change", "table": "cards", "id": "7", "op": "INSERT", "project_id": 3}
    for bad in (None, "", "not json", "[1]", '{"id":1}', '{"table":""}'):
        assert live.parse_event(bad) is None


def _hub(monkeypatch):
    hub = live.Hub()
    monkeypatch.setattr(hub, "_ensure_listener", lambda: None)  # no Postgres
    return hub


def _wait(pred, timeout=2.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.01)
    return False


def test_dispatch_reaches_every_subscriber(monkeypatch):
    hub = _hub(monkeypatch)
    got_a, got_b = [], []
    a = hub.subscribe(got_a.append)
    b = hub.subscribe(got_b.append)
    hub.dispatch({"t": "change", "table": "cards"})
    assert _wait(lambda: got_a and got_b)
    assert json.loads(got_a[0])["table"] == "cards"
    hub.unsubscribe(a); hub.unsubscribe(b)
    assert hub.count() == 0


def test_burst_overflow_collapses_to_one_resync_without_dropping(monkeypatch):
    hub = _hub(monkeypatch)
    gate = threading.Event()
    got = []

    def slow(m):
        gate.wait()
        got.append(json.loads(m))
    sub = hub.subscribe(slow)
    for i in range(live.QUEUE_MAX * 3):
        hub.dispatch({"t": "change", "table": "cards", "id": i})
    assert sub.alive and hub.count() == 1
    assert sub.q.qsize() <= live.QUEUE_MAX          # memory stays bounded
    gate.set()
    assert _wait(lambda: {"t": "resync"} in got)
    hub.unsubscribe(sub)


def test_send_error_stops_writer_and_closes(monkeypatch):
    hub = _hub(monkeypatch)
    closed = threading.Event()

    def boom(_):
        raise OSError("gone")
    sub = hub.subscribe(boom, on_close=closed.set)
    hub.dispatch({"t": "change", "table": "notes"})
    assert closed.wait(2)
    assert not sub.alive


def test_idle_writer_pings(monkeypatch):
    monkeypatch.setattr(live, "PING_S", 0.05)
    got = []
    sub = live.Subscriber(got.append)
    t = threading.Thread(target=sub.run, daemon=True)
    t.start()
    assert _wait(lambda: got)
    assert json.loads(got[0]) == {"t": "ping"}
    sub.stop()
    t.join(1)
    assert not t.is_alive()


def test_publish_never_raises(monkeypatch):
    monkeypatch.setattr(live.HUB, "dispatch", lambda m: (_ for _ in ()).throw(RuntimeError("x")))
    live.publish("tool_approvals", "s1", "DELETE")
