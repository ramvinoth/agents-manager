"""viewer.canvas_room: relay without echo, ack/reject, flush retry, idle unload."""
import json
import time

from viewer import canvas_room as cr


def el(i="a", v=1, n=5, **kw):
    return dict({"id": i, "type": "rectangle", "version": v, "versionNonce": n}, **kw)


class Sink:
    def __init__(self):
        self.msgs = []

    def __call__(self, text):
        self.msgs.append(json.loads(text))

    def of(self, t, wait=1.0):
        end = time.time() + wait
        while time.time() < end:
            got = [m for m in self.msgs if m["t"] == t]
            if got:
                return got
            time.sleep(0.01)
        return []


def make(stored=(), saver=None):
    saved = []
    reg = cr.Registry(loader=lambda cid: list(stored),
                      saver=saver or (lambda cid, els, actor: saved.append((actor, els))))
    return reg, saved


def test_apply_relays_to_peers_but_never_echoes_to_sender():
    reg, _ = make()
    room = reg.get(1)
    a, b = Sink(), Sink()
    room.join("A", a)
    room.join("B", b)
    acc, rej = room.apply([el("x")], peer_id="A", actor="ram")
    assert [e["id"] for e in acc] == ["x"] and rej == []
    assert b.of("elements")[0]["elements"][0]["id"] == "x"
    time.sleep(0.05)
    assert a.of("elements", wait=0) == []


def test_stale_write_is_rejected_with_the_stored_winner():
    reg, _ = make(stored=[el("x", v=5)])
    room = reg.get(1)
    acc, rej = room.apply([el("x", v=3)], peer_id="A")
    assert acc == [] and rej[0][0] == "x" and rej[0][1] == "stale" and rej[0][2]["version"] == 5


def test_flush_writes_once_per_actor_and_retries_after_a_db_error():
    calls, fail = [], [True]

    def saver(cid, els, actor):
        if fail[0]:
            raise RuntimeError("db down")
        calls.append((actor, sorted(e["id"] for e in els)))

    reg, _ = make(saver=saver)
    room = reg.get(1)
    room.apply([el("x"), el("y")], actor="ram")
    room.apply([el("z")], actor="agent")
    assert room.flush() == 0 and len(room.dirty) == 3      # failed: still dirty
    fail[0] = False
    assert room.flush() == 3
    assert sorted(calls) == [("agent", ["z"]), ("ram", ["x", "y"])]
    assert room.flush() == 0                               # nothing left


def test_flush_writes_the_latest_version_not_the_first_seen():
    reg, saved = make()
    room = reg.get(1)
    room.apply([el("x", v=1)], actor="ram")
    room.apply([el("x", v=2)], actor="ram")
    room.flush()
    assert [e["version"] for _, els in saved for e in els] == [2]


def test_presence_is_dropped_first_under_backpressure():
    reg, _ = make()
    room = reg.get(1)
    sub = room.join("B", lambda text: time.sleep(10))      # a writer that never drains
    for _ in range(300):
        room.presence("A", {"x": 1})
    assert sub.q.qsize() <= 129                            # half the queue, plus one in flight
    room.apply([el("x")], peer_id="A")                     # a real change still gets in
    assert any(m and m.get("t") == "elements" for m in list(sub.q.queue))


def test_checksum_broadcast_and_snapshot_agree():
    reg, _ = make(stored=[el("x", v=2), el("gone", isDeleted=True)])
    room = reg.get(1)
    snap = room.snapshot()
    b = Sink()
    room.join("B", b)
    reg.tick(time.time(), with_checksum=True)
    assert b.of("checksum")[0]["checksum"] == snap["checksum"]
    assert len(snap["elements"]) == 2                      # tombstones ship so peers converge


def test_idle_room_unloads_only_when_empty_and_flushed():
    reg, saved = make()
    room = reg.get(1)
    room.join("A", Sink())
    room.apply([el("x")], actor="ram")
    later = time.time() + cr.IDLE_UNLOAD_S + 1
    reg.tick(later)
    assert reg.loaded() == [room]                          # a peer is still here
    room.leave("A")
    room.touched = 0
    reg.tick(later)
    assert reg.loaded() == [] and saved                    # flushed, then unloaded
    assert reg.get(1) is not room                          # next use reloads from the DB


def test_get_returns_one_room_per_canvas():
    reg, _ = make()
    assert reg.get(1) is reg.get("1")
    assert reg.get(1) is not reg.get(2)


def test_leave_tells_the_remaining_peers():
    reg, _ = make()
    room = reg.get(1)
    b = Sink()
    room.join("A", Sink())
    room.join("B", b)
    room.leave("A")
    assert b.of("leave")[0]["peer"] == "A"
    room.leave("A")                                        # twice is harmless
    time.sleep(0.05)
    assert len([m for m in b.msgs if m["t"] == "leave"]) == 1


ADD = [{"op": "add", "element": {"type": "rectangle", "label": "Build"}}]


def test_patch_relays_to_every_peer_from_the_agent_and_marks_it_dirty():
    reg, saved = make()
    room = reg.get(1)
    a, b = Sink(), Sink()
    room.join("A", a)
    room.join("B", b)
    acc, res = room.patch(ADD, "session:me", True)
    assert res[0]["ok"] and len(acc) == 2                   # shape + its label
    for s in (a, b):
        m = s.of("elements")[0]
        assert m["from"] == "session:me" and len(m["elements"]) == 2
    room.flush()
    assert saved and all(actor == "session:me" for actor, _ in saved)


def test_own_only_refuses_a_human_shape_but_lead_may_change_it():
    reg, _ = make(stored=[el("h", customData={"createdBy": "ram"})])
    room = reg.get(1)
    acc, res = room.patch([{"op": "update", "id": "h", "set": {"x": 5}}], "session:me", True)
    assert acc == [] and "not yours" in res[0]["error"]
    assert room.revert("session:me", "ram") == []           # a refused patch leaves no undo
    acc, res = room.patch([{"op": "update", "id": "h", "set": {"x": 5}}], "session:me", False)
    assert res[0]["ok"] and acc[0]["x"] == 5 and acc[0]["version"] == 2


def test_revert_takes_the_patch_back_but_never_a_later_human_edit():
    reg, _ = make(stored=[el("h", v=3, x=0, customData={"createdBy": "ram"})])
    room = reg.get(1)
    acc, _ = room.patch([{"op": "update", "id": "h", "set": {"x": 9}},
                         {"op": "add", "element": {"type": "ellipse"}}], "session:me", False)
    new_id = next(e["id"] for e in acc if e["id"] != "h")
    room.apply([dict(room.elements["h"], x=50, version=5, versionNonce=1)], peer_id="A", actor="ram")
    out = room.revert("session:me", "ram")
    assert [e["id"] for e in out] == [new_id] and out[0]["isDeleted"]
    assert room.elements["h"]["x"] == 50                    # the person's later edit stands
    assert room.dirty[new_id] == "ram"
    assert room.revert("session:me", "ram") == []           # nothing left to undo


def test_revert_restores_the_prior_state_of_an_updated_element():
    reg, _ = make(stored=[el("h", v=3, x=0, customData={"createdBy": "ram"})])
    room = reg.get(1)
    room.patch([{"op": "update", "id": "h", "set": {"x": 9}}], "session:me", False)
    out = room.revert("session:me", "ram")
    assert out[0]["x"] == 0 and out[0]["version"] == 5 and room.elements["h"]["x"] == 0
