"""Tests for the Integrations catalog (viewer.integrations, pure) and its
routes (viewer.routes.integrations). No Postgres, no network: db helpers and
drive_oauth.start are faked; the catalog functions take plain dicts."""
import pytest

from viewer import db, drive_oauth, integrations as I, server
from viewer.routes.integrations import IntegrationsMixin
from viewer.routes.drives import DrivesMixin

G = "https://www.googleapis.com/auth/"


def _conn(cid="c1", kind="google", **cfg):
    return {"id": cid, "label": cid, "kind": kind, "config": cfg, "status": "active", "hidden": False}


# --- catalog invariants: a bad entry fails here, not on the owner's screen ----

def test_every_service_belongs_to_a_provider_and_ids_are_unique():
    ids = [s["id"] for s in I.SERVICES]
    assert len(ids) == len(set(ids))
    for s in I.SERVICES:
        assert s["provider"] in I.PROVIDERS
        assert s["id"].startswith(s["provider"] + ".")
        assert s["label"]
        assert (s["scopes"] and s["agent"]) or not s["available"]
        assert s["available"] or s.get("unavailable")


def test_every_provider_has_exactly_one_files_service():
    for pid in I.PROVIDERS:
        files = [s for s in I.services_of(pid) if s["kind"] == "files"]
        assert len(files) == 1 and I.FILES_SERVICE[pid] == files[0]["id"]


# --- state ----------------------------------------------------------------

def test_never_connected_needs_a_grant():
    assert I.state(_conn(), "google.drive") == "grant"
    assert I.granted(_conn()) == set()


def test_legacy_row_holds_its_files_scope_only():
    c = _conn(refresh_token="R")
    assert I.state(c, "google.drive") == "on"
    assert I.state(c, "google.gmail") == "grant"


def test_owner_switch_and_unavailable():
    c = _conn(refresh_token="R", scopes=[G + "drive"], off=["google.drive"])
    assert I.state(c, "google.drive") == "off" and not I.usable(c, "google.drive")
    assert I.state(c, "google.keep") == "unavailable"
    on = dict(c, config=I.with_service(c["config"], "google.drive", True))
    assert I.usable(on, "google.drive") and on["config"]["off"] == []


def test_partial_grant_is_not_on():
    c = _conn(refresh_token="R", scopes=[G + "gmail.readonly"])   # compose unticked
    assert I.state(c, "google.gmail") == "grant"


def test_graph_scopes_compare_bare():
    assert I.parse_granted("https://graph.microsoft.com/Files.ReadWrite offline_access", []) == \
        ["Files.ReadWrite", "offline_access"]
    assert I.parse_granted("", ["a", "b"]) == ["a", "b"]    # omitted = granted as requested


def test_consent_keeps_what_is_held_and_adds_the_service():
    c = _conn(refresh_token="R", scopes=[G + "drive"])
    asked = I.consent_scopes(c, "google.calendar").split()
    assert {G + "drive", G + "calendar.readonly", "openid", "email"} == set(asked)
    with pytest.raises(I.IntegrationError) as e:
        I.consent_scopes(c, "google.keep")
    assert e.value.status == 409


# --- which account an agent call uses ----------------------------------------

def test_pick_connection():
    mail = _conn("a", refresh_token="R", scopes=[G + "gmail.readonly", G + "gmail.compose"], account="a@x")
    files = _conn("b", refresh_token="R", scopes=[G + "drive"])
    assert I.pick_connection([mail, files], "google.gmail")["id"] == "a"
    with pytest.raises(I.IntegrationError) as e:
        I.pick_connection([files], "google.gmail")
    assert e.value.status == 403 and "Integrations" in str(e.value)
    two = dict(mail, id="c")
    with pytest.raises(I.IntegrationError) as e:
        I.pick_connection([mail, two], "google.gmail")
    assert e.value.status == 400 and "connection=" in str(e.value)
    assert I.pick_connection([mail, two], "google.gmail", "c")["id"] == "c"
    off = dict(mail, config=I.with_service(mail["config"], "google.gmail", False))
    assert pytest.raises(I.IntegrationError, I.pick_connection, [off], "google.gmail", "a").value.status == 403


def test_view_has_state_and_no_secrets():
    c = _conn(refresh_token="SECRET-RT", access_token="SECRET-AT", scopes=[G + "drive"], account="r@x")
    v = I.view([c, dict(_conn("h"), hidden=True)], {"google": {"client_id": "CID", "client_secret": "SECRET-CS"}}, "https://h/cb")
    g = next(p for p in v["providers"] if p["id"] == "google")
    assert g["client"] == {"client_id": "CID", "has_secret": True, "configured": True}
    assert [x["id"] for x in g["connections"]] == ["c1"]       # hidden rows are not listed
    assert g["connections"][0]["account"] == "r@x"
    assert g["connections"][0]["services"]["google.drive"] == "on"
    assert g["connections"][0]["services"]["google.gmail"] == "grant"
    assert "SECRET" not in str(v)


# --- routes ---------------------------------------------------------------------

class _H(IntegrationsMixin, DrivesMixin):
    def __init__(self, body=None):
        self.sent, self._body = None, body

    def send_json(self, data, status=200):
        self.sent = (data, status)

    def read_body(self):
        return self._body

    def request_origin(self):
        return "https://h.example.test"


class _Req:
    def __init__(self, query=None, human=True):
        self.query = query or {}
        self.principal = {"user": "ram" if human else None}


@pytest.fixture()
def rows(monkeypatch):
    r = {}
    monkeypatch.setattr(db, "drives_load", lambda: r)
    monkeypatch.setattr(db, "drive_get", lambda did: r.get(did))
    monkeypatch.setattr(db, "drive_upsert", lambda did, e: r.__setitem__(did, dict(e, id=did)))
    monkeypatch.setattr(db, "drive_delete", lambda did: r.pop(did, None) is not None)
    monkeypatch.setattr(db, "drive_clients_load", lambda: {})
    return r


def test_connect_new_account_creates_row_and_starts_consent(rows, monkeypatch):
    seen = {}
    monkeypatch.setattr(drive_oauth, "start", lambda did, origin, sid: (
        seen.update(did=did, sid=sid), {"url": "U", "pending": "p"})[1])
    h = _H({"service": "google.gmail"})
    h._p_integrations_connect(_Req())
    data, status = h.sent
    assert status == 200 and data["url"] == "U" and data["connection"] in rows
    assert rows[data["connection"]]["kind"] == "google" and seen["sid"] == "google.gmail"


def test_refused_consent_leaves_no_empty_account(rows, monkeypatch):
    from viewer.drives import DriveError
    monkeypatch.setattr(drive_oauth, "start", lambda *a: (_ for _ in ()).throw(DriveError("No client", 403)))
    h = _H({"service": "google.gmail"})
    h._p_integrations_connect(_Req())
    assert h.sent[1] == 403 and rows == {}


def test_connect_rejects_unavailable_and_agents(rows):
    h = _H({"service": "google.keep"})
    h._p_integrations_connect(_Req())
    assert h.sent[1] == 409 and rows == {}
    h = _H({"service": "google.gmail"})
    h._p_integrations_connect(_Req(human=False))
    assert h.sent[1] == 403


def test_service_toggle(rows):
    rows["c1"] = _conn(refresh_token="R", scopes=[G + "drive"])
    h = _H({"connection": "c1", "service": "google.drive", "on": False})
    h._p_integrations_service(_Req())
    assert h.sent[1] == 200 and rows["c1"]["config"]["off"] == ["google.drive"]
    assert rows["c1"]["config"]["refresh_token"] == "R"           # the grant is untouched
    h = _H({"connection": "c1", "service": "google.gmail", "on": True})
    h._p_integrations_service(_Req())
    assert h.sent[1] == 409                                       # needs consent, not a switch
    h = _H({"connection": "c1", "service": "google.drive", "on": True})
    h._p_integrations_service(_Req(human=False))
    assert h.sent[1] == 403


def test_agent_route_refuses_a_service_that_is_not_on(rows):
    rows["c1"] = _conn(refresh_token="R", scopes=[G + "drive"])
    h = _H()
    h._g_gmail_search(_Req({"q": ["x"]}))
    assert h.sent[1] == 403 and "Gmail" in h.sent[0]["error"]


class TestClients:
    """A provider's OAuth client: Harman's own identity to the vendor. The
    secret is write-only — saved, never returned."""

    @pytest.fixture()
    def store(self, monkeypatch, rows):
        state = {}

        def set_(kind, client_id, client_secret=None):
            prev = state.get(kind) or {}
            secret = prev.get("client_secret") if client_secret is None else client_secret
            state[kind] = dict({"client_id": client_id}, **({"client_secret": secret} if secret else {}))
        monkeypatch.setattr(db, "drive_clients_load", lambda: state)
        monkeypatch.setattr(db, "drive_client_set", set_)
        monkeypatch.setattr(db, "drive_client_delete", lambda k: state.pop(k, None) is not None)
        return state

    def _post(self, method, body, human=True):
        h = _H(body)
        getattr(h, method)(_Req(human=human))
        return h.sent

    def test_save_returns_the_view_without_the_secret(self, store):
        data, status = self._post("_p_integrations_client", {"provider": "google", "client_id": " G-ID ", "client_secret": "G-SECRET"})
        assert status == 200 and store["google"] == {"client_id": "G-ID", "client_secret": "G-SECRET"}
        g = next(p for p in data["providers"] if p["id"] == "google")
        assert g["client"] == {"client_id": "G-ID", "has_secret": True, "configured": True}
        assert data["redirect_uri"] == "https://h.example.test/api/drive/oauth/callback"
        assert "G-SECRET" not in str(data)

    def test_omitted_secret_keeps_it_and_empty_clears_it(self, store):
        store["google"] = {"client_id": "OLD", "client_secret": "S"}
        self._post("_p_integrations_client", {"provider": "google", "client_id": "NEW"})
        assert store["google"] == {"client_id": "NEW", "client_secret": "S"}
        data, _ = self._post("_p_integrations_client", {"provider": "google", "client_id": "NEW", "client_secret": ""})
        assert store["google"] == {"client_id": "NEW"}
        assert next(p for p in data["providers"] if p["id"] == "google")["client"]["configured"] is False

    def test_public_client_needs_no_secret(self, store):
        data, _ = self._post("_p_integrations_client", {"provider": "dropbox", "client_id": "D"})
        assert next(p for p in data["providers"] if p["id"] == "dropbox")["client"]["configured"] is True

    def test_bad_input(self, store):
        assert self._post("_p_integrations_client", {"provider": "icloud", "client_id": "X"})[1] == 404
        assert self._post("_p_integrations_client", {"provider": "google"})[1] == 400
        assert self._post("_p_integrations_client", {"provider": "google", "client_id": "G", "client_secret": 5})[1] == 400
        assert store == {}

    def test_agents_cannot_write(self, store):
        assert self._post("_p_integrations_client", {"provider": "google", "client_id": "G"}, human=False)[1] == 403
        assert self._post("_p_integrations_client_delete", {"provider": "google"}, human=False)[1] == 403
        assert store == {}

    def test_delete(self, store):
        store["google"] = {"client_id": "G"}
        assert self._post("_p_integrations_client_delete", {"provider": "google"})[1] == 200 and store == {}
        assert self._post("_p_integrations_client_delete", {"provider": "google"})[1] == 404


def test_routes_are_registered_and_not_public():
    H = server.SessionViewerHandler
    for path, m in {"/api/integrations": "_g_integrations", "/api/gmail/search": "_g_gmail_search",
                    "/api/gmail/read": "_g_gmail_read", "/api/calendar/events": "_g_calendar_events"}.items():
        assert H.GET_ROUTES[path] == m and path not in H.PUBLIC_API
    for path, m in {"/api/integrations/connect": "_p_integrations_connect",
                    "/api/integrations/service": "_p_integrations_service",
                    "/api/integrations/client": "_p_integrations_client",
                    "/api/integrations/client/delete": "_p_integrations_client_delete",
                    "/api/gmail/draft": "_p_gmail_draft"}.items():
        assert H.POST_ROUTES[path] == m and path not in H.PUBLIC_API
    # Client setup moved here from the drive routes — one home, no twin.
    assert not any(p.startswith("/api/drive/clients") for p in list(H.GET_ROUTES) + list(H.POST_ROUTES))


def test_mcp_tools_map_to_the_routes_and_mail_never_sends():
    from viewer import viewer_mcp
    assert viewer_mcp._TOOLS["gmail_draft"] == ("POST", "/api/gmail/draft")
    assert viewer_mcp._TOOLS["calendar_events"] == ("GET", "/api/calendar/events")
    names = {t["name"] for t in viewer_mcp._TOOL_LIST}
    assert {"integrations_list", "gmail_search", "gmail_read", "gmail_draft", "calendar_events"} <= names
    assert not any("send" in n for n in viewer_mcp._TOOLS if n.startswith("gmail"))
