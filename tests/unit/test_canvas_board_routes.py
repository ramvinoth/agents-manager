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
