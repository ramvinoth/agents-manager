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

from viewer import db, drive_oauth, server
from viewer.drives import DriveError
from viewer.routes.drives import DrivesMixin


class _Handler(DrivesMixin):
    def __init__(self, body=None, origin="https://h.example.test"):
        self.sent = None
        self.html = None
        self._body = body
        self._origin = origin

    def send_json(self, data, status=200):
        self.sent = (data, status)

    def send_html(self, html, status=200):
        self.html = (html, status)

    def read_body(self):
        return self._body

    def request_origin(self):
        return self._origin


class _Req:
    def __init__(self, query=None, host="local", human=True):
        self.query = query or {}
        self.host = host
        self.principal = {"user": "ram" if human else None}


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
        assert data["vendors"] == ["dropbox", "google", "onedrive"]

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
        h = _Handler(body={"label": "X", "kind": "icloud"})
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


# --- vendor clients -----------------------------------------------------------

def _fake_clients(monkeypatch, clients=None):
    """In-memory settings['drive_clients'] + the three db helpers over it."""
    state = {"clients": dict(clients or {})}
    monkeypatch.setattr(db, "drive_clients_load", lambda: state["clients"])

    def set_(kind, client_id, client_secret=None):
        prev = state["clients"].get(kind) or {}
        entry = {"client_id": client_id}
        secret = prev.get("client_secret") if client_secret is None else client_secret
        if secret:
            entry["client_secret"] = secret
        state["clients"][kind] = entry
        return entry
    monkeypatch.setattr(db, "drive_client_set", set_)
    monkeypatch.setattr(db, "drive_client_delete",
                        lambda kind: state["clients"].pop(kind, None) is not None)
    return state


class TestClients:
    def test_list_covers_every_vendor_and_never_the_secret(self, monkeypatch):
        _fake_clients(monkeypatch, {
            "google": {"client_id": "G-ID", "client_secret": "G-SECRET"},
            "dropbox": {"client_id": "D-ID"},
        })
        h = _Handler()
        h._g_drive_clients(_Req())
        data, status = h.sent
        assert status == 200
        # The redirect URI is derived from THIS request's origin — the one
        # string the owner must paste into each vendor console.
        assert data["redirect_uri"] == "https://h.example.test/api/drive/oauth/callback"
        by = {c["kind"]: c for c in data["clients"]}
        assert set(by) == {"google", "dropbox", "onedrive"}
        assert by["google"] == {"kind": "google", "label": "Google Drive", "public": False,
                                "client_id": "G-ID", "has_secret": True, "configured": True}
        assert by["dropbox"]["configured"] is True      # public client: id alone is enough
        assert by["onedrive"]["configured"] is False and by["onedrive"]["client_id"] == ""
        assert "G-SECRET" not in str(data)

    def test_confidential_vendor_is_unconfigured_without_secret(self, monkeypatch):
        _fake_clients(monkeypatch, {"google": {"client_id": "G-ID"}})
        h = _Handler()
        h._g_drive_clients(_Req())
        g = [c for c in h.sent[0]["clients"] if c["kind"] == "google"][0]
        assert g["configured"] is False and g["has_secret"] is False

    def test_save_stores_id_and_secret(self, monkeypatch):
        state = _fake_clients(monkeypatch)
        h = _Handler(body={"kind": "google", "client_id": " G-ID ", "client_secret": "S"})
        h._p_drive_clients(_Req())
        assert h.sent[1] == 200
        assert state["clients"]["google"] == {"client_id": "G-ID", "client_secret": "S"}

    def test_save_without_secret_keeps_the_stored_one(self, monkeypatch):
        state = _fake_clients(monkeypatch, {"google": {"client_id": "OLD", "client_secret": "S"}})
        h = _Handler(body={"kind": "google", "client_id": "NEW"})
        h._p_drive_clients(_Req())
        assert state["clients"]["google"] == {"client_id": "NEW", "client_secret": "S"}

    def test_empty_secret_clears_it(self, monkeypatch):
        state = _fake_clients(monkeypatch, {"google": {"client_id": "G", "client_secret": "S"}})
        h = _Handler(body={"kind": "google", "client_id": "G", "client_secret": ""})
        h._p_drive_clients(_Req())
        assert state["clients"]["google"] == {"client_id": "G"}

    def test_agent_principal_cannot_write(self, monkeypatch):
        state = _fake_clients(monkeypatch)
        h = _Handler(body={"kind": "google", "client_id": "G", "client_secret": "S"})
        h._p_drive_clients(_Req(human=False))
        assert h.sent[1] == 403
        assert state["clients"] == {}
        h = _Handler(body={"kind": "google"})
        h._p_drive_clients_delete(_Req(human=False))
        assert h.sent[1] == 403

    def test_unknown_vendor_is_404_and_missing_id_is_400(self, monkeypatch):
        _fake_clients(monkeypatch)
        h = _Handler(body={"kind": "icloud", "client_id": "X"})
        h._p_drive_clients(_Req())
        assert h.sent[1] == 404
        h = _Handler(body={"kind": "google"})
        h._p_drive_clients(_Req())
        assert h.sent[1] == 400

    def test_delete_forgets_the_client(self, monkeypatch):
        state = _fake_clients(monkeypatch, {"google": {"client_id": "G"}})
        h = _Handler(body={"kind": "google"})
        h._p_drive_clients_delete(_Req())
        assert h.sent[1] == 200 and "google" not in state["clients"]
        h = _Handler(body={"kind": "google"})
        h._p_drive_clients_delete(_Req())
        assert h.sent[1] == 404


# --- consent flow ------------------------------------------------------------

class TestOAuthStart:
    def test_forwards_to_drive_oauth_and_returns_its_result(self, monkeypatch):
        _fake_db(monkeypatch, {"dr-1": {"id": "dr-1", "kind": "google"}})
        seen = {}
        monkeypatch.setattr(drive_oauth, "start",
                            lambda kind, did, origin: (seen.update(kind=kind, did=did, origin=origin),
                                                       {"url": "U", "pending": "p1"})[1])
        h = _Handler(body={"drive": "dr-1"})
        h._p_drive_oauth_start(_Req())
        # The flow is started for the origin THIS request arrived on — that is
        # where the vendor must send the browser back.
        assert seen == {"kind": "google", "did": "dr-1", "origin": "https://h.example.test"}
        assert h.sent == ({"url": "U", "pending": "p1"}, 200)

    def test_unknown_drive_is_404_before_any_flow(self, monkeypatch):
        _fake_db(monkeypatch)
        def boom(kind, did, origin):
            raise AssertionError("start must not be called for a missing drive")
        monkeypatch.setattr(drive_oauth, "start", boom)
        h = _Handler(body={"drive": "nope"})
        h._p_drive_oauth_start(_Req())
        assert h.sent[1] == 404

    def test_driveerror_is_mapped_to_its_status(self, monkeypatch):
        _fake_db(monkeypatch, {"dr-1": {"id": "dr-1", "kind": "google"}})
        monkeypatch.setattr(drive_oauth, "start",
                            lambda kind, did, origin: (_ for _ in ()).throw(
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


class TestOAuthCallback:
    def test_hands_the_parsed_query_over_and_answers_html(self, monkeypatch):
        seen = {}
        monkeypatch.setattr(drive_oauth, "callback",
                            lambda q: (seen.update(q), "<html>done</html>")[1])
        h = _Handler()
        h._g_drive_oauth_callback(_Req(query={"code": ["C"], "state": ["S"]}))
        assert seen == {"code": ["C"], "state": ["S"]}
        assert h.html == ("<html>done</html>", 200)
        assert h.sent is None   # a browser landed here, never JSON


# --- request_origin: the one source of truth for "where do vendors call us back" --

class _OriginHandler:
    """Bare headers + the real request_origin, unbound from the socket."""
    request_origin = server.SessionViewerHandler.request_origin

    def __init__(self, **headers):
        self.headers = headers


@pytest.mark.parametrize("headers, origin", [
    # Through the Cloudflare tunnel: the browser's Host arrives with the
    # scheme it used.
    ({"Host": "life.suhai.ai", "X-Forwarded-Proto": "https"}, "https://life.suhai.ai"),
    # A proxy that rewrites Host but forwards the original.
    ({"Host": "127.0.0.1:8091", "X-Forwarded-Host": "life.suhai.ai",
      "X-Forwarded-Proto": "https"}, "https://life.suhai.ai"),
    # Dev box, no proxy: loopback is plain http, port preserved.
    ({"Host": "localhost:8091"}, "http://localhost:8091"),
    ({"Host": "127.0.0.1:9999"}, "http://127.0.0.1:9999"),
    # A public hostname with no proto header is never assumed to be plain
    # http — a vendor would refuse an http redirect URI anyway.
    ({"Host": "life.suhai.ai"}, "https://life.suhai.ai"),
    # A proxy chain lists several protos; the first is the client's.
    ({"Host": "h.example.test", "X-Forwarded-Proto": "https, http"}, "https://h.example.test"),
])
def test_request_origin_is_what_the_browser_used(headers, origin):
    assert _OriginHandler(**headers).request_origin() == origin


def test_oauth_callback_is_reachable_without_a_session():
    """The vendor's redirect is a cross-site top-level navigation: the
    SameSite=Strict session cookie does not travel with it, so the callback
    must be public — gated only by the one-time state inside drive_oauth."""
    assert "/api/drive/oauth/callback" in server.SessionViewerHandler.PUBLIC_API
    assert server.SessionViewerHandler.GET_ROUTES["/api/drive/oauth/callback"] == "_g_drive_oauth_callback"


def test_vendor_client_routes_are_gated_not_public():
    """The client store is credentials: readable only with a session, and the
    writes additionally demand a human principal (checked in the handler)."""
    H = server.SessionViewerHandler
    assert H.GET_ROUTES["/api/drive/clients"] == "_g_drive_clients"
    assert H.POST_ROUTES["/api/drive/clients"] == "_p_drive_clients"
    assert H.POST_ROUTES["/api/drive/clients/delete"] == "_p_drive_clients_delete"
    assert not any(p.startswith("/api/drive/clients") for p in H.PUBLIC_API)
