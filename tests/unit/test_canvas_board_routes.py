"""viewer.routes.canvas_board: the socket's write path, without a socket."""
from viewer import canvas_room as cr
from viewer.routes import canvas_board as cb


class Sub:
    def __init__(self):
        self.msgs = []

    def offer(self, msg, lossy=False):
        self.msgs.append(msg)
        return True


def el(i, v=1):
    return {"id": i, "type": "rectangle", "version": v, "versionNonce": 1}


def room(stored=()):
    reg = cr.Registry(loader=lambda cid: list(stored), saver=lambda *a: None)
    return reg.get(1)


def test_editor_gets_ack_and_the_winner_for_a_stale_write():
    r, s = room([el("x", 5)]), Sub()
    cb.CanvasBoardMixin._canvas_apply(r, s, "P", "user:a", True, [el("x", 3), el("y")])
    assert s.msgs[0] == {"t": "ack", "ids": ["y"]}
    (item,) = s.msgs[1]["items"]
    assert item[0] == "x" and item[1] == "stale" and item[2]["version"] == 5


def test_viewer_is_refused_and_told_the_stored_copy():
    r, s = room([el("x", 5)]), Sub()
    cb.CanvasBoardMixin._canvas_apply(r, s, "P", "user:v", False, [el("x", 9), el("new")])
    assert s.msgs[0]["ids"] == []
    items = {i[0]: i for i in s.msgs[1]["items"]}
    assert items["x"][1] == "read-only" and items["x"][2]["version"] == 5
    assert items["new"][2] is None                       # client deletes its local copy
    assert r.stored(["x"])["x"]["version"] == 5           # nothing changed


def test_oversized_batch_applies_the_first_part_and_refuses_the_rest(monkeypatch):
    monkeypatch.setattr(cb, "MAX_BATCH", 2)
    r, s = room(), Sub()
    cb.CanvasBoardMixin._canvas_apply(r, s, "P", "a", True, [el("a"), el("b"), el("c")])
    assert s.msgs[0]["ids"] == ["a", "b"]
    assert [i[:2] for i in s.msgs[1]["items"]] == [["c", "batch too large"]]


def test_presence_carries_only_known_fields_and_viewer_role_cannot_edit():
    assert cb.presence_payload({"pointer": {"x": 1}, "evil": "x", "t": "presence"}) == {"pointer": {"x": 1}}
    assert not cb.can_edit({"human_role": "viewer"})
    assert cb.can_edit({"human_role": "owner"})


def _frame(payload, mask=b"\x01\x02\x03\x04"):
    import struct
    n = len(payload)
    head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack("!H", n))
    return head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))


def test_ws_recv_unmasks_and_refuses_an_oversized_frame_before_reading_it():
    import socket
    import pytest
    from viewer.browser import WSServer
    a, b = socket.socketpair()
    try:
        ws = WSServer(a)
        b.sendall(_frame(b"hello world, a masked frame" * 10))
        assert ws.recv(max_payload=1000) == (0x1, b"hello world, a masked frame" * 10)
        b.sendall(_frame(b"x" * 2000)[:8])                # header only: the body never arrives
        with pytest.raises(OSError):
            ws.recv(max_payload=1000)
    finally:
        a.close(); b.close()


# -- agent routes (read / patch / snapshot / revert) ---------------------------
import io

import pytest

from viewer import db

AGENT = {"kind": "mcp", "actor": "session:s1", "human_role": "owner", "level": "lead"}
AGENT_IC = {**AGENT, "level": "ic"}
OWNER = {"kind": "app", "actor": "user:o", "human_role": "owner"}
VIEWER = {"kind": "app", "actor": "user:v", "human_role": "viewer"}


class Req:
    def __init__(self, principal, query=None):
        self.principal = principal
        self.query = {k: [v] for k, v in (query or {}).items()}


class H(cb.CanvasBoardMixin):
    def __init__(self, body=None):
        self._body, self.sent, self.headers_out, self.wfile = body, None, {}, io.BytesIO()

    def read_body(self):
        return self._body

    def send_json(self, data, status=200):
        self.sent = (data, status)

    def send_response(self, status):
        self.sent = (None, status)

    def send_header(self, k, v):
        self.headers_out[k] = v

    def end_headers(self):
        pass


@pytest.fixture
def world(monkeypatch):
    reg = cr.Registry(loader=lambda cid: [], saver=lambda *a: None)
    audits = []
    monkeypatch.setattr(cb, "ROOMS", reg)
    monkeypatch.setattr(cb, "_rate", {})
    monkeypatch.setattr(db, "project_get", lambda pid: {"id": pid} if pid == 7 else None)
    monkeypatch.setattr(db, "canvas_board_for", lambda kind, pid: {"id": 3})
    monkeypatch.setattr(db, "canvas_board_get", lambda cid: {"id": cid} if cid == 3 else None)
    monkeypatch.setattr(db, "audit_append", lambda *a: audits.append(a))
    monkeypatch.setattr(db, "card_get", lambda rid: None)
    monkeypatch.setattr(db, "note_get", lambda rid: None)
    return reg, audits


def patch(principal, body):
    h = H(body)
    h._p_canvas_agent_patch(Req(principal))
    return h.sent


def add_rect(label="Build", x=0):
    return {"op": "add", "element": {"type": "rectangle", "x": x, "y": 0, "label": label}}


def test_patch_is_agents_only_and_never_for_a_viewer_role(world):
    assert patch(OWNER, {"project": 7, "ops": [add_rect()]})[1] == 403
    assert patch({**AGENT, "human_role": "viewer"}, {"project": 7, "ops": [add_rect()]})[1] == 403


def test_patch_validates_ops_and_target(world):
    assert patch(AGENT, {"project": 7, "ops": "add"})[1] == 400
    assert patch(AGENT, {"project": 99, "ops": [add_rect()]})[1] == 404
    assert patch(AGENT, {"canvas": 5, "ops": [add_rect()]})[1] == 404
    assert patch(AGENT, {"project": 7, "ops": []})[1] == 400          # build refuses an empty list


def test_patch_writes_through_the_room_and_audits(world):
    reg, audits = world
    data, status = patch(AGENT, {"project": 7, "ops": [add_rect(), {"op": "nope"}]})
    assert status == 200 and data["canvas"] == 3
    assert [r["ok"] for r in data["results"]] == [True, False]
    assert len(data["accepted"]) == 2                                 # shape + its label
    assert set(data["accepted"]) <= set(reg.get(3).stored(data["accepted"]))
    assert audits[0][1] == "canvas_patch" and audits[0][2] == "canvas:3"


def test_patch_rate_limit_refuses_without_spending(world):
    ops = [add_rect(x=i * 200) for i in range(cb.AGENT_OPS_PER_SEC)]
    assert patch(AGENT, {"project": 7, "ops": ops})[1] == 200
    assert patch(AGENT, {"project": 7, "ops": [add_rect()]})[1] == 429
    assert patch({**AGENT, "actor": "session:s2"}, {"project": 7, "ops": [add_rect()]})[1] == 200


def test_own_work_agent_changes_only_what_it_drew(world):
    data, _ = patch(AGENT, {"project": 7, "ops": [add_rect()]})
    theirs = data["results"][0]["ids"][0]
    other = {**AGENT_IC, "actor": "session:s2"}
    data, _ = patch(other, {"project": 7, "ops": [{"op": "delete", "id": theirs}]})
    assert data["results"][0]["ok"] is False and "not yours" in data["results"][0]["error"]
    data, _ = patch({**AGENT, "actor": "session:s3"}, {"project": 7, "ops": [{"op": "delete", "id": theirs}]})
    assert data["results"][0]["ok"] is True                          # Workspace level may


def test_read_returns_the_summary_with_the_canvas_id(world):
    patch(AGENT, {"project": 7, "ops": [add_rect("Ship")]})
    h = H()
    h._g_canvas_agent_read(Req(AGENT, {"project": "7"}))
    data, status = h.sent
    assert status == 200 and data["canvas"] == 3
    assert any(s.get("label") == "Ship" for s in data["shapes"])


def snapshot(query):
    h = H()
    h._g_canvas_agent_snapshot(Req(AGENT, query))
    return h


def test_snapshot_refuses_bad_or_empty_areas(world):
    patch(AGENT, {"project": 7, "ops": [add_rect()]})
    assert snapshot({"project": "7", "bbox": "1,2,3"}).sent[1] == 400
    assert snapshot({"project": "7", "bbox": "a,b,c,d"}).sent[1] == 400
    assert snapshot({"project": "7", "bbox": "5000,5000,6000,6000"}).sent[1] == 400
    assert snapshot({"project": "7"}).sent[1] == 400                   # no target at all
    assert snapshot({"project": "7", "group": "g-00000000"}).sent[1] == 400


def test_snapshot_returns_a_png(world):
    pytest.importorskip("PIL")
    patch(AGENT, {"project": 7, "ops": [add_rect()]})
    h = snapshot({"project": "7", "bbox": "-10,-10,300,200"})
    assert h.sent == (None, 200) and h.headers_out["Content-Type"] == "image/png"
    assert h.wfile.getvalue().startswith(b"\x89PNG")


def revert(principal, body):
    h = H(body)
    h._p_canvas_revert(Req(principal))
    return h.sent


def test_revert_is_a_persons_net_only(world):
    assert revert(AGENT, {"canvas": 3, "actor": "session:s1"})[1] == 403
    assert revert(VIEWER, {"canvas": 3, "actor": "session:s1"})[1] == 403
    assert revert(OWNER, {"canvas": 3, "actor": "user:x"})[1] == 400
    assert revert(OWNER, {"canvas": 9, "actor": "session:s1"})[1] == 404


def test_revert_takes_back_the_agents_last_patch(world):
    reg, audits = world
    data, _ = patch(AGENT, {"project": 7, "ops": [add_rect()]})
    ids = data["accepted"]
    out, status = revert(OWNER, {"canvas": 3, "actor": "session:s1"})
    assert status == 200 and out == {"ok": True, "reverted": 2}
    assert all(e["isDeleted"] for e in reg.get(3).stored(ids).values())
    assert audits[-1][1] == "canvas_revert"
    assert revert(OWNER, {"canvas": 3, "actor": "session:s1"})[0] == {"ok": True, "reverted": 0}
