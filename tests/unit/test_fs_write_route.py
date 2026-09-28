"""Tests for /api/fs/write (viewer/routes/fs.py) — the JSON single-file write
the agent MCP's fs_write tool calls, and its lockstep with the MCP tool table.

The multipart upload and this route must land in the same store (_fs_store),
so a drive/host that works for one works for the other. Local disk is a tmp
dir; the drive leg is a fake adapter — no Postgres, no network.
"""
import base64

import pytest

from viewer import viewer_mcp
from viewer.routes import fs as fs_routes
from viewer.routes.fs import FsMixin
from viewer.server import SessionViewerHandler


class _Handler(FsMixin):
    def __init__(self, body):
        self.sent = None
        self._body = body

    def send_json(self, data, status=200):
        self.sent = (data, status)

    def read_body(self):
        return self._body


class _Req:
    def __init__(self, query=None, host="local"):
        self.query = query or {}
        self.host = host


class _FakeDrive:
    def __init__(self):
        self.calls = []

    def upload(self, path, files):
        self.calls.append((path, files))
        return {"uploaded": [{"name": n, "size": len(b)} for n, b in files]}


def test_writes_text_file_locally(tmp_path):
    h = _Handler({"path": str(tmp_path), "name": "notes.md", "content": "# hi\n"})
    h._p_fs_write(_Req())
    data, status = h.sent
    assert status == 200 and data["uploaded"][0]["name"] == "notes.md"
    assert (tmp_path / "notes.md").read_text() == "# hi\n"


def test_base64_content_is_decoded(tmp_path):
    raw = bytes(range(256))
    h = _Handler({"path": str(tmp_path), "name": "blob.bin",
                  "content": base64.b64encode(raw).decode(), "encoding": "base64"})
    h._p_fs_write(_Req())
    assert h.sent[1] == 200
    assert (tmp_path / "blob.bin").read_bytes() == raw


@pytest.mark.parametrize("body", [
    {"path": "/tmp", "name": "../x", "content": "a"},
    {"path": "/tmp", "name": "", "content": "a"},
    {"path": "/tmp", "name": "ok.txt", "content": 5},
    {"path": "/tmp", "name": "ok.txt", "content": "!!!", "encoding": "base64"},
    None,
])
def test_bad_bodies_are_400(body, tmp_path):
    h = _Handler(body)
    h._p_fs_write(_Req())
    assert h.sent[1] == 400
    assert not list(tmp_path.iterdir())


def test_drive_scope_goes_to_the_adapter(monkeypatch):
    drive = _FakeDrive()
    monkeypatch.setattr(fs_routes, "adapter_for", lambda did: drive)
    h = _Handler({"path": "/Reports", "name": "q3.csv", "content": "a,b\n", "drive": "dr-1"})
    h._p_fs_write(_Req())
    assert h.sent[1] == 200
    assert drive.calls == [("/Reports", [("q3.csv", b"a,b\n")])]


def test_mcp_file_tools_are_wired():
    """The agent's file tools proxy to routes the server serves, scope by
    drive/host, and never expose the Red file ops (rename/delete)."""
    posts, gets = SessionViewerHandler.POST_ROUTES, SessionViewerHandler.GET_ROUTES
    assert viewer_mcp._TOOLS["fs_write"] == ("POST", "/api/fs/write") and "/api/fs/write" in posts
    assert viewer_mcp._TOOLS["fs_list"] == ("GET", "/api/fs") and "/api/fs" in gets
    assert viewer_mcp._TOOLS["drive_list"] == ("GET", "/api/drives")
    assert "fs_read" in viewer_mcp._RAW
    names = {t["name"] for t in viewer_mcp._TOOL_LIST}
    assert {"drive_list", "fs_list", "fs_read", "fs_write", "fs_mkdir"} <= names
    assert not {"fs_delete", "fs_rename"} & set(viewer_mcp._TOOLS)
    for t in viewer_mcp._TOOL_LIST:
        if t["name"].startswith("fs_"):
            assert {"drive", "host"} <= set(t["inputSchema"]["properties"]), t["name"]
