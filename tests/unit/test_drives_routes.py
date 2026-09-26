"""Tests for DrivesMixin (viewer/routes/drives.py) — the cloud-drive control
surface the file browser's location picker calls.

The handlers are thin mappers: one HTTP request → a call into the pure layer
(viewer.db drive helpers + viewer.drive_oauth) with a DriveError translated to
its HTTP status. So the tests stand those sources in with fakes and check the
SHAPES and the security property that matters: the list route never echoes the
per-user tokens or the vendor client secret out of the API. No Postgres, no
network.
"""
import pytest

from viewer import db, drive_oauth
from viewer.drives import DriveError
from viewer.routes.drives import DrivesMixin


class _Handler(DrivesMixin):
    def __init__(self, body=None):
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


def _fake_db(monkeypatch, rows=None):
    """In-memory stand-in for the four db helpers the mixin calls."""
    state = {"rows": dict(rows or {}), "upserts": [], "deleted": []}

    monkeypatch.setattr(db, "drives_load", lambda: state["rows"])
    monkeypatch.setattr(db, "drive_get", lambda did: state["rows"].get(did))
    monkeypatch.setattr(db, "drive_delete",
                        lambda did: (state["deleted"].append(did),
                                     did in state["rows"])[1])

    def upsert(did, entry):
        state["upserts"].append((did, entry))
        state["rows"][did] = {
            "id": did,
            "label": entry.get("label") or did,
            "kind": entry.get("kind") or "",
            "config": entry.get("config") or {},
            "status": entry.get("status") or "active",
            "hidden": bool(entry.get("hidden")),
        }
    monkeypatch.setattr(db, "drive_upsert", upsert)
    return state


# --- list ------------------------------------------------------------------

class TestList:
    def test_returns_sanitized_view_and_vendors(self, monkeypatch):
        _fake_db(monkeypatch, {
            "dr-1": {"id": "dr-1", "label": "Work Drive", "kind": "google",
                     "config": {"access_token": "SECRET-AT",
                                "refresh_token": "SECRET-RT"},
                     "status": "active", "hidden": False},
        })
        h = _Handler()
        h._g_drives(_Req())
        data, status = h.sent
        assert status == 200
        (d,) = data["drives"]
        # The public view has the identity + a presence flag, and NOTHING that
        # is a secret: no config dict, no token, no client.
        assert d == {"id": "dr-1", "label": "Work Drive", "kind": "google",
                     "status": "active", "hidden": False,
                     "authorized": True}
        assert data["vendors"] == ["google"]

    def test_secrets_never_leak_into_the_response(self, monkeypatch):
        _fake_db(monkeypatch, {
            "dr-1": {"id": "dr-1", "label": "D", "kind": "google",
                     "config": {"access_token": "TOP-SECRET",
                                "refresh_token": "MORE-SECRET"},
                     "status": "active", "hidden": False},
        })
        h = _Handler()
        h._g_drives(_Req())
        blob = str(h.sent[0])
        assert "TOP-SECRET" not in blob
        assert "MORE-SECRET" not in blob

    def test_hidden_drives_are_not_offered(self, monkeypatch):
        _fake_db(monkeypatch, {
            "dr-1": {"id": "dr-1", "label": "A", "kind": "google", "config": {},
                     "status": "active", "hidden": True},
            "dr-2": {"id": "dr-2", "label": "B", "kind": "google", "config": {},
                     "status": "active", "hidden": False},
        })
        h = _Handler()
        h._g_drives(_Req())
        assert [d["id"] for d in h.sent[0]["drives"]] == ["dr-2"]

    def test_unauthorized_when_no_tokens(self, monkeypatch):
        _fake_db(monkeypatch, {
            "dr-1": {"id": "dr-1", "label": "New", "kind": "google",
                     "config": {}, "status": "active", "hidden": False},
        })
        h = _Handler()
        h._g_drives(_Req())
        assert h.sent[0]["drives"][0]["authorized"] is False


# --- create ----------------------------------------------------------------

class TestCreate:
    def test_creates_row_and_returns_view(self, monkeypatch):
        state = _fake_db(monkeypatch)
        h = _Handler(body={"label": "Work", "kind": "google"})
        h._p_drives_create(_Req())
        data, status = h.sent
        assert status == 201
        assert data["drive"]["label"] == "Work"
        assert data["drive"]["kind"] == "google"
        assert data["drive"]["authorized"] is False
        # A real id was minted and a row recorded with an empty config.
        (did, entry) = state["upserts"][0]
        assert did.startswith("dr-")
        assert entry["config"] == {}

    def test_missing_label_is_400(self, monkeypatch):
        _fake_db(monkeypatch)
        h = _Handler(body={"kind": "google"})
        h._p_drives_create(_Req())
        assert h.sent[1] == 400

    def test_kind_without_a_built_flow_is_501(self, monkeypatch):
        _fake_db(monkeypatch)
        h = _Handler(body={"label": "X", "kind": "dropbox"})
        h._p_drives_create(_Req())
        assert h.sent[1] == 501

    def test_vendor_gate_comes_from_available_vendors(self, monkeypatch):
        _fake_db(monkeypatch)
        monkeypatch.setattr(drive_oauth, "available_vendors",
                            lambda: frozenset({"google", "onedrive"}))
        h = _Handler(body={"label": "O", "kind": "onedrive"})
        h._p_drives_create(_Req())
        assert h.sent[1] == 201   # the gate follows the vendor set, not a hardcode


# --- delete ----------------------------------------------------------------

class TestDelete:
    def test_deletes_known_drive(self, monkeypatch):
        state = _fake_db(monkeypatch, {"dr-1": {"id": "dr-1"}})
        h = _Handler(body={"drive": "dr-1"})
        h._p_drives_delete(_Req())
        assert h.sent == ({"ok": True, "drive": "dr-1"}, 200)
        assert "dr-1" in state["deleted"]

    def test_unknown_drive_is_404(self, monkeypatch):
        _fake_db(monkeypatch)
        h = _Handler(body={"drive": "nope"})
        h._p_drives_delete(_Req())
        assert h.sent[1] == 404

    def test_missing_drive_is_400(self, monkeypatch):
        _fake_db(monkeypatch)
        h = _Handler(body={})
        h._p_drives_delete(_Req())
        assert h.sent[1] == 400


# --- consent flow ------------------------------------------------------------

class TestOAuthStart:
    def test_forwards_to_drive_oauth_and_returns_its_result(self, monkeypatch):
        _fake_db(monkeypatch, {"dr-1": {"id": "dr-1", "kind": "google"}})
        seen = {}
        monkeypatch.setattr(drive_oauth, "start",
                            lambda kind, did: (seen.update(kind=kind, did=did),
                                               {"url": "U", "pending": "p1"})[1])
        h = _Handler(body={"drive": "dr-1"})
        h._p_drive_oauth_start(_Req())
        assert seen == {"kind": "google", "did": "dr-1"}
        assert h.sent == ({"url": "U", "pending": "p1"}, 200)

    def test_unknown_drive_is_404_before_any_flow(self, monkeypatch):
        _fake_db(monkeypatch)
        def boom(kind, did):
            raise AssertionError("start must not be called for a missing drive")
        monkeypatch.setattr(drive_oauth, "start", boom)
        h = _Handler(body={"drive": "nope"})
        h._p_drive_oauth_start(_Req())
        assert h.sent[1] == 404

    def test_driveerror_is_mapped_to_its_status(self, monkeypatch):
        _fake_db(monkeypatch, {"dr-1": {"id": "dr-1", "kind": "google"}})
        monkeypatch.setattr(drive_oauth, "start",
                            lambda kind, did: (_ for _ in ()).throw(
                                DriveError("no client", 403)))
        h = _Handler(body={"drive": "dr-1"})
        h._p_drive_oauth_start(_Req())
        assert h.sent[1] == 403
        assert "no client" in h.sent[0]["error"]


class TestOAuthStatus:
    def test_forwards_pending_and_returns_status(self, monkeypatch):
        monkeypatch.setattr(drive_oauth, "status",
                            lambda pid: {"pending": pid, "status": "authorized"})
        h = _Handler()
        h._g_drive_oauth_status(_Req(query={"pending": ["p9"]}))
        assert h.sent == ({"pending": "p9", "status": "authorized"}, 200)

    def test_missing_pending_is_400(self, monkeypatch):
        h = _Handler()
        h._g_drive_oauth_status(_Req(query={}))
        assert h.sent[1] == 400

    def test_unknown_pid_maps_its_driveerror(self, monkeypatch):
        monkeypatch.setattr(drive_oauth, "status",
                            lambda pid: (_ for _ in ()).throw(
                                DriveError("Unknown or expired OAuth flow", 404)))
        h = _Handler()
        h._g_drive_oauth_status(_Req(query={"pending": ["gone"]}))
        assert h.sent[1] == 404
