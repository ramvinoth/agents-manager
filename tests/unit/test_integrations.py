"""Tests for the Integrations catalog (viewer.integrations, pure) and its
routes (viewer.routes.integrations). No Postgres, no network: db helpers and
drive_oauth.start are faked; the catalog functions take plain dicts."""
import json

import pytest

from viewer import cloudauth, db, drive_oauth, integrations as I, server
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
        assert (s["scopes"] and s["agent"] and s["try"]) or not s["available"]
        assert s["available"] or s.get("unavailable")


def test_every_oauth_provider_has_exactly_one_files_service():
    for pid in (p for p, v in I.PROVIDERS.items() if v["via"] == "oauth"):
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


def test_view_has_a_setup_checklist_with_the_redirect_step():
    for p in I.view([], {}, "https://h/cb")["providers"]:
        assert p["setup"] and sum(st["redirect"] for st in p["setup"]) == (p["auth"] == "oauth"), p["id"]
        assert all(l["url"].startswith("https://") for st in p["setup"] for l in st["links"])


def test_view_flags_an_expired_sign_in():
    c = _conn(scopes=[G + "drive"], expired=1)
    g = I.view([c], {}, "")["providers"][0]
    assert g["connections"][0]["expired"] is True


def test_agent_view_lists_what_agents_may_do_and_what_is_missing():
    c = _conn(scopes=[G + "drive", G + "gmail.readonly", G + "gmail.compose"], account="r@x", expired=1)
    av = I.agent_view([c, dict(_conn("h"), hidden=True)], I.local_rules(None))
    by = {e["service"]: e for e in av["services"]}
    assert set(by) == {"google.drive", "google.gmail"}
    assert by["google.drive"]["may"] == ["read", "write"] and by["google.drive"]["ask_owner"] == ["delete"]
    assert by["google.drive"]["drive"] == "c1" and "expired" in by["google.gmail"]
    assert "Google Calendar" in av["not_connected"] and "Google Keep" not in av["not_connected"]
    text = I.agent_summary(av)
    assert "Gmail (r@x): may read, draft" in text and "SIGN-IN EXPIRED" in text
    assert "drive=c1" in text and "Not connected" in text and "SECRET" not in text


def test_agents_get_the_agent_view_humans_the_page(rows):
    rows["c1"] = _conn(scopes=[G + "drive"], refresh_token="SECRET-RT")
    h = _H()
    h._g_integrations(_Req(human=False))
    assert set(h.sent[0]) == {"services", "not_connected", "this_machine"} and "SECRET" not in str(h.sent)
    h._g_integrations(_Req())
    assert "providers" in h.sent[0]


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

    def _org_send(self, req, action, args):
        # The real one executes under the caller's authority; here, record it.
        self.queued = (action, args)


class _Req:
    def __init__(self, query=None, human=True):
        self.query = query or {}
        self.principal = {"kind": "user", "user": "ram"} if human else {"kind": "mcp", "user": None}


class _Rows(dict):
    """The drives table, plus the settings store beside it (r.settings)."""


@pytest.fixture()
def rows(monkeypatch):
    r = _Rows()
    monkeypatch.setattr(db, "drives_load", lambda: r)
    monkeypatch.setattr(db, "drive_get", lambda did: r.get(did))
    monkeypatch.setattr(db, "drive_upsert", lambda did, e: r.__setitem__(did, dict(e, id=did)))
    monkeypatch.setattr(db, "drive_delete", lambda did: r.pop(did, None) is not None)
    monkeypatch.setattr(db, "drive_clients_load", lambda: {})
    settings = {}
    monkeypatch.setattr(db, "setting_get", lambda k, d=None: settings.get(k, d))
    monkeypatch.setattr(db, "setting_set", settings.__setitem__)
    r.settings = settings
    return r


def test_connect_new_account_creates_row_and_starts_consent(rows, monkeypatch):
    seen = {}
    monkeypatch.setattr(drive_oauth, "start", lambda did, origin, sid, op=None: (
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


# --- operations: what agents may do, per account (the owner's switches) --------

CAL = G + "calendar.readonly"
CAL_W = G + "calendar.events"


def test_every_op_has_a_label_and_known_shape():
    for s in I.SERVICES:
        for op, spec in s["ops"].items():
            assert op in I.OP_LABELS and isinstance(spec["default"], bool)
            assert set(spec["scopes"]) >= set() and all(isinstance(x, str) for x in spec["scopes"])


def test_op_state_defaults_choices_and_grants():
    c = _conn(refresh_token="R", scopes=[CAL])
    assert I.op_state(c, "google.calendar", "read") == "on"
    assert I.op_state(c, "google.calendar", "create") == "grant"      # write scope never granted
    c = _conn(refresh_token="R", scopes=[CAL, CAL_W])
    assert I.op_state(c, "google.calendar", "create") == "on"         # default on once granted
    assert I.op_state(c, "google.calendar", "delete") == "off"        # default off
    c["config"] = I.with_op(c["config"], "google.calendar", "delete", True)
    assert I.op_state(c, "google.calendar", "delete") == "on"
    c["config"] = I.with_service(c["config"], "google.calendar", False)
    assert I.op_state(c, "google.calendar", "read") == "off"          # service off wins
    with pytest.raises(I.IntegrationError) as e:
        I.op_spec("google.calendar", "send")
    assert e.value.status == 400


def test_with_op_does_not_mutate_the_stored_config():
    cfg = {"refresh_token": "R", "ops": {"google.drive": {"write": True}}}
    out = I.with_op(cfg, "google.drive", "write", False)
    assert cfg["ops"]["google.drive"]["write"] is True and out["ops"]["google.drive"]["write"] is False


def test_consent_for_an_op_adds_its_scopes_and_keeps_held_ones():
    c = _conn(refresh_token="R", scopes=[G + "drive", CAL])
    s = I.consent_scopes(c, "google.calendar", "create").split()
    assert CAL_W in s and G + "drive" in s


def test_pick_connection_refuses_an_agent_op_the_owner_has_not_allowed():
    c = _conn(refresh_token="R", scopes=[CAL, CAL_W])
    assert I.pick_connection([c], "google.calendar", op="create") is c
    with pytest.raises(I.IntegrationError) as e:
        I.pick_connection([c], "google.calendar", op="delete")
    assert e.value.status == 403 and "allows it in Integrations" in str(e.value)
    c = _conn(refresh_token="R", scopes=[CAL])
    with pytest.raises(I.IntegrationError) as e:
        I.pick_connection([c], "google.calendar", op="update")
    assert "grants it" in str(e.value)


def test_view_lists_ops_and_root():
    c = _conn(refresh_token="R", scopes=[G + "drive"], root="/Work")
    v = I.view([c], {}, "https://h/cb")
    g = next(p for p in v["providers"] if p["id"] == "google")
    drive = next(s for s in g["services"] if s["id"] == "google.drive")
    assert [o["id"] for o in drive["ops"]] == ["read", "write", "delete"]
    conn = g["connections"][0]
    assert conn["root"] == "/Work" and conn["ops"]["google.drive"] == {"read": "on", "write": "on", "delete": "off"}


# --- local disk ------------------------------------------------------------------

def test_local_rules_defaults_and_validation():
    assert I.local_rules(None) == {"roots": ["~"], "ops": ["read", "write"]}
    assert I.local_set(["~/Work", "/tmp", "~/Work"], ["delete", "read"]) == {"roots": ["~/Work", "/tmp"], "ops": ["read", "delete"]}
    for roots, ops in ((["Work"], []), (["~x"], []), ([], ["chmod"]), ("~", [])):
        with pytest.raises(I.IntegrationError):
            I.local_set(roots, ops)


def test_local_allows_is_containment_not_prefix():
    rules = {"roots": ["~/Work"], "ops": ["read"]}
    exp = lambda r: r.replace("~", "/home/o")
    assert I.local_allows(rules, "/home/o/Work", "read", exp)
    assert I.local_allows(rules, "/home/o/Work/a/b.txt", "read", exp)
    assert not I.local_allows(rules, "/home/o/Workshop/x", "read", exp)   # sibling with a shared prefix
    assert not I.local_allows(rules, "/home/o/Work/a", "write", exp)
    assert not I.local_allows({"roots": [], "ops": ["read"]}, "/home/o", "read", exp)


def test_local_route_saves_rules_and_agents_cannot(rows):
    h = _H({"roots": ["~/Work"], "ops": ["read"]})
    h._p_integrations_local(_Req())
    assert h.sent[1] == 200 and rows.settings["local_disk"] == {"roots": ["~/Work"], "ops": ["read"]}
    assert h.sent[0]["local"]["roots"] == ["~/Work"]
    h = _H({"roots": ["rel"], "ops": []})
    h._p_integrations_local(_Req())
    assert h.sent[1] == 400
    h = _H({"roots": ["/"], "ops": ["delete"]})
    h._p_integrations_local(_Req(human=False))
    assert h.sent[1] == 403 and rows.settings["local_disk"]["roots"] == ["~/Work"]


def test_fs_gate_holds_agents_to_the_local_rules(rows, tmp_path):
    from viewer.routes import fs
    (tmp_path / "ok").mkdir()
    rows.settings["local_disk"] = {"roots": [str(tmp_path / "ok")], "ops": ["read"]}
    agent, human = _Req(human=False), _Req()
    assert fs._agent_refusal(agent, "local", "local", str(tmp_path / "ok" / "f"), "read") is None
    assert "Local disk" in fs._agent_refusal(agent, "local", "local", str(tmp_path / "ok" / "f"), "write")
    assert fs._agent_refusal(agent, "local", "local", str(tmp_path / "ok" / ".." / "x"), "read")   # .. resolved away
    assert fs._agent_refusal(human, "local", "local", "/etc", "delete") is None
    assert fs._agent_refusal(agent, "ssh", "box", "/etc", "delete") is None


def test_fs_gate_holds_agents_to_the_drive_ops(rows):
    from viewer.routes import fs
    rows["c1"] = _conn(refresh_token="R", scopes=[G + "drive"])
    agent = _Req(human=False)
    assert fs._agent_refusal(agent, "drive", "c1", "/a", "write") is None
    assert "on this drive" in fs._agent_refusal(agent, "drive", "c1", "/a", "delete")
    assert fs._agent_refusal(agent, "drive", "nope", "/a", "delete") is None   # adapter_for answers 404


# --- per-account op and folder routes --------------------------------------------

def test_op_route(rows):
    rows["c1"] = _conn(refresh_token="R", scopes=[CAL])
    h = _H({"connection": "c1", "service": "google.calendar", "op": "create", "on": True})
    h._p_integrations_op(_Req())
    assert h.sent[1] == 409                                       # needs a grant, not a switch
    rows["c1"] = _conn(refresh_token="R", scopes=[CAL, CAL_W])
    h._p_integrations_op(_Req())
    assert h.sent[1] == 200 and rows["c1"]["config"]["ops"]["google.calendar"]["create"] is True
    for body, status in (({"connection": "zz", "service": "google.calendar", "op": "read"}, 404),
                         ({"connection": "c1", "service": "dropbox.files", "op": "read"}, 400),
                         ({"connection": "c1", "service": "google.calendar", "op": "send"}, 400)):
        h = _H(body)
        h._p_integrations_op(_Req())
        assert h.sent[1] == status
    h = _H({"connection": "c1", "service": "google.calendar", "op": "delete", "on": True})
    h._p_integrations_op(_Req(human=False))
    assert h.sent[1] == 403


def test_root_route_checks_the_folder_before_saving(rows, monkeypatch):
    from viewer import drives
    from viewer.drives import DriveError
    rows["c1"] = _conn(refresh_token="R", scopes=[G + "drive"])

    def fs_list(self, path, hidden=False):
        if path != "/Work":
            raise DriveError("Not found", 404)
        return {"entries": []}
    monkeypatch.setattr(drives.GoogleDrive, "fs_list", fs_list)
    h = _H({"connection": "c1", "root": "Work/"})
    h._p_integrations_root(_Req())
    assert h.sent[1] == 200 and rows["c1"]["config"]["root"] == "/Work"
    h = _H({"connection": "c1", "root": "/Missing"})
    h._p_integrations_root(_Req())
    assert h.sent[1] == 404 and rows["c1"]["config"]["root"] == "/Work"
    h = _H({"connection": "c1", "root": "/"})
    h._p_integrations_root(_Req())
    assert "root" not in rows["c1"]["config"]
    h._p_integrations_root(_Req(human=False))
    assert h.sent[1] == 403


# --- calendar writes ---------------------------------------------------------------

def test_event_body_sends_only_what_was_given():
    from viewer import workspace as W
    assert W.event_body({"title": "T"}) == {"summary": "T"}
    b = W.event_body({"start": "2026-10-06", "end": "2026-10-07", "all_day": True, "attendees": ["a@x", ""]})
    assert b == {"start": {"date": "2026-10-06"}, "end": {"date": "2026-10-07"}, "attendees": [{"email": "a@x"}]}
    assert W.event_body({"start": "2026-10-06T09:00:00"})["start"] == {"dateTime": "2026-10-06T09:00:00+00:00"}
    with pytest.raises(Exception):
        W.event_body({"start": "next tuesday"})


def test_calendar_writes_are_gated_per_op_and_never_notify_guests(rows, monkeypatch):
    from viewer import workspace as W
    calls = []
    monkeypatch.setattr(W.Calendar, "_json", lambda self, m, url, body=None: (
        calls.append((m, url, body)), {"id": "e1", "summary": (body or {}).get("summary", "")})[1])
    rows["c1"] = _conn(refresh_token="R", scopes=[CAL, CAL_W])
    h = _H({"title": "Dentist", "start": "2026-10-06T09:00:00-07:00", "end": "2026-10-06T10:00:00-07:00"})
    h._p_calendar_create(_Req(human=False))
    assert h.sent[1] == 200 and h.sent[0]["title"] == "Dentist"
    assert calls[-1][0] == "POST" and calls[-1][1].endswith("/calendars/primary/events?sendUpdates=none")
    h = _H({"id": "e/1", "title": "Moved"})
    h._p_calendar_update(_Req(human=False))
    assert calls[-1][0] == "PATCH" and "/events/e%2F1?sendUpdates=none" in calls[-1][1]
    n = len(calls)
    h = _H({"id": "e1"})
    h._p_calendar_delete(_Req(human=False))
    assert h.sent[1] == 403 and len(calls) == n                   # delete is off by default for agents
    h._p_calendar_delete(_Req())                                  # the owner, in the app
    assert h.sent == ({"deleted": "e1"}, 200) and calls[-1][0] == "DELETE"
    rows["c1"] = _conn(refresh_token="R", scopes=[CAL])
    h = _H({"title": "X", "start": "2026-10-06", "end": "2026-10-07", "all_day": True})
    h._p_calendar_create(_Req())
    assert h.sent[1] == 403 and "grant" in h.sent[0]["error"]     # even the owner needs the write grant


def test_phase3_routes_and_mcp_tools():
    from viewer import viewer_mcp
    H = server.SessionViewerHandler
    for path, m in {"/api/integrations/op": "_p_integrations_op", "/api/integrations/root": "_p_integrations_root",
                    "/api/integrations/local": "_p_integrations_local", "/api/calendar/create": "_p_calendar_create",
                    "/api/calendar/update": "_p_calendar_update", "/api/calendar/delete": "_p_calendar_delete"}.items():
        assert H.POST_ROUTES[path] == m and path not in H.PUBLIC_API
    names = {t["name"] for t in viewer_mcp._TOOL_LIST}
    for op in ("create", "update", "delete"):
        assert viewer_mcp._TOOLS["calendar_" + op] == ("POST", "/api/calendar/" + op)
        assert "calendar_" + op in names


# --- API-token providers (Cloudflare, Hetzner…) -----------------------------

def test_token_catalog_shape():
    cats = {c for c, _ in I.CATEGORIES}
    for pid, p in I.PROVIDERS.items():
        assert p["via"] in ("oauth", "token") and p["category"] in cats
        if p["via"] == "token" and any(s["available"] for s in I.services_of(pid)):
            assert p["base"].startswith("https://") and p["verify"].startswith("/") and p["docs"]
            assert I.services_of(pid)[0]["ops"]["change"]["default"] is False   # changes can spend money
    assert "cloudflare" in I.PROVIDERS and "hetzner" in I.PROVIDERS and "tailscale" in I.PROVIDERS
    assert I.services_of("aws")[0]["available"] and not I.services_of("oracle")[0]["available"]
    assert "cloudflare" not in drive_oauth.available_vendors() and "google" in drive_oauth.available_vendors()


def _signed(pid, tok, fields):
    """The probe as it leaves: verify_request's request plus cloudauth's credential."""
    m, url, h, data, f = I.verify_request(pid, tok, fields)
    return m, url, cloudauth.authorize(I.provider(pid), tok.strip(), f, m, url, h, data, None), data, f


def test_verify_request_builds_each_auth_style():
    m, url, h, data, _ = I.verify_request("cloudflare", " T ", {})
    assert "Authorization" not in h            # the credential is cloudauth's, added last
    m, url, h, data, _ = _signed("cloudflare", " T ", {})
    assert (m, url, h["Authorization"], data) == ("GET", "https://api.cloudflare.com/client/v4/user/tokens/verify", "Bearer T", None)
    assert _signed("discord", "B", {})[2]["Authorization"] == "Bot B"
    assert _signed("discord", "B", {})[2]["User-Agent"].startswith("DiscordBot (")
    assert _signed("mixpanel", "s", {"username": "u"})[2]["Authorization"] == "Basic dTpz"
    m, url, h, data, f = I.verify_request("odoo", "k", {"host": "https://Acme.odoo.com/", "db": "prod"})
    assert (m, url, data, h["X-Odoo-Database"]) == ("POST", "https://acme.odoo.com/json/2/res.users/context_get", b"{}", "prod")
    for pid, tok, fields, status in (("mixpanel", "s", {}, 400), ("odoo", "k", {"host": "a/b"}, 400),
                                     ("cloudflare", "", {}, 400), ("oracle", "x", {}, 409), ("google", "x", {}, 400),
                                     ("github", "k", {"app_id": "1"}, 400), ("gcp", "{}", {}, 400),
                                     ("azure", "s", {"tenant": "t", "client_id": "c"}, 400)):
        with pytest.raises(I.IntegrationError) as e:
            I.verify_request(pid, tok, fields)
        assert e.value.status == status


def test_cloud_probes_go_where_each_vendor_answers():
    m, url, h, data, f = I.verify_request("aws", "S", {"access_key_id": "AKIA1"})
    assert (m, url, f["region"]) == ("GET", "https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15", "us-east-1")
    h = _signed("aws", "S", {"access_key_id": "AKIA1", "region": "eu-west-1"})[2]
    assert h["Authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIA1/") and "/eu-west-1/sts/" in h["Authorization"]
    m, url, h, data, f = I.verify_request("railway", "T", {})
    assert (m, url, json.loads(data)) == ("POST", "https://backboard.railway.com/graphql/v2", {"query": "query { me { name email } }"})
    assert h["Content-Type"] == "application/json"
    m, url, h, data, f = I.verify_request("github", "k", {"app_id": "1", "installation_id": "2"})
    assert url == "https://api.github.com/installation/repositories" and h["X-GitHub-Api-Version"] == "2022-11-28"
    m, url, h, data, f = I.verify_request("azure", "s", {"tenant": "t", "client_id": "c", "subscription": "S1"})
    assert url == "https://management.azure.com/subscriptions/S1?api-version=2022-12-01"
    key = json.dumps({"type": "service_account", "private_key": "k", "client_email": "a@p.iam", "project_id": "p-1"})
    m, url, h, data, f = I.verify_request("gcp", key, {})
    assert url == "https://cloudresourcemanager.googleapis.com/v1/projects/p-1" and f["project"] == "p-1"
    assert I.verify_request("gcp", key, {"project": "other"})[1].endswith("/projects/other")


def test_cloud_replies_name_the_account_or_refuse_it():
    assert I.account_from("github", {"repositories": [{"owner": {"login": "acme"}}]}, {}) == "acme"
    assert I.account_from("github", {"repositories": []}, {"name": "Work"}) == "Work"
    xml = "<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::1:user/h</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>"
    assert I.account_from("aws", xml, {}) == "arn:aws:iam::1:user/h"
    assert I.account_from("railway", {"data": {"me": {"email": "a@x"}}}, {}) == "a@x"
    assert I.verify_problem("aws", xml) == ""
    assert "root" in I.verify_problem("aws", xml.replace("user/h", "root"))
    assert "Not Authorized" in I.verify_problem("railway", {"errors": [{"message": "Not Authorized"}], "data": None})
    assert I.verify_problem("railway", {"data": {"me": {}}}) == ""


def test_cloud_calls_route_by_service_and_split_read_from_change():
    aws = _conn(kind="aws", **I.token_config("aws", "S", "", {"access_key_id": "A", "region": "us-west-2"}))
    op, m, url, h, data = I.api_request(aws, "GET", "/ec2/?Action=DescribeInstances&Version=2016-11-15")
    assert (op, url) == ("read", "https://ec2.us-west-2.amazonaws.com/?Action=DescribeInstances&Version=2016-11-15")
    assert I.api_request(aws, "GET", "/ec2/?Action=RunInstances&ImageId=x")[0] == "change"   # AWS mutates over GET
    assert I.api_request(aws, "GET", "/iam/?Action=ListUsers&Version=2010-05-08")[2].startswith("https://iam.amazonaws.com/")
    assert I.api_request(aws, "GET", "/s3/")[0:3] == ("read", "GET", "https://s3.us-west-2.amazonaws.com/")
    op, m, url, h, data = I.api_request(aws, "GET", "/logs/?X-Amz-Target=Logs_20140328.DescribeLogGroups")
    assert (op, m, url, h["X-Amz-Target"], data) == ("read", "POST", "https://logs.us-west-2.amazonaws.com/",
                                                     "Logs_20140328.DescribeLogGroups", b"{}")
    assert h["Content-Type"] == "application/x-amz-json-1.1"
    assert I.api_request(aws, "POST", "/logs/?X-Amz-Target=Logs_20140328.DeleteLogGroup", {"logGroupName": "g"})[0] == "change"
    with pytest.raises(I.IntegrationError):
        I.api_request(aws, "GET", "/EC2.evil/")
    gcp = _conn(kind="gcp", **I.token_config("gcp", "{}", "", {"project": "p"}))
    assert I.api_request(gcp, "GET", "/compute/v1/projects/p/aggregated/instances")[2] == \
        "https://compute.googleapis.com/v1/projects/p/aggregated/instances"
    assert I.api_op("railway", "POST", "/v2", {"query": "query { projects { edges { node { id } } } }"}) == "read"
    assert I.api_op("railway", "POST", "/v2", {"query": "# hi\n mutation { serviceDelete(id: 1) }"}) == "change"
    assert I.api_op("railway", "POST", "/v2", {"query": "{ me { id } }"}) == "read"
    assert I.api_op("github", "POST", "/repos/a/b/issues") == "change"


def test_api_request_is_pinned_to_the_vendor_and_split_into_read_and_change():
    c = _conn(kind="hetzner", api_token="T", scopes=["hetzner.api"])
    op, m, url, h, data = I.api_request(c, "get", "/servers?per_page=5")
    assert (op, m, url, "Authorization" in h) == ("read", "GET", "https://api.hetzner.cloud/v1/servers?per_page=5", False)
    assert I.api_request(c, "POST", "/servers", {"name": "x"})[0] == "change"
    assert I.api_request(c, "POST", "/servers", {"name": "x"})[4] == b'{"name": "x"}'
    assert I.api_request(c, "GET", "//evil.example/x")[2].startswith("https://api.hetzner.cloud/v1/")
    for bad in ("servers", "/a/../b", "https://evil.example/", "/a b", "/a#x"):
        with pytest.raises(I.IntegrationError):
            I.api_request(c, "GET", bad)
    with pytest.raises(I.IntegrationError):
        I.api_request(c, "TRACE", "/servers")
    assert I.api_op("odoo", "POST", "/res.partner/search_read") == "read"
    assert I.api_op("odoo", "POST", "/res.partner/create") == "change"


def test_token_row_state_and_agent_ops():
    c = _conn(kind="cloudflare", **I.token_config("cloudflare", "T", "me@x", {}))
    assert I.state(c, "cloudflare.api") == "on"
    assert I.op_state(c, "cloudflare.api", "read") == "on" and I.op_state(c, "cloudflare.api", "change") == "off"
    assert "access_token" not in c["config"] and "refresh_token" not in c["config"]
    av = I.agent_view([c], I.local_rules(None))
    e = av["services"][0]
    assert e["tools"].startswith("api_call") and e["may"] == ["read"] and e["docs"]
    assert "connection=" + c["id"] in I.agent_summary(av)


class _FakeHTTP:
    def __init__(self, status=200, body=b"{}"):
        self.status, self.body, self.calls = status, body, []

    def __call__(self, method, url, headers=None, data=None, timeout=60):
        self.calls.append((method, url, headers, data))
        return self.status, {}, self.body


def test_token_connect_probes_before_saving_and_never_echoes_the_token(rows, monkeypatch):
    from viewer import drives
    fake = _FakeHTTP(body=b'{"account": {"email": "ops@x.test"}}')
    monkeypatch.setattr(drives, "_http", fake)
    h = _H({"provider": "digitalocean", "token": "dop_v1_SECRET", "fields": {"name": "Prod"}})
    h._p_integrations_token(_Req())
    data, status = h.sent
    assert status == 200 and len(rows) == 1
    row = next(iter(rows.values()))
    assert row["kind"] == "digitalocean" and row["config"]["api_token"] == "dop_v1_SECRET"
    assert row["config"]["account"] == "Prod (ops@x.test)"
    assert "SECRET" not in repr(data)
    do = next(p for p in data["providers"] if p["id"] == "digitalocean")
    assert do["auth"] == "token" and do["client"]["configured"] and do["connections"][0]["services"] == {"digitalocean.api": "on"}
    assert fake.calls[0][2]["Authorization"] == "Bearer dop_v1_SECRET"
    from viewer.routes.drives import _public_view
    assert _public_view(row)["authorized"] and "SECRET" not in repr(_public_view(row))


def test_token_connect_refused_saves_nothing(rows, monkeypatch):
    from viewer import drives
    monkeypatch.setattr(drives, "_http", _FakeHTTP(status=401))
    h = _H({"provider": "cloudflare", "token": "bad"})
    h._p_integrations_token(_Req())
    assert h.sent[1] == 400 and "refused" in h.sent[0]["error"] and rows == {}
    h = _H({"provider": "cloudflare", "token": "x"})
    h._p_integrations_token(_Req(human=False))
    assert h.sent[1] == 403 and rows == {}
    h = _H({"service": "cloudflare.api"})
    h._p_integrations_connect(_Req())          # no OAuth consent for a token provider
    assert h.sent[1] == 400 and rows == {}


def test_api_proxy_checks_the_owners_switch(rows, monkeypatch):
    from viewer import drives
    fake = _FakeHTTP(body=b'{"servers": []}')
    monkeypatch.setattr(drives, "_http", fake)
    rows["c1"] = _conn(kind="hetzner", **I.token_config("hetzner", "T", "", {}))
    h = _H({"connection": "c1", "path": "/servers"})
    h._p_integrations_api(_Req(human=False))
    assert h.sent == ({"status": 200, "body": {"servers": []}}, 200)
    h = _H({"connection": "c1", "method": "POST", "path": "/servers", "body": {"name": "x"}, "reason": "r"})
    h._p_integrations_api(_Req(human=False))
    # change is off by default for agents: not run, queued as a one-time approval
    assert h.sent is None and len(fake.calls) == 1
    assert h.queued == ("integration_api_call", {"connection": "c1", "method": "POST", "path": "/servers",
                                                 "body": {"name": "x"}, "reason": "r"})
    rows["c1"] = dict(rows["c1"], config=I.with_op(rows["c1"]["config"], "hetzner.api", "change", True))
    h._p_integrations_api(_Req(human=False))
    assert h.sent[1] == 200 and fake.calls[-1][0] == "POST"
    rows["c1"] = dict(rows["c1"], config=I.with_service(rows["c1"]["config"], "hetzner.api", False))
    h = _H({"connection": "c1", "path": "/servers"})
    h._p_integrations_api(_Req(human=False))
    assert h.sent[1] == 403


def test_token_routes_registered():
    from viewer import viewer_mcp
    H = server.SessionViewerHandler
    for path, m in {"/api/integrations/token": "_p_integrations_token", "/api/integrations/api": "_p_integrations_api"}.items():
        assert H.POST_ROUTES[path] == m and path not in H.PUBLIC_API
    assert viewer_mcp._TOOLS["api_call"] == ("POST", "/api/integrations/api")
    assert "api_call" in {t["name"] for t in viewer_mcp._TOOL_LIST}


def test_a_refused_token_marks_the_account_and_a_new_token_keeps_the_switches(rows, monkeypatch):
    from viewer import drives
    rows["c1"] = _conn(kind="tailscale", **I.token_config("tailscale", "OLD", "me", {}))
    rows["c1"]["config"] = I.with_op(rows["c1"]["config"], "tailscale.api", "change", True)
    monkeypatch.setattr(drives, "_http", _FakeHTTP(status=401))
    h = _H({"connection": "c1", "path": "/tailnet/-/devices"})
    h._p_integrations_api(_Req(human=False))
    assert h.sent[0]["status"] == 401 and I.expired(rows["c1"])
    monkeypatch.setattr(drives, "_http", _FakeHTTP())
    h = _H({"provider": "tailscale", "token": "NEW", "connection": "c1"})
    h._p_integrations_token(_Req())
    assert h.sent[1] == 200 and list(rows) == ["c1"]
    cfg = rows["c1"]["config"]
    assert cfg["api_token"] == "NEW" and not I.expired(rows["c1"]) and cfg["ops"]["tailscale.api"]["change"] is True
    h = _H({"provider": "cloudflare", "token": "X", "connection": "c1"})   # another provider's account
    h._p_integrations_token(_Req())
    assert h.sent[1] == 404 and rows["c1"]["config"]["api_token"] == "NEW"


def test_an_approved_change_runs_once_and_is_red(rows, monkeypatch):
    from viewer import actions, drives, orglogic
    fake = _FakeHTTP(body=b'{"server": {"id": 1}}')
    monkeypatch.setattr(drives, "_http", fake)
    rows["c1"] = _conn(kind="hetzner", **I.token_config("hetzner", "T", "", {}))
    assert orglogic.is_red("integration_api_call") and not orglogic.self_approves("owner", "ic")
    out = actions.ACTIONS["integration_api_call"](
        {"connection": "c1", "method": "POST", "path": "/servers", "body": {"name": "x"}})
    assert out == {"status": 200, "body": {"server": {"id": 1}}} and fake.calls[0][0] == "POST"
    assert I.op_state(rows["c1"], "hetzner.api", "change") == "off"   # the switch stays off
    rows.pop("c1")
    assert "no longer connected" in actions.ACTIONS["integration_api_call"]({"connection": "c1"})["error"]


def test_a_revoked_exchanged_token_is_traded_again_once(rows, monkeypatch):
    from viewer import cloudauth, drives
    tokens = iter(["old", "new"])
    monkeypatch.setitem(cloudauth._EXCHANGES, "github_app", lambda k, f, http: (next(tokens), 3600))
    monkeypatch.setattr(cloudauth, "_CACHE", {})

    class Http(_FakeHTTP):
        def __call__(self, method, url, headers=None, data=None, timeout=60):
            super().__call__(method, url, headers, data, timeout)
            return (401 if headers["Authorization"] == "Bearer old" else 200), {}, b"{}"
    fake = Http()
    monkeypatch.setattr(drives, "_http", fake)
    rows["c1"] = _conn(kind="github", **I.token_config("github", "KEY", "", {"app_id": "1", "installation_id": "2"}))
    h = _H({"connection": "c1", "path": "/installation/repositories"})
    h._p_integrations_api(_Req(human=False))
    assert h.sent == ({"status": 200, "body": {}}, 200) and len(fake.calls) == 2
    assert not I.expired(rows["c1"])


def test_a_short_429_is_waited_out_once_and_a_long_one_is_returned(rows, monkeypatch):
    from viewer import drives
    waits = []
    monkeypatch.setattr(I, "_sleep", waits.append)

    def run(replies):
        it = iter(replies)

        class Http(_FakeHTTP):
            def __call__(self, method, url, headers=None, data=None, timeout=60):
                super().__call__(method, url, headers, data, timeout)
                return next(it)
        fake = Http()
        monkeypatch.setattr(drives, "_http", fake)
        rows["c1"] = _conn(kind="cloudflare", **I.token_config("cloudflare", "T", "", {}))
        h = _H({"connection": "c1", "path": "/zones"})
        h._p_integrations_api(_Req(human=False))
        return h.sent[0]["status"], len(fake.calls)

    assert run([(429, {"Retry-After": "2"}, b"{}"), (200, {}, b"{}")]) == (200, 2) and waits == [2.0]
    assert run([(429, {}, b"{}"), (429, {}, b"{}")]) == (429, 2)          # only once
    assert run([(429, {"retry-after": "3600"}, b"{}")]) == (429, 1)       # too long: the agent paces
    assert I._retry_after({"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}) is None
