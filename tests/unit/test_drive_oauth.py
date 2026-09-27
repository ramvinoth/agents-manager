"""Tests for the hosted OAuth consent flow (viewer.drive_oauth).

The pure helpers (_pkce, _build_auth_url, redirect_uri_for) are tested
directly. The rest are tested END-TO-END through the module's public surface:
start() mints a flow, callback() receives the vendor's parsed redirect query
exactly as the /api/drive/oauth/callback route hands it over, and the token
exchange + persist run against a faked _http seam and an in-memory db — so
"does a redirect actually become stored tokens" is covered, not just the shape
of the URL.

No Postgres, no network to any vendor. The db module and the _http seam are
monkeypatched, the client file is a temp fixture pointed at by DRIVES_OAUTH_FILE.
"""
import base64
import hashlib
import json
import time
import urllib.parse

import pytest

from viewer import drive_oauth
from viewer.drives import DriveError

ORIGIN = "https://life.example.test"
CALLBACK = ORIGIN + "/api/drive/oauth/callback"


# --- fixtures ------------------------------------------------------------

def _client_file(tmp_path):
    f = tmp_path / "drives-oauth.json"
    f.write_text(json.dumps({
        "google": {
            "client_id": "test-client-id.apps.googleusercontent.com",
            "client_secret": "test-secret",
        },
        "dropbox": {"client_id": "dbx-app-key"},
        "onedrive": {"client_id": "entra-app-id"},
    }))
    return f  # a Path — _vendor_client calls .read_text() on it


class _FakeOAuthDB:
    def __init__(self, rows):
        self.rows = rows
        self.upserts = []

    def drive_get(self, did):
        return self.rows.get(did)

    def drive_upsert(self, did, entry):
        self.upserts.append((did, entry))
        self.rows[did] = entry


def _row(kind="google"):
    return {"id": "drive1", "label": "My Drive", "kind": kind,
            "config": {}, "status": "active", "hidden": False, "created_at": 0.0}


@pytest.fixture()
def env(tmp_path, monkeypatch):
    fake_db = _FakeOAuthDB({"drive1": _row()})
    monkeypatch.setattr(drive_oauth, "db", fake_db)
    monkeypatch.setattr("viewer.config.DRIVES_OAUTH_FILE", _client_file(tmp_path))
    monkeypatch.setattr(drive_oauth, "_PENDING", {})
    calls = []

    def fake_http(method, url, headers=None, data=None, timeout=60):
        calls.append((method, url, data))
        return 200, {}, json.dumps({
            "access_token": "AT-123", "refresh_token": "RT-456",
            "expires_in": 3600, "token_type": "Bearer",
        }).encode()

    monkeypatch.setattr(drive_oauth, "_http", fake_http)
    return {"db": fake_db, "http_calls": calls}


def _redirect(pid, **params):
    """Play the vendor's redirect: the parsed callback query, as the route
    passes it (parse_qs shape — {name: [values]})."""
    if params.pop("good_state", False):
        params["state"] = drive_oauth._PENDING[pid]["state"]
    return drive_oauth.callback({k: [v] for k, v in params.items()})


# --- pure helpers --------------------------------------------------------

def test_pkce_is_valid_s256():
    verifier, challenge = drive_oauth._pkce()
    assert 43 <= len(verifier) <= 128
    expect = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode()
    assert challenge == expect
    assert len(challenge) == 43


def test_redirect_uri_is_the_callback_on_the_requesting_origin():
    assert drive_oauth.redirect_uri_for(ORIGIN) == CALLBACK
    assert drive_oauth.redirect_uri_for(ORIGIN + "/") == CALLBACK
    assert drive_oauth.redirect_uri_for("http://localhost:8091") == \
        "http://localhost:8091/api/drive/oauth/callback"


def test_build_auth_url_has_all_params_and_no_secret():
    client = {"client_id": "CID", "client_secret": "CS"}
    url = drive_oauth._build_auth_url("google", client, CALLBACK, "STATE-XYZ", "CHALL")
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
    assert q["client_id"] == "CID"
    assert q["redirect_uri"] == CALLBACK
    assert q["response_type"] == "code"
    assert q["scope"] == "https://www.googleapis.com/auth/drive"
    assert q["state"] == "STATE-XYZ"
    assert q["access_type"] == "offline"
    assert q["prompt"] == "consent"
    assert q["code_challenge"] == "CHALL"
    assert q["code_challenge_method"] == "S256"
    assert "client_secret" not in q  # the secret never leaves the viewer


def test_build_auth_url_speaks_each_vendors_offline_dialect():
    url = drive_oauth._build_auth_url("dropbox", {"client_id": "K"}, CALLBACK, "S", "C")
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
    assert url.startswith("https://www.dropbox.com/oauth2/authorize?")
    assert q["token_access_type"] == "offline" and "access_type" not in q
    assert q["redirect_uri"] == CALLBACK
    assert "files.content.write" in q["scope"]
    url = drive_oauth._build_auth_url("onedrive", {"client_id": "E"}, CALLBACK, "S", "C")
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
    assert url.startswith("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?")
    assert "offline_access" in q["scope"] and "access_type" not in q


# --- pre-flight rejections -----------------------------------------------

def test_unknown_vendor_is_501(env):
    err = pytest.raises(DriveError, drive_oauth.start, "icloud", "drive1", ORIGIN).value
    assert err.status == 501


def test_unknown_drive_is_404(env):
    err = pytest.raises(DriveError, drive_oauth.start, "google", "nope", ORIGIN).value
    assert err.status == 404


def test_missing_client_file_is_403(tmp_path, monkeypatch):
    monkeypatch.setattr(drive_oauth, "db", _FakeOAuthDB({"drive1": _row()}))
    monkeypatch.setattr("viewer.config.DRIVES_OAUTH_FILE",
                        tmp_path / "does-not-exist.json")  # a Path that doesn't exist
    err = pytest.raises(DriveError, drive_oauth.start, "google", "drive1", ORIGIN).value
    assert err.status == 403


def test_status_unknown_pid_is_404():
    err = pytest.raises(DriveError, drive_oauth.status, "nope").value
    assert err.status == 404


# --- end-to-end: start → vendor redirect → exchange → persist -------------

def test_full_flow_authorizes_and_persists(env):
    r = drive_oauth.start("google", "drive1", ORIGIN)
    assert r["url"].startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert r["redirect_uri"] == CALLBACK
    pid = r["pending"]
    assert drive_oauth.status(pid)["status"] == "waiting"

    page = _redirect(pid, code="CODE-999", good_state=True)
    assert "Google Drive connected" in page
    assert drive_oauth.status(pid)["status"] == "authorized"

    # Tokens were persisted into the drive row's config.
    did, entry = env["db"].upserts[-1]
    assert did == "drive1"
    assert entry["config"]["access_token"] == "AT-123"
    assert entry["config"]["refresh_token"] == "RT-456"
    assert entry["config"]["token_expiry"] > time.time()

    # The exchange used the PKCE code_verifier, the code, and the exact
    # redirect_uri the browser was sent to (vendors require the two match).
    method, url, data = env["http_calls"][-1]
    assert method == "POST"
    assert url == "https://oauth2.googleapis.com/token"
    form = dict(urllib.parse.parse_qsl(data.decode()))
    assert form["code"] == "CODE-999"
    assert form["grant_type"] == "authorization_code"
    assert form["code_verifier"] == drive_oauth._PENDING[pid]["code_verifier"]
    assert form["client_id"] == "test-client-id.apps.googleusercontent.com"
    assert form["client_secret"] == "test-secret"
    assert form["redirect_uri"] == CALLBACK


def test_denied_consent_is_failed(env):
    pid = drive_oauth.start("google", "drive1", ORIGIN)["pending"]
    page = _redirect(pid, error="access_denied", good_state=True)
    assert "did not grant access" in page
    st = drive_oauth.status(pid)
    assert st["status"] == "failed"
    assert "access_denied" in st["error"]


def test_unknown_state_touches_no_flow(env):
    """A forged or replayed redirect finds no waiting flow: the real flow
    stays 'waiting', nothing is exchanged, the page is a generic failure."""
    pid = drive_oauth.start("google", "drive1", ORIGIN)["pending"]
    page = _redirect(pid, code="C", state="WRONG-STATE")
    assert "didn't complete" in page
    assert drive_oauth.status(pid)["status"] == "waiting"
    assert env["http_calls"] == []
    assert "didn't complete" in drive_oauth.callback({})  # no state at all


def test_state_is_consumed_exactly_once(env):
    pid = drive_oauth.start("google", "drive1", ORIGIN)["pending"]
    _redirect(pid, code="C1", good_state=True)
    assert drive_oauth.status(pid)["status"] == "authorized"
    _redirect(pid, code="C2", good_state=True)   # replay
    assert len(env["http_calls"]) == 1
    assert drive_oauth.status(pid)["status"] == "authorized"


def test_token_exchange_error_is_failed(env, monkeypatch):
    def bad_http(method, url, headers=None, data=None, timeout=60):
        return 400, {}, json.dumps({"error": "invalid_grant",
                                    "error_description": "Invalid Code"}).encode()
    monkeypatch.setattr(drive_oauth, "_http", bad_http)
    pid = drive_oauth.start("google", "drive1", ORIGIN)["pending"]
    page = _redirect(pid, code="C", good_state=True)
    assert "Invalid Code" in page
    st = drive_oauth.status(pid)
    assert st["status"] == "failed"
    assert "Invalid Code" in st["error"]
    assert env["db"].upserts == []


def test_public_client_exchange_sends_no_secret(env):
    """Dropbox/OneDrive are PKCE public clients: the token request proves
    itself with code_verifier only — no client_secret field at all."""
    env["db"].rows["drive1"] = _row("dropbox")
    r = drive_oauth.start("dropbox", "drive1", ORIGIN)
    assert r["url"].startswith("https://www.dropbox.com/oauth2/authorize?")
    pid = r["pending"]
    _redirect(pid, code="DBX-CODE", good_state=True)
    assert drive_oauth.status(pid)["status"] == "authorized"
    method, url, data = [c for c in env["http_calls"] if c[1].endswith("/oauth2/token")][-1]
    assert url == "https://api.dropboxapi.com/oauth2/token"
    form = dict(urllib.parse.parse_qsl(data.decode()))
    assert form["client_id"] == "dbx-app-key" and form["code_verifier"]
    assert "client_secret" not in form


def test_concurrent_flows_are_independent(env):
    """Two sign-ins in flight at once (two users, or two drives): each
    redirect completes only its own flow."""
    env["db"].rows["drive2"] = dict(_row("onedrive"), id="drive2")
    a = drive_oauth.start("google", "drive1", ORIGIN)["pending"]
    b = drive_oauth.start("onedrive", "drive2", ORIGIN)["pending"]
    _redirect(b, code="MS", good_state=True)
    assert drive_oauth.status(a)["status"] == "waiting"
    assert drive_oauth.status(b)["status"] == "authorized"
    assert env["db"].upserts[-1][0] == "drive2"


def test_stale_flow_expires_and_is_forgotten(env, monkeypatch):
    pid = drive_oauth.start("google", "drive1", ORIGIN)["pending"]
    started = drive_oauth._PENDING[pid]["started"]
    monkeypatch.setattr(drive_oauth.time, "time",
                        lambda: started + drive_oauth._CONSENT_TTL + 1)
    st = drive_oauth.status(pid)
    assert st["status"] == "expired" and "time" in st["error"]
    # A late redirect can no longer complete it.
    _redirect(pid, code="LATE", good_state=True)
    assert env["http_calls"] == []
    monkeypatch.setattr(drive_oauth.time, "time",
                        lambda: started + 2 * drive_oauth._CONSENT_TTL + 1)
    assert pytest.raises(DriveError, drive_oauth.status, pid).value.status == 404
