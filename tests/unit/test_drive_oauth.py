"""Tests for the loopback OAuth consent flow (viewer.drive_oauth, Phase 2 of
the cloud-drive work).

The pure helpers (_pkce, _build_auth_url) are tested directly. The rest are
tested END-TO-END: start() really binds a 127.0.0.1 loopback socket, a test
socket plays Google's redirect into it, and the token exchange + persist run
against a faked _http seam and an in-memory db — so "does the loopback actually
exchange a code and store tokens" is covered, not just the shape of the URL.

No Postgres, no network to Google. The db module and the _http seam are
monkeypatched, the client file is a temp fixture pointed at by DRIVES_OAUTH_FILE.
"""
import base64
import hashlib
import json
import socket
import time
import urllib.parse

import pytest

from viewer import drive_oauth
from viewer.drives import DriveError


# --- fixtures ------------------------------------------------------------

def _client_file(tmp_path, dropbox_port=0):
    f = tmp_path / "drives-oauth.json"
    dbx = {"client_id": "dbx-app-key"}
    if dropbox_port:
        dbx["redirect_uris"] = ["http://localhost:%d" % dropbox_port]
    f.write_text(json.dumps({
        "google": {
            "client_id": "test-client-id.apps.googleusercontent.com",
            "client_secret": "test-secret",
            "redirect_uris": ["http://localhost"],
        },
        "dropbox": dbx,
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
    calls = []

    def fake_http(method, url, headers=None, data=None, timeout=60):
        calls.append((method, url, data))
        return 200, {}, json.dumps({
            "access_token": "AT-123", "refresh_token": "RT-456",
            "expires_in": 3600, "token_type": "Bearer",
        }).encode()

    monkeypatch.setattr(drive_oauth, "_http", fake_http)
    return {"db": fake_db, "http_calls": calls}


def _wait_status(pid):
    deadline = time.time() + 10
    while time.time() < deadline:
        st = drive_oauth.status(pid)
        if st["status"] != "waiting":
            return st
        time.sleep(0.05)
    return drive_oauth.status(pid)


def _redirect(pid, query):
    """Play Google's loopback redirect into the listener: a real socket to
    127.0.0.1:<port> sending a GET with the given query string."""
    port = drive_oauth._PENDING[pid]["port"]
    s = socket.create_connection(("127.0.0.1", port), timeout=10)
    s.sendall(("GET /%s HTTP/1.1\r\nHost: localhost\r\n\r\n" % query).encode())
    s.close()


# --- pure helpers --------------------------------------------------------

def test_pkce_is_valid_s256():
    verifier, challenge = drive_oauth._pkce()
    assert 43 <= len(verifier) <= 128
    expect = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode()
    assert challenge == expect
    assert len(challenge) == 43


def test_build_auth_url_has_all_params_and_no_secret():
    client = {"client_id": "CID", "client_secret": "CS",
              "redirect_uris": ["http://localhost"]}
    url, redirect = drive_oauth._build_auth_url(
        "google", client, 8123, "STATE-XYZ", "VERIF", "CHALL")
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
    assert q["client_id"] == "CID"
    assert q["redirect_uri"] == "http://localhost:8123"
    assert redirect == "http://localhost:8123"
    assert q["response_type"] == "code"
    assert q["scope"] == "https://www.googleapis.com/auth/drive"
    assert q["state"] == "STATE-XYZ"
    assert q["access_type"] == "offline"
    assert q["prompt"] == "consent"
    assert q["code_challenge"] == "CHALL"
    assert q["code_challenge_method"] == "S256"
    assert "client_secret" not in q  # the secret never leaves the viewer


def test_build_auth_url_speaks_each_vendors_offline_dialect():
    url, _ = drive_oauth._build_auth_url("dropbox", {"client_id": "K"}, 53682, "S", "V", "C")
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
    assert url.startswith("https://www.dropbox.com/oauth2/authorize?")
    assert q["token_access_type"] == "offline" and "access_type" not in q
    assert q["redirect_uri"] == "http://localhost:53682"
    assert "files.content.write" in q["scope"]
    url, _ = drive_oauth._build_auth_url("onedrive", {"client_id": "E"}, 8123, "S", "V", "C")
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
    assert url.startswith("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?")
    assert "offline_access" in q["scope"] and "access_type" not in q


def test_redirect_target_honors_a_registered_port():
    assert drive_oauth._redirect_target({}) == ("localhost", 0)
    assert drive_oauth._redirect_target({"redirect_uris": ["http://localhost"]}) == ("localhost", 0)
    assert drive_oauth._redirect_target({"redirect_uris": ["http://127.0.0.1:53682"]}) == ("127.0.0.1", 53682)


# --- pre-flight rejections (no socket opened) ----------------------------

def test_unknown_vendor_is_501(env):
    err = pytest.raises(DriveError, drive_oauth.start, "icloud", "drive1").value
    assert err.status == 501


def test_unknown_drive_is_404(env):
    err = pytest.raises(DriveError, drive_oauth.start, "google", "nope").value
    assert err.status == 404


def test_missing_client_file_is_403(tmp_path, monkeypatch):
    monkeypatch.setattr(drive_oauth, "db", _FakeOAuthDB({"drive1": _row()}))
    monkeypatch.setattr("viewer.config.DRIVES_OAUTH_FILE",
                        tmp_path / "does-not-exist.json")  # a Path that doesn't exist
    err = pytest.raises(DriveError, drive_oauth.start, "google", "drive1").value
    assert err.status == 403


def test_status_unknown_pid_is_404():
    err = pytest.raises(DriveError, drive_oauth.status, "nope").value
    assert err.status == 404


# --- end-to-end loopback -------------------------------------------------

def test_full_loopback_authorizes_and_persists(env):
    r = drive_oauth.start("google", "drive1")
    assert r["url"].startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    pid = r["pending"]
    _redirect(pid, "?code=CODE-999&state=%s" % drive_oauth._PENDING[pid]["state"])

    st = _wait_status(pid)
    assert st["status"] == "authorized", st

    # Tokens were persisted into the drive row's config.
    did, entry = env["db"].upserts[-1]
    assert did == "drive1"
    assert entry["config"]["access_token"] == "AT-123"
    assert entry["config"]["refresh_token"] == "RT-456"
    assert entry["config"]["token_expiry"] > time.time()

    # The exchange used the PKCE code_verifier, the code, and the exact
    # redirect_uri (Google requires the two match).
    method, url, data = env["http_calls"][-1]
    assert method == "POST"
    assert url == "https://oauth2.googleapis.com/token"
    form = dict(urllib.parse.parse_qsl(data.decode()))
    assert form["code"] == "CODE-999"
    assert form["grant_type"] == "authorization_code"
    assert form["code_verifier"] == drive_oauth._PENDING[pid]["code_verifier"]
    assert form["client_id"] == "test-client-id.apps.googleusercontent.com"
    assert form["client_secret"] == "test-secret"
    assert form["redirect_uri"] == drive_oauth._PENDING[pid]["redirect_uri"]


def test_denied_consent_is_failed(env):
    pid = drive_oauth.start("google", "drive1")["pending"]
    _redirect(pid, "?error=access_denied&state=%s" % drive_oauth._PENDING[pid]["state"])
    st = _wait_status(pid)
    assert st["status"] == "failed"
    assert "access_denied" in st["error"]


def test_state_mismatch_is_failed(env):
    pid = drive_oauth.start("google", "drive1")["pending"]
    _redirect(pid, "?code=C&state=WRONG-STATE")
    st = _wait_status(pid)
    assert st["status"] == "failed"
    assert "state" in st["error"]


def test_token_exchange_error_is_failed(env, monkeypatch):
    def bad_http(method, url, headers=None, data=None, timeout=60):
        return 400, {}, json.dumps({"error": "invalid_grant",
                                    "error_description": "Invalid Code"}).encode()
    monkeypatch.setattr(drive_oauth, "_http", bad_http)
    pid = drive_oauth.start("google", "drive1")["pending"]
    _redirect(pid, "?code=C&state=%s" % drive_oauth._PENDING[pid]["state"])
    st = _wait_status(pid)
    assert st["status"] == "failed"
    assert "Invalid Code" in st["error"]


def test_public_client_exchange_sends_no_secret(env):
    """Dropbox/OneDrive are PKCE public clients: the token request proves
    itself with code_verifier only — no client_secret field at all."""
    env["db"].rows["drive1"] = _row("dropbox")
    r = drive_oauth.start("dropbox", "drive1")
    assert r["url"].startswith("https://www.dropbox.com/oauth2/authorize?")
    pid = r["pending"]
    _redirect(pid, "?code=DBX-CODE&state=%s" % drive_oauth._PENDING[pid]["state"])
    assert _wait_status(pid)["status"] == "authorized"
    method, url, data = [c for c in env["http_calls"] if c[1].endswith("/oauth2/token")][-1]
    assert url == "https://api.dropboxapi.com/oauth2/token"
    form = dict(urllib.parse.parse_qsl(data.decode()))
    assert form["client_id"] == "dbx-app-key" and form["code_verifier"]
    assert "client_secret" not in form


def test_registered_port_is_the_one_bound(tmp_path, monkeypatch, env):
    """Dropbox matches redirect_uri exactly, port included, so a registered
    'http://localhost:PORT' makes the listener bind THAT port and the
    redirect_uri we send equals the registration verbatim."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    monkeypatch.setattr("viewer.config.DRIVES_OAUTH_FILE", _client_file(tmp_path, dropbox_port=port))
    env["db"].rows["drive1"] = _row("dropbox")
    pid = drive_oauth.start("dropbox", "drive1")["pending"]
    p = drive_oauth._PENDING[pid]
    assert p["port"] == port and p["redirect_uri"] == "http://localhost:%d" % port
    # A second sign-in while that port is held is a clear 409, not a crash.
    err = pytest.raises(DriveError, drive_oauth.start, "dropbox", "drive1").value
    assert err.status == 409
    _redirect(pid, "?error=access_denied&state=%s" % p["state"])
    assert _wait_status(pid)["status"] == "failed"
