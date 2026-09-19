"""Unit tests for the cloud-drive spine (Phase 1 of storage integrations):
- viewer.drives: the plugin-lifecycle gate (adapter_for) — unknown 404,
  hidden/paused 403, unknown kind 501 — and the _Pending adapter whose every
  op is a clean 501 until its vendor's phase lands.
- routes/fs._resolve_location: exactly one of drive/host; no params means
  local (the pre-drive behavior); drive comes from the query (GET) or the
  JSON body (POST).
- the adapter interface contract: the methods the fs routes call on an
  adapter are exactly the nine BaseDrive implements (a new op added to the
  routes must be added to the interface, or this test fails).

No Postgres, no network: the db module is monkeypatched with an in-memory
fake, the way test_providers.py does it.
"""
import re
from pathlib import Path

import pytest

from viewer import drives
from viewer.drives import BaseDrive, DriveError, _Pending, adapter_for
from viewer.routes.fs import _resolve_location


class _FakeDriveDB:
    """In-memory stand-in for the drives table: only drive_get, which
    adapter_for calls. Rows mirror db._drive_row's shape."""

    def __init__(self, rows):
        self.rows = rows

    def drive_get(self, did):
        return dict(self.rows[did]) if did in self.rows else None


@pytest.fixture()
def db(monkeypatch):
    """Back viewer.drives with the fake db; the fixture holds the rows."""
    fake = _FakeDriveDB({})
    monkeypatch.setattr(drives, "db", fake)
    return fake


def _row(kind="google", status="active", hidden=False):
    return {
        "id": "drive1", "label": "My Drive", "kind": kind,
        "config": {"account": "ram@example.com"}, "status": status,
        "hidden": hidden, "created_at": 0.0,
    }


# --- adapter_for: the single choke point for every file route ------------


def test_unknown_drive_is_404(db):
    err = pytest.raises(DriveError, adapter_for, "nope").value
    assert err.status == 404


def test_hidden_drive_is_403(db):
    db.rows["d1"] = _row(hidden=True)
    err = pytest.raises(DriveError, adapter_for, "d1").value
    assert err.status == 403 and "hidden" in str(err)


def test_paused_drive_is_403(db):
    db.rows["d1"] = _row(status="paused")
    err = pytest.raises(DriveError, adapter_for, "d1").value
    assert err.status == 403 and "paused" in str(err)


def test_active_drive_gets_its_adapter(db):
    db.rows["d1"] = _row(kind="google")
    a = adapter_for("d1")
    assert isinstance(a, _Pending)
    assert a.config["account"] == "ram@example.com"


def test_unknown_kind_is_501(db):
    db.rows["d1"] = _row(kind="icloud")
    err = pytest.raises(DriveError, adapter_for, "d1").value
    assert err.status == 501


# --- _Pending: every op is a clean 501 until its phase lands --------------

def _pending(db):
    db.rows["d1"] = _row(kind="google")
    return adapter_for("d1")


def test_pending_ops_are_501_with_kind(db):
    a = _pending(db)
    for call in (
        lambda: a.fs_list("~"),
        lambda: a.read_bytes("/x"),
        lambda: a.upload("/x", [("n", b"data")]),
        lambda: a.mkdir("/x", "n"),
        lambda: a.rename("/x", "n"),
        lambda: a.delete("/x"),
        lambda: a.compress("/x", ["a", "b"], ""),
        lambda: a.build_zip("/x", ["a"]),
    ):
        err = pytest.raises(DriveError, call).value
        assert err.status == 501
        assert "google" in str(err)


def test_pending_status_reports_not_built(db):
    s = _pending(db).status()
    assert s["ok"] is False and "not built" in s["error"]


# --- the interface contract: routes call exactly the nine BaseDrive ops ---

def test_route_call_sites_match_the_interface():
    fs_src = (Path(__file__).resolve().parents[2] / "viewer" / "routes" / "fs.py").read_text()
    called = set(re.findall(r"adapter\.(\w+)\(", fs_src))
    implemented = {
        m for m in dir(BaseDrive)
        if not m.startswith("_") and callable(getattr(BaseDrive, m))
    }
    # `status` is the ninth interface method but is called by the
    # /api/drives management route (Phase 4), not by the fs routes.
    assert called == {
        "fs_list", "read_bytes", "upload", "mkdir", "rename",
        "delete", "compress", "build_zip",
    }
    assert called | {"status"} <= implemented
    # A _Pending subclass must override every op the routes can call, or a
    # vendor phase that forgets one would 501 with the base message instead
    # of the pending one.
    pending = {m for m in _Pending.__dict__ if not m.startswith("_") and m != "kind"}
    assert called <= pending


# --- _resolve_location: exactly one of drive/host -------------------------

class _FakeReq:
    """Duck-typed stand-in for server._Req: the handlers only touch
    .query (dict of param->list) and .host (the query's host, default
    'local')."""

    def __init__(self, query=None, host="local"):
        self.query = query or {}
        self.host = host


def test_no_params_means_local():
    assert _resolve_location(_FakeReq()) == ("local", "local")


def test_query_host_is_ssh():
    assert _resolve_location(_FakeReq(query={"host": ["web1"]}, host="web1")) == ("ssh", "web1")


def test_body_host_is_ssh():
    assert _resolve_location(_FakeReq(), body={"host": "web1"}) == ("ssh", "web1")


def test_body_host_beats_query_local_default():
    # The JSON body is what POST handlers read; the query default is "local".
    assert _resolve_location(_FakeReq(), body={"host": "web1"}) == ("ssh", "web1")


def test_query_drive_wins():
    assert _resolve_location(_FakeReq(query={"drive": ["gdrive"]})) == ("drive", "gdrive")


def test_body_drive_wins():
    assert _resolve_location(_FakeReq(), body={"drive": "gdrive"}) == ("drive", "gdrive")


def test_drive_and_host_together_is_400():
    err = pytest.raises(
        DriveError,
        _resolve_location,
        _FakeReq(query={"drive": ["gdrive"], "host": ["web1"]}, host="web1"),
    ).value
    assert err.status == 400


def test_body_drive_and_query_host_is_400():
    err = pytest.raises(
        DriveError,
        _resolve_location,
        _FakeReq(query={"host": ["web1"]}, host="web1"),
        body={"drive": "gdrive"},
    ).value
    assert err.status == 400
