"""Unit tests for the cloud-drive spine (Phase 1 of storage integrations):
- viewer.drives: the plugin-lifecycle gate (adapter_for) — unknown 404,
  hidden/paused 403, unknown kind 501 — and the three vendor adapters
  (Google, Dropbox, OneDrive), each driven through the single _http seam by
  an in-memory fake of its REST dialect.
- routes/fs._resolve_location: exactly one of drive/host; no params means
  local (the pre-drive behavior); drive comes from the query (GET) or the
  JSON body (POST).
- the adapter interface contract: the methods the fs routes call on an
  adapter are exactly the nine BaseDrive implements (a new op added to the
  routes must be added to the interface, or this test fails).

No Postgres, no network: the db module is monkeypatched with an in-memory
fake, the way test_providers.py does it.
"""
import json
import re
import time
import zipfile
from io import BytesIO
from pathlib import Path

import pytest

from viewer import drives
from viewer.drives import ADAPTERS, BaseDrive, DriveError, DropboxDrive, GoogleDrive, OneDriveDrive, adapter_for
from viewer.routes.fs import _resolve_location

FOLDER = "application/vnd.google-apps.folder"


class _FakeDriveDB:
    """In-memory stand-in for the drives table: drive_get (adapter_for) and
    drive_upsert (a token refresh persisting back). Rows mirror db._drive_row's
    shape; the upsert records the call so a test can assert a refresh saved."""

    def __init__(self, rows):
        self.rows = rows
        self.upserts = []

    def drive_get(self, did):
        return dict(self.rows[did]) if did in self.rows else None

    def drive_upsert(self, did, entry):
        self.upserts.append((did, entry))
        self.rows[did] = entry


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


def test_active_google_drive_gets_its_adapter(db):
    db.rows["d1"] = _row(kind="google")
    a = adapter_for("d1")
    assert isinstance(a, GoogleDrive)
    assert a.config["account"] == "ram@example.com"


def test_unknown_kind_is_501(db):
    db.rows["d1"] = _row(kind="icloud")
    err = pytest.raises(DriveError, adapter_for, "d1").value
    assert err.status == 501


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
    # Every shipped adapter must implement every op the routes call (through
    # its own class or the shared _OAuthDrive), never fall through to the
    # BaseDrive 501 — a vendor that forgot one would look "not supported".
    for cls in ADAPTERS.values():
        for m in called:
            assert getattr(cls, m) is not getattr(BaseDrive, m), f"{cls.kind} lacks {m}"


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


# --- GoogleDrive (Phase 2): driven by a fake _http, no network ------------

class _FakeGoogle:
    """A just-enough in-memory Drive v3 + token endpoint behind the single
    _http seam. `files` maps id -> {name,mime,parents,size,modified,content}.
    It parses the `q=` listing/child queries the adapter builds and serves the
    matching rows, so path resolution runs against a real (fake) tree."""

    def __init__(self, files):
        self.files = files
        self.refresh_calls = 0
        self.fail_refresh = False
        self.first_401 = None  # a url prefix that 401s exactly once

    def _match(self, q):
        import urllib.parse as up
        parent = re.search(r"'([^']+)' in parents", q)
        name = re.search(r"name = '([^']+)'", q)
        out = []
        for fid, f in self.files.items():
            if f.get("trashed"):
                continue
            if parent and parent.group(1) not in f.get("parents", []):
                continue
            if name and f.get("name") != name.group(1):
                continue
            out.append({"id": fid, "name": f.get("name", ""),
                        "mimeType": f.get("mime", ""), "size": str(f.get("size", 0)),
                        "modifiedTime": f.get("modified", "")})
        return out

    def _http(self, method, url, headers=None, data=None, timeout=60):
        import urllib.parse as up
        u = up.urlparse(url)
        q = up.parse_qs(u.query)
        if u.netloc == "oauth2.googleapis.com":
            self.refresh_calls += 1
            if self.fail_refresh:
                return 400, {}, b'{"error":"invalid_grant"}'
            return 200, {}, json.dumps(
                {"access_token": "AT1", "refresh_token": "RT1", "expires_in": 3600}).encode()
        if u.netloc == "www.googleapis.com":
            if u.path == "/drive/v3/about":
                return 200, {}, json.dumps({"user": {"emailAddress": "ram@example.com"}}).encode()
            if u.path == "/drive/v3/files/root":
                return 200, {}, json.dumps(
                    {"id": "root", "name": "Drive", "mimeType": FOLDER}).encode()
            if u.path == "/drive/v3/files" and q.get("q"):
                return 200, {}, json.dumps({"files": self._match(q["q"][0])}).encode()
            if u.path == "/drive/v3/files" and method == "POST":
                body = json.loads(data)
                newid = f"m{len(self.files) + 1}"
                self.files[newid] = {"name": body.get("name"), "mime": body.get("mimeType", ""),
                                     "parents": body.get("parents", []), "size": 0, "content": b""}
                return 200, {}, json.dumps({"id": newid, "name": body.get("name")}).encode()
            if u.path == "/upload/drive/v3/files":
                parent = (q.get("parents") or [""])[0]
                boundary = (headers or {}).get("Content-Type", "").split("boundary=")[-1].strip()
                meta, content = b"", b""
                if boundary:
                    parts = (data or b"").split(b"--" + boundary.encode())
                    if len(parts) >= 2 and b"\r\n\r\n" in parts[1]:
                        meta = json.loads(parts[1].split(b"\r\n\r\n", 1)[1].split(b"\r\n")[0])
                    if len(parts) >= 3 and b"\r\n\r\n" in parts[2]:
                        content = parts[2].split(b"\r\n\r\n", 1)[1].rstrip(b"\r\n")
                name = meta.get("name") or "upload"
                newid = f"u{len(self.files) + 1}"
                self.files[newid] = {"name": name, "mime": meta.get("mimeType", "application/octet-stream"),
                                     "parents": [parent], "size": len(content), "content": content}
                return 200, {}, json.dumps({"id": newid, "name": name}).encode()
            m = re.match(r"^/drive/v3/files/(.+)$", u.path)
            if m:
                rest = m.group(1)
                if rest.endswith("/trash"):
                    fid = rest[: -len("/trash")]
                    if fid in self.files:
                        self.files[fid]["trashed"] = True
                    return 200, {}, json.dumps({"id": fid}).encode()
                if self.first_401 and url.startswith(self.first_401) and not getattr(self, "_retried", False):
                    self._retried = True
                    return 401, {}, b'{"error":{"code":401,"message":"Invalid Credentials"}}'
                if q.get("alt") == ["media"]:
                    return 200, {}, self.files.get(rest, {}).get("content", b"")
                if method == "PATCH":
                    body = json.loads(data)
                    if rest in self.files:
                        self.files[rest]["name"] = body.get("name")
                    return 200, {}, json.dumps(
                        {"id": rest, "name": body.get("name"),
                         "mimeType": self.files.get(rest, {}).get("mime", "")}).encode()
                f = self.files.get(rest, {})
                return 200, {}, json.dumps(
                    {"id": rest, "name": f.get("name", ""), "mimeType": f.get("mime", ""),
                     "size": str(f.get("size", 0)), "modifiedTime": f.get("modified", "")}).encode()
        return 404, {}, json.dumps({"error": {"code": 404, "message": "no such route"}}).encode()


def _gdrive(db, monkeypatch, files=None):
    """A GoogleDrive over the fake, with a FRESH valid token (so no refresh
    fires mid-test) and the fake wired into the _http seam."""
    if files is None:
        files = {
            "root": {"name": "Drive", "mime": FOLDER, "parents": [], "size": 0, "content": b""},
            "d1": {"name": "Docs", "mime": FOLDER, "parents": ["root"], "size": 0, "content": b""},
            "f1": {"name": "a.txt", "mime": "text/plain", "parents": ["d1"], "size": 3,
                   "content": b"abc", "modified": "2026-09-26T06:00:00.000Z"},
            "f2": {"name": "b.md", "mime": "text/markdown", "parents": ["d1"], "size": 2,
                   "content": b"hi", "modified": "2026-09-25T05:00:00.000Z"},
        }
    fake = _FakeGoogle(files)
    monkeypatch.setattr(drives, "_http", fake._http)
    monkeypatch.setattr(drives, "_vendor_client", lambda kind, public=False: {"client_id": "cid", "client_secret": "csec"})
    db.rows["d1"] = _row(kind="google")
    db.rows["d1"]["config"] = {
        "account": "ram@example.com", "access_token": "AT0",
        "refresh_token": "RT0", "token_expiry": time.time() + 3600,
    }
    a = adapter_for("d1")
    a.config = db.rows["d1"]["config"]  # share the fixture's dict with the adapter
    return a, fake


def test_google_list_shape(db, monkeypatch):
    a, _ = _gdrive(db, monkeypatch)
    d = a.fs_list("/Docs")
    assert d["path"] == "/Docs"
    assert d["parent"] == "/"
    assert d["home"] == "/"
    assert d["truncated"] is False
    by_name = {e["name"]: e for e in d["entries"]}
    assert set(by_name) == {"a.txt", "b.md"}
    assert by_name["a.txt"]["dir"] is False and by_name["a.txt"]["size"] == 3
    assert by_name["a.txt"]["mtime"] > 0


def test_google_read_bytes(db, monkeypatch):
    a, _ = _gdrive(db, monkeypatch)
    data, name = a.read_bytes("/Docs/a.txt")
    assert data == b"abc" and name == "a.txt"


def test_google_read_folder_is_400(db, monkeypatch):
    a, _ = _gdrive(db, monkeypatch)
    err = pytest.raises(DriveError, a.read_bytes, "/Docs").value
    assert err.status == 400


def test_google_missing_segment_is_404(db, monkeypatch):
    a, _ = _gdrive(db, monkeypatch)
    err = pytest.raises(DriveError, a.read_bytes, "/Docs/nope.txt").value
    assert err.status == 404


def test_google_mkdir(db, monkeypatch):
    a, fake = _gdrive(db, monkeypatch)
    r = a.mkdir("/Docs", "Reports")
    assert r["created"] == "/Docs/Reports"
    assert any(f["name"] == "Reports" and "d1" in f["parents"] for f in fake.files.values())


def test_google_upload(db, monkeypatch):
    a, _ = _gdrive(db, monkeypatch)
    r = a.upload("/Docs", [("up.bin", b"xyz")])
    assert r["uploaded"][0] == {"name": "up.bin", "size": 3, "path": "/Docs/up.bin"}


def test_google_upload_to_file_is_400(db, monkeypatch):
    a, _ = _gdrive(db, monkeypatch)
    err = pytest.raises(DriveError, a.upload, "/Docs/a.txt", [("x", b"1")]).value
    assert err.status == 400


def test_google_rename(db, monkeypatch):
    a, _ = _gdrive(db, monkeypatch)
    r = a.rename("/Docs/a.txt", "c.txt")
    assert r["renamed"] == "/Docs/c.txt"


def test_google_delete_trashes(db, monkeypatch):
    a, fake = _gdrive(db, monkeypatch)
    r = a.delete("/Docs/a.txt")
    assert r["deleted"] == "/Docs/a.txt" and r["trash"] == "google-drive"
    assert fake.files["f1"]["trashed"] is True


def test_google_build_zip_is_a_real_zip(db, monkeypatch):
    a, _ = _gdrive(db, monkeypatch)
    data, name = a.build_zip("/Docs", ["a.txt"])
    assert name == "a.txt.zip"
    with zipfile.ZipFile(BytesIO(data)) as z:
        assert z.namelist() == ["a.txt"]
        assert z.read("a.txt") == b"abc"


def test_google_compress_uploads_zip(db, monkeypatch):
    a, fake = _gdrive(db, monkeypatch)
    r = a.compress("/Docs", ["a.txt"], "bundle")
    assert r["created"] == "/Docs/bundle.zip"
    created = [f for f in fake.files.values() if f["name"] == "bundle.zip"]
    assert created and created[0]["parents"] == ["d1"]


def test_google_status_authorized(db, monkeypatch):
    a, _ = _gdrive(db, monkeypatch)
    s = a.status()
    assert s["ok"] is True and s["account"] == "ram@example.com"


def test_google_status_unauthorized(db, monkeypatch):
    db.rows["d1"] = _row(kind="google")
    db.rows["d1"]["config"] = {"account": "x@y.z"}  # no refresh token yet
    monkeypatch.setattr(drives, "_http", _FakeGoogle({})._http)
    a = adapter_for("d1")
    a.config = db.rows["d1"]["config"]
    s = a.status()
    assert s["ok"] is False and "not authorized" in s["error"]


def test_google_refresh_persists_new_token(db, monkeypatch):
    a, fake = _gdrive(db, monkeypatch)
    a.config["access_token"] = ""          # force a refresh
    a.config["token_expiry"] = 0
    token = a._access_token()
    assert token == "AT1" and fake.refresh_calls == 1
    assert a.config["refresh_token"] == "RT1"
    assert a.config["token_expiry"] > time.time()
    assert db.upserts, "a refresh must persist the new token via drive_upsert"


def test_google_refresh_failure_is_403_reauth(db, monkeypatch):
    a, fake = _gdrive(db, monkeypatch)
    fake.fail_refresh = True
    a.config["access_token"] = ""
    a.config["token_expiry"] = 0
    err = pytest.raises(DriveError, a._access_token).value
    assert err.status == 403 and "re-authorize" in str(err)


def test_google_401_forces_one_refresh_and_retry(db, monkeypatch):
    a, fake = _gdrive(db, monkeypatch)
    fake.first_401 = "https://www.googleapis.com/drive/v3/files/f1?alt=media"
    data, name = a.read_bytes("/Docs/a.txt")  # resolves (200) then the media call 401s once
    assert data == b"abc" and name == "a.txt"
    assert fake.refresh_calls == 1            # the 401 triggered exactly one refresh


# --- DropboxDrive (Phase 3): path-addressed RPC + content endpoints ---------

class _FakeDropbox:
    """A just-enough Dropbox v2 behind _http: `tree` maps lower-cased paths
    ("" is the root) to {"tag": file|folder, "content", "modified"}. RPC calls
    carry a JSON body; content calls carry Dropbox-API-Arg. Errors come back
    the way Dropbox sends them: 409 + error_summary."""

    def __init__(self, tree):
        self.tree = tree
        self.refresh_forms = []

    @staticmethod
    def _409(summary):
        return 409, {}, json.dumps({"error_summary": summary, "error": {}}).encode()

    def _children(self, path):
        prefix = path.lower() + "/"
        return [(p, e) for p, e in self.tree.items()
                if p and p.startswith(prefix) and "/" not in p[len(prefix):]]

    def _entry(self, p, e):
        name = p.rsplit("/", 1)[-1]
        out = {".tag": e["tag"], "name": name, "path_display": p, "path_lower": p.lower()}
        if e["tag"] == "file":
            out["size"] = len(e.get("content", b""))
            out["server_modified"] = e.get("modified", "2026-09-27T01:02:03Z")
        return out

    def _http(self, method, url, headers=None, data=None, timeout=60):
        import urllib.parse as up
        u = up.urlparse(url)
        headers = headers or {}
        if u.path == "/oauth2/token":
            form = up.parse_qs(data.decode())
            self.refresh_forms.append(form)
            return 200, {}, json.dumps({"access_token": "AT1", "expires_in": 14400}).encode()
        if u.netloc == "api.dropboxapi.com":
            arg = json.loads(data) if data else None
            ep = u.path[len("/2/"):]
            if ep == "users/get_current_account":
                return 200, {}, json.dumps({"email": "ram@dropbox.test"}).encode()
            if ep == "files/list_folder":
                p = arg["path"].lower()
                e = self.tree.get(p)
                if e is None:
                    return self._409("path/not_found/..")
                if e["tag"] != "folder":
                    return self._409("path/not_folder/..")
                return 200, {}, json.dumps(
                    {"entries": [self._entry(cp, ce) for cp, ce in self._children(p)],
                     "has_more": False, "cursor": "c"}).encode()
            if ep == "files/get_metadata":
                p = arg["path"].lower()
                e = self.tree.get(p)
                if e is None:
                    return self._409("path/not_found/..")
                return 200, {}, json.dumps(self._entry(p, e)).encode()
            if ep == "files/create_folder_v2":
                p = arg["path"].lower()
                if p in self.tree:
                    return self._409("path/conflict/folder/..")
                self.tree[p] = {"tag": "folder"}
                return 200, {}, json.dumps({"metadata": self._entry(p, self.tree[p])}).encode()
            if ep == "files/move_v2":
                src, dst = arg["from_path"].lower(), arg["to_path"].lower()
                if src not in self.tree:
                    return self._409("from_lookup/not_found/..")
                self.tree[dst] = self.tree.pop(src)
                return 200, {}, json.dumps({"metadata": self._entry(dst, self.tree[dst])}).encode()
            if ep == "files/delete_v2":
                p = arg["path"].lower()
                if p not in self.tree:
                    return self._409("path_lookup/not_found/..")
                self.tree.pop(p)["trashed"] = True
                return 200, {}, json.dumps({"metadata": {}}).encode()
        if u.netloc == "content.dropboxapi.com":
            arg = json.loads(headers["Dropbox-API-Arg"])
            ep = u.path[len("/2/"):]
            p = arg["path"].lower()
            if ep == "files/download":
                e = self.tree.get(p)
                if e is None:
                    return self._409("path/not_found/..")
                if e["tag"] != "file":
                    return self._409("path/not_file/..")
                return 200, {}, e["content"]
            if ep == "files/upload":
                assert headers.get("Content-Type") == "application/octet-stream"
                self.tree[p] = {"tag": "file", "content": data}
                return 200, {}, json.dumps(self._entry(p, self.tree[p])).encode()
            if ep == "files/download_zip":
                buf = BytesIO()
                with zipfile.ZipFile(buf, "w") as z:
                    z.writestr("native-marker", p)
                return 200, {}, buf.getvalue()
        return 500, {}, b"unexpected route"


def _dbx(db, monkeypatch):
    fake = _FakeDropbox({
        "": {"tag": "folder"},
        "/docs": {"tag": "folder"},
        "/docs/a.txt": {"tag": "file", "content": b"abc", "modified": "2026-09-26T06:00:00Z"},
        "/docs/sub": {"tag": "folder"},
        "/docs/sub/b.md": {"tag": "file", "content": b"hi"},
    })
    monkeypatch.setattr(drives, "_http", fake._http)
    monkeypatch.setattr(drives, "_vendor_client", lambda kind, public=False: {"client_id": "cid"})
    db.rows["d1"] = _row(kind="dropbox")
    db.rows["d1"]["config"] = {"access_token": "AT0", "refresh_token": "RT0",
                               "token_expiry": time.time() + 3600}
    a = adapter_for("d1")
    a.config = db.rows["d1"]["config"]
    assert isinstance(a, DropboxDrive)
    return a, fake


def test_dropbox_list_root_and_folder(db, monkeypatch):
    a, _ = _dbx(db, monkeypatch)
    root = a.fs_list("~")
    assert root["path"] == "/" and root["parent"] is None
    assert [e["name"] for e in root["entries"]] == ["docs"]
    d = a.fs_list("/docs")
    assert d["parent"] == "/"
    assert [(e["name"], e["dir"]) for e in d["entries"]] == [("sub", True), ("a.txt", False)]
    assert {e["name"]: e["size"] for e in d["entries"]}["a.txt"] == 3


def test_dropbox_errors_map_to_http(db, monkeypatch):
    a, _ = _dbx(db, monkeypatch)
    assert pytest.raises(DriveError, a.fs_list, "/nope").value.status == 404
    assert pytest.raises(DriveError, a.fs_list, "/docs/a.txt").value.status == 400
    assert pytest.raises(DriveError, a.read_bytes, "/docs").value.status == 400
    assert pytest.raises(DriveError, a.mkdir, "/docs", "sub").value.status == 400


def test_dropbox_read_upload_mkdir_rename_delete(db, monkeypatch):
    a, fake = _dbx(db, monkeypatch)
    assert a.read_bytes("/docs/a.txt") == (b"abc", "a.txt")
    r = a.upload("/docs", [("up.bin", b"xyz")])
    assert r["uploaded"] == [{"name": "up.bin", "size": 3, "path": "/docs/up.bin"}]
    assert fake.tree["/docs/up.bin"]["content"] == b"xyz"
    assert a.mkdir("/docs", "Reports") == {"created": "/docs/Reports"}
    assert a.rename("/docs/a.txt", "c.txt") == {"renamed": "/docs/c.txt"}
    assert "/docs/c.txt" in fake.tree and "/docs/a.txt" not in fake.tree
    assert a.delete("/docs/c.txt") == {"deleted": "/docs/c.txt", "trash": "dropbox"}
    assert pytest.raises(DriveError, a.delete, "/").value.status == 400


def test_dropbox_upload_over_cap_is_per_file_error(db, monkeypatch):
    a, _ = _dbx(db, monkeypatch)
    monkeypatch.setattr(DropboxDrive, "_UPLOAD_CAP", 4)
    r = a.upload("/docs", [("big", b"12345"), ("ok", b"1")])
    assert "error" in r["uploaded"][0] and r["uploaded"][1]["size"] == 1


def test_dropbox_zip_one_folder_is_native_else_client(db, monkeypatch):
    a, _ = _dbx(db, monkeypatch)
    data, name = a.build_zip("/docs", ["sub"])
    assert name == "sub.zip"
    with zipfile.ZipFile(BytesIO(data)) as z:
        assert z.namelist() == ["native-marker"]
    data, name = a.build_zip("/docs", ["a.txt", "sub"])
    assert name == "Archive.zip"
    with zipfile.ZipFile(BytesIO(data)) as z:
        assert sorted(z.namelist()) == ["a.txt", "sub/b.md"]
        assert z.read("sub/b.md") == b"hi"


def test_dropbox_compress_uploads_zip(db, monkeypatch):
    a, fake = _dbx(db, monkeypatch)
    assert a.compress("/docs", ["a.txt"], "bundle") == {"created": "/docs/bundle.zip"}
    with zipfile.ZipFile(BytesIO(fake.tree["/docs/bundle.zip"]["content"])) as z:
        assert z.namelist() == ["a.txt"]


def test_dropbox_refresh_is_public_client(db, monkeypatch):
    a, fake = _dbx(db, monkeypatch)
    a.config["token_expiry"] = 0
    assert a._access_token() == "AT1"
    form = fake.refresh_forms[0]
    assert form["grant_type"] == ["refresh_token"] and form["client_id"] == ["cid"]
    assert "client_secret" not in form
    assert a.config["refresh_token"] == "RT0"   # Dropbox does not rotate it
    assert db.upserts


def test_dropbox_status(db, monkeypatch):
    a, _ = _dbx(db, monkeypatch)
    assert a.status() == {"ok": True, "account": "ram@dropbox.test"}


# --- OneDriveDrive (Phase 3): Graph root:/path: addressing -----------------

class _FakeGraph:
    """A just-enough Microsoft Graph behind _http: `tree` maps "/a/b" paths
    ("/" is the root) to {"folder": bool, "content"}. Downloads go through a
    pre-authenticated URL that must arrive WITHOUT a bearer header."""

    def __init__(self, tree):
        self.tree = tree
        self.next_id = 1
        self.ids = {}
        self.refresh_forms = []
        self.download_headers = []

    def _id(self, p):
        if p not in self.ids:
            self.ids[p] = f"item{self.next_id}"
            self.next_id += 1
        return self.ids[p]

    def _item(self, p):
        e = self.tree[p]
        name = "root" if p == "/" else p.rsplit("/", 1)[-1]
        out = {"id": self._id(p), "name": name, "lastModifiedDateTime": "2026-09-26T06:00:00Z"}
        if e.get("folder"):
            out["folder"] = {"childCount": 0}
            out["size"] = 0
        else:
            out["file"] = {}
            out["size"] = len(e.get("content", b""))
            out["@microsoft.graph.downloadUrl"] = "https://dl.test/" + self._id(p)
        return out

    def _children(self, p):
        prefix = "/" if p == "/" else p + "/"
        return [c for c in self.tree if c != "/" and c.startswith(prefix) and "/" not in c[len(prefix):]]

    @staticmethod
    def _err(status, code, msg):
        return status, {}, json.dumps({"error": {"code": code, "message": msg}}).encode()

    @staticmethod
    def _path(rest):
        import urllib.parse as up
        # "/root" | "/root:/a/b:"  (+ optional "/children" | "/content")
        if rest.startswith("/root:"):
            body = rest[len("/root:"):]
            p, _, tail = body.partition(":")
            return up.unquote(p) or "/", tail
        return "/", rest[len("/root"):]

    def _http(self, method, url, headers=None, data=None, timeout=60):
        import urllib.parse as up
        u = up.urlparse(url)
        headers = headers or {}
        if u.netloc == "login.microsoftonline.com":
            self.refresh_forms.append(up.parse_qs(data.decode()))
            return 200, {}, json.dumps({"access_token": "AT1", "refresh_token": "RT1", "expires_in": 3600}).encode()
        if u.netloc == "dl.test":
            self.download_headers.append(headers)
            for p, iid in self.ids.items():
                if url.endswith("/" + iid):
                    return 200, {}, self.tree[p]["content"]
            return 404, {}, b""
        if u.path == "/v1.0/me":
            return 200, {}, json.dumps({"userPrincipalName": "ram@outlook.test"}).encode()
        if u.path.startswith("/v1.0/me/drive"):
            p, tail = self._path(u.path[len("/v1.0/me/drive"):])
            e = self.tree.get(p)
            if tail == "/content" and method == "PUT":
                # PUT targets the not-yet-existing path: create it.
                self.tree[p] = {"content": data}
                return 201, {}, json.dumps(self._item(p)).encode()
            if e is None:
                return self._err(404, "itemNotFound", "The resource could not be found.")
            if tail == "/children" and method == "GET":
                if not e.get("folder"):
                    return self._err(400, "invalidRequest", "not a folder")
                return 200, {}, json.dumps({"value": [self._item(c) for c in self._children(p)]}).encode()
            if tail == "/children" and method == "POST":
                body = json.loads(data)
                target = ("/" if p == "/" else p + "/") + body["name"]
                if target in self.tree:
                    return self._err(409, "nameAlreadyExists", "exists")
                self.tree[target] = {"folder": True}
                return 201, {}, json.dumps(self._item(target)).encode()
            if tail == "" and method == "GET":
                return 200, {}, json.dumps(self._item(p)).encode()
            if tail == "" and method == "PATCH":
                new = p.rsplit("/", 1)[0] + "/" + json.loads(data)["name"]
                self.tree[new.replace("//", "/")] = self.tree.pop(p)
                return 200, {}, json.dumps(self._item(new.replace("//", "/"))).encode()
            if tail == "" and method == "DELETE":
                self.tree.pop(p)
                return 204, {}, b""
        return 500, {}, b"unexpected route"


def _odrive(db, monkeypatch):
    fake = _FakeGraph({
        "/": {"folder": True},
        "/Docs": {"folder": True},
        "/Docs/a.txt": {"content": b"abc"},
        "/Docs/Sub": {"folder": True},
        "/Docs/Sub/b.md": {"content": b"hi"},
    })
    monkeypatch.setattr(drives, "_http", fake._http)
    monkeypatch.setattr(drives, "_vendor_client", lambda kind, public=False: {"client_id": "cid"})
    db.rows["d1"] = _row(kind="onedrive")
    db.rows["d1"]["config"] = {"access_token": "AT0", "refresh_token": "RT0",
                               "token_expiry": time.time() + 3600}
    a = adapter_for("d1")
    a.config = db.rows["d1"]["config"]
    assert isinstance(a, OneDriveDrive)
    return a, fake


def test_onedrive_path_addressing():
    assert OneDriveDrive._item("~") == "/root"
    assert OneDriveDrive._item("/Docs/My File.txt") == "/root:/Docs/My%20File.txt:"


def test_onedrive_list(db, monkeypatch):
    a, _ = _odrive(db, monkeypatch)
    assert [e["name"] for e in a.fs_list("/")["entries"]] == ["Docs"]
    d = a.fs_list("/Docs")
    assert d["parent"] == "/"
    assert [(e["name"], e["dir"], e["size"]) for e in d["entries"]] == [("Sub", True, 0), ("a.txt", False, 3)]
    assert pytest.raises(DriveError, a.fs_list, "/nope").value.status == 404
    assert pytest.raises(DriveError, a.fs_list, "/Docs/a.txt").value.status == 400


def test_onedrive_read_uses_download_url_without_bearer(db, monkeypatch):
    a, fake = _odrive(db, monkeypatch)
    assert a.read_bytes("/Docs/a.txt") == (b"abc", "a.txt")
    assert fake.download_headers and "Authorization" not in fake.download_headers[0]
    assert pytest.raises(DriveError, a.read_bytes, "/Docs").value.status == 400


def test_onedrive_upload_mkdir_rename_delete(db, monkeypatch):
    a, fake = _odrive(db, monkeypatch)
    r = a.upload("/Docs", [("up.bin", b"xyz")])
    assert r["uploaded"] == [{"name": "up.bin", "size": 3, "path": "/Docs/up.bin"}]
    assert fake.tree["/Docs/up.bin"]["content"] == b"xyz"
    assert a.mkdir("/Docs", "Reports") == {"created": "/Docs/Reports"}
    assert pytest.raises(DriveError, a.mkdir, "/Docs", "Sub").value.status == 502  # 409 → vendor failure
    assert a.rename("/Docs/a.txt", "c.txt") == {"renamed": "/Docs/c.txt"}
    assert "/Docs/c.txt" in fake.tree
    assert a.delete("/Docs/c.txt") == {"deleted": "/Docs/c.txt", "trash": "onedrive"}
    assert "/Docs/c.txt" not in fake.tree


def test_onedrive_zip_is_client_side(db, monkeypatch):
    a, fake = _odrive(db, monkeypatch)
    data, name = a.build_zip("/Docs", ["Sub"])
    assert name == "Sub.zip"
    with zipfile.ZipFile(BytesIO(data)) as z:
        assert z.namelist() == ["Sub/b.md"]
    assert a.compress("/Docs", ["a.txt", "Sub"], "") == {"created": "/Docs/Archive.zip"}
    with zipfile.ZipFile(BytesIO(fake.tree["/Docs/Archive.zip"]["content"])) as z:
        assert sorted(z.namelist()) == ["Sub/b.md", "a.txt"]


def test_onedrive_refresh_rotates_token_publicly(db, monkeypatch):
    a, fake = _odrive(db, monkeypatch)
    a.config["token_expiry"] = 0
    assert a._access_token() == "AT1"
    assert "client_secret" not in fake.refresh_forms[0]
    assert a.config["refresh_token"] == "RT1"   # Microsoft rotates it — the new one is kept


def test_onedrive_status(db, monkeypatch):
    a, _ = _odrive(db, monkeypatch)
    assert a.status() == {"ok": True, "account": "ram@outlook.test"}
