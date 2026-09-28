"""viewer.drives — cloud drives: the third leg of the file layer.

The file routes (routes/fs.py) dispatch every op on a *location*: nothing
given → local Path ops, `host` → remote.py (SSH/SFTP), `drive` → a cloud
adapter here. A drive is a cloud account (Google Drive, Dropbox, OneDrive)
held as one Postgres row (db.drives_load): the OAuth tokens and the plugin
lifecycle (active|paused, hidden). The bytes live on the vendor — the
viewer talks to the vendor's REST API directly: no rclone, no mounts, no OS
layer, so a drive works wherever the viewer runs.

Shape: adding a vendor = implement BaseDrive (the nine methods the fs
routes already call, with the same response shapes the local/SSH legs
produce) and add one ADAPTERS entry. Nothing else — the app, the MCP layer,
the routes — learns the vendor's name; they address drives by id through
adapter_for(). The three built adapters share _OAuthDrive: one token
lifecycle (cached access token → refresh grant → persist; a 401 forces one
refresh + retry) and one client-side zip walker over vendor-neutral nodes.

Vendor facts, VERIFIED against the primary docs on 2026-09-19, 2026-09-26
and 2026-09-27 (the date of each fact's last check is what the adapters
were built against):
  google   : Drive v3, id-addressed (paths are walked one segment at a
             time). Web authorization-code flow only. The `drive` scope is
             restricted: an unverified app shows a warning and is capped
             at 100 users; refresh tokens of a TESTING-mode project expire
             in 7 days (this client's project is in production). Uploads:
             multipart with a metadata part so the file gets its NAME.
             (developers.google.com/workspace/drive/api/guides/
             api-specific-auth, /identity/protocols/oauth2)
  dropbox  : path-addressed RPC (api.dropboxapi.com/2, JSON body; root is
             the EMPTY string) + content endpoints (content.dropboxapi.com/
             2, args in the Dropbox-API-Arg header, non-ASCII \\uXXXX
             escaped). PKCE S256 is the public-client flow: the token
             request carries code_verifier INSTEAD OF a client secret. A
             refresh_token is issued ONLY when the authorize URL carries
             token_access_type=offline; approval stays valid until revoked.
             redirect_uri must EXACTLY match one registered in the App
             Console — the viewer's https callback (drive_oauth.
             CALLBACK_PATH on the public origin). files/upload ≤150 MB per call; files/download_zip
             zips ONE folder server-side (<20 GB, <4 GB per file, <10,000
             entries). delete_v2 moves to the Dropbox trash. Path errors
             come back as 409 with an error_summary such as
             path/not_found/.. [2026-09-27]
             (docs.dropboxapi.com/dropbox-api/docs/get-started/
             authorization, /api-reference/user-endpoints/files/*)
  onedrive : Microsoft Graph v1.0, path-addressed via /me/drive/root:/
             {path}: (root children at /me/drive/root/children). Personal
             accounts through the /consumers tenant. PKCE public client
             ("Allow public client flows" on the app registration) with the
             viewer's https callback registered as a Web redirect URI (https
             is valid on every platform; a URI without a path gets a
             trailing slash appended, ours has one). Refresh tokens need the offline_access scope,
             default 90-day lifetime, rotated on every refresh (store the
             new one), revocable any time → re-authorize. Download: GET
             /content answers 302 to a pre-authenticated URL — we read the
             item's @microsoft.graph.downloadUrl and fetch it WITHOUT the
             bearer header instead (urllib would forward our Authorization
             header across the redirect). Simple PUT /content ≤250 MB;
             DELETE → recycle bin; mkdir POST /children with
             conflictBehavior=fail. No folder-zip API — zips are built
             client-side. [2026-09-27]
             (learn.microsoft.com/entra/identity-platform/reply-url,
             /v2-oauth2-auth-code-flow, /refresh-tokens; /graph/api/
             driveitem-*)
"""

import datetime
import io
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from viewer import db


class DriveError(Exception):
    """An adapter failure. `status` is the HTTP status the fs route answers
    with: 400 bad request, 403 lifecycle refusal (paused/hidden), 404 not
    found, 501 the vendor can't, 502 the vendor failed."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


class BaseDrive:
    """The surface a cloud drive must implement. Every method's signature
    and return shape mirrors the local/SSH legs of routes/fs.py exactly, so
    the routes can treat a drive like a host:

      fs_list(path, show_hidden)  → {"path","parent","entries":[...],"truncated"}
      read_bytes(path)            → (bytes, name)        (size-capped)
      upload(path, files)         → {"uploaded":[...]}   files = [(name, bytes)]
      mkdir(path, name)           → {"created"}
      rename(path, name)          → {"renamed"}          (within the same parent)
      delete(path)               → {"deleted","trash"}  → the vendor's TRASH
      compress(path, names, arc) → {"created"}
      build_zip(path, names)     → (bytes, name)        (route streams + deletes)
      status()                   → {"ok","account","error"?}
    """

    kind = ""
    caps = {}  # {"list": True, ...} — which ops this vendor does; the UI
    # hides the rest.

    def __init__(self, drive):
        """`drive` is a row from db.drives_load(): {id,label,kind,config,
        status,hidden,created_at}."""
        self.drive = drive
        self.config = drive.get("config") or {}

    def fs_list(self, path, show_hidden=False):
        raise DriveError("not supported", 501)

    def read_bytes(self, path):
        raise DriveError("not supported", 501)

    def upload(self, path, files):
        raise DriveError("not supported", 501)

    def mkdir(self, path, name):
        raise DriveError("not supported", 501)

    def rename(self, path, name):
        raise DriveError("not supported", 501)

    def delete(self, path):
        raise DriveError("not supported", 501)

    def compress(self, path, names, archive):
        raise DriveError("not supported", 501)

    def build_zip(self, path, names):
        raise DriveError("not supported", 501)

    def status(self):
        return {"ok": True, "account": self.config.get("account") or ""}


def _http(method, url, headers=None, data=None, timeout=60):
    """One stdlib HTTP call (the single network seam every adapter shares, so a
    test can monkeypatch it and drive an adapter with canned vendor responses —
    no socket, no network). Returns (status, header_dict, body_bytes). An HTTP
    error status is RETURNED, not raised — the caller maps it to a DriveError.
    Only a hard transport failure (no route to the vendor) raises, as 502."""
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read()
    except DriveError:
        raise
    except Exception as e:
        raise DriveError(f"Vendor unreachable: {e}", 502)


def _vendor_client(kind, public=False):
    """The viewer's OAuth client for `kind` — ONE shared client per vendor
    (per-user tokens live in the drive row), stored in settings['drive_clients']
    and entered from the app's Integrations dialog. Shared by the adapters
    (token refresh) and the hosted OAuth flow (drive_oauth). A `public` client
    (PKCE — Dropbox, OneDrive) needs only client_id; a confidential one
    (Google) needs the secret too. Missing or incomplete → 403 with guidance,
    so a first run says exactly what to do instead of failing opaquely."""
    c = db.drive_client_get(kind) or {}
    if not c.get("client_id"):
        raise DriveError(f"No {kind} OAuth client configured — add its client id in Integrations", 403)
    if not public and not c.get("client_secret"):
        raise DriveError(f"{kind} OAuth client is incomplete — add its client secret in Integrations", 403)
    return c


class _OAuthDrive(BaseDrive):
    """What the three OAuth-backed adapters share, so a vendor adapter is only
    its REST dialect:

    Tokens — config holds {account, access_token, refresh_token, token_expiry}.
    _access_token() serves the cached token until 60 s before expiry, else
    runs the refresh grant at _TOKEN and persists the new token(s) to the
    drive row. A refresh failure is a normal lifecycle event (revoked,
    password change, unused token pruned) surfaced as a 403 the UI turns into
    a one-click re-authorize. _req() adds the bearer and, on a 401, forces one
    refresh + retry.

    Paths — the routes speak POSIX-ish paths; _norm/_parent_path/_join are
    the one path grammar every vendor maps onto its own addressing.

    Zip — _zip() builds a real zip in memory by walking vendor-neutral NODES:
    a subclass answers _node(path) → (node, is_dir), _node_children(node) →
    [(child_node, name, is_dir)] and _node_read(node) → bytes. Google's node
    is a file id, Dropbox's a path, OneDrive's an item dict.
    """

    _TOKEN = ""          # the vendor's token endpoint (refresh grant)
    _PUBLIC = False      # PKCE public client → no client_secret anywhere
    caps = {"list": True, "read": True, "upload": True, "mkdir": True,
            "rename": True, "delete": True, "compress": True, "zip": True}

    # ---- tokens -----------------------------------------------------------

    def _client(self):
        return _vendor_client(self.kind, public=self._PUBLIC)

    def _access_token(self):
        cfg = self.config
        at, exp = cfg.get("access_token"), cfg.get("token_expiry") or 0
        if at and time.time() < exp - 60:
            return at
        if not cfg.get("refresh_token"):
            raise DriveError("Drive is not authorized — run the sign-in flow", 403)
        return self._refresh()

    def _refresh(self):
        client = self._client()
        form = {
            "grant_type": "refresh_token",
            "refresh_token": self.config.get("refresh_token"),
            "client_id": client["client_id"],
        }
        if client.get("client_secret"):
            form["client_secret"] = client["client_secret"]
        status, _, body = _http("POST", self._TOKEN,
                                headers={"Content-Type": "application/x-www-form-urlencoded"},
                                data=urllib.parse.urlencode(form).encode())
        if status != 200:
            # Revoked or expired refresh token → the owner must re-consent.
            raise DriveError(f"{self.kind} authorization expired — re-authorize this drive", 403)
        j = json.loads(body)
        self.config["access_token"] = j["access_token"]
        self.config["refresh_token"] = j.get("refresh_token") or self.config.get("refresh_token")
        self.config["token_expiry"] = time.time() + int(j.get("expires_in") or 3600)
        db.drive_upsert(self.drive["id"], self.drive)
        return j["access_token"]

    def _req(self, method, url, data=None, headers=None):
        """An authenticated request. Adds the Bearer token; on a 401 (stale
        token) it forces a refresh and retries exactly once."""
        h = {"Authorization": "Bearer " + self._access_token()}
        if headers:
            h.update(headers)
        status, _, body = _http(method, url, headers=h, data=data)
        if status == 401:
            self.config["token_expiry"] = 0
            h = {"Authorization": "Bearer " + self._access_token()}
            if headers:
                h.update(headers)
            status, _, body = _http(method, url, headers=h, data=data)
        return status, body

    # ---- path grammar -----------------------------------------------------

    @staticmethod
    def _norm(path):
        p = (path or "~").strip().replace("\\", "/")
        if p in ("", "~", "/", "~/"):
            return "/"
        if p.startswith("~"):
            p = p[1:]
        if not p.startswith("/"):
            p = "/" + p
        return "/" + "/".join(s for s in p.split("/") if s)

    @staticmethod
    def _parent_path(path):
        p = path if path.startswith("/") else "/" + path
        if p in ("/", "~"):
            return None
        parent = p.rsplit("/", 1)[0]
        return parent if parent else "/"

    @staticmethod
    def _join(path, name):
        p = path if path.startswith("/") else "/" + path
        return (p + "/" + name) if p != "/" else "/" + name

    @staticmethod
    def _ts(s):
        if not s:
            return 0
        try:
            dt = datetime.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc)
            return dt.timestamp()
        except Exception:
            return 0

    def _listing(self, path, entries, truncated):
        p = self._norm(path)
        return {"path": p, "parent": self._parent_path(p), "entries": entries,
                "home": "/", "truncated": truncated}

    # ---- zip over vendor-neutral nodes -------------------------------------

    def _node(self, path):
        raise NotImplementedError

    def _node_children(self, node):
        raise NotImplementedError

    def _node_read(self, node):
        raise NotImplementedError

    @staticmethod
    def _arcname(names, archive):
        arc = (archive or "").strip()
        arcname = arc if arc else (names[0] + ".zip" if len(names) == 1 else "Archive.zip")
        return arcname if arcname.endswith(".zip") else arcname + ".zip"

    def _zip(self, path, names, archive):
        arcname = self._arcname(names, archive)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for n in names:
                node, is_dir = self._node(self._join(path, n))
                self._zip_node(z, node, is_dir, n)
        return buf.getvalue(), arcname

    def _zip_node(self, z, node, is_dir, prefix):
        if not is_dir:
            z.writestr(prefix, self._node_read(node))
            return
        for child, name, cdir in self._node_children(node):
            self._zip_node(z, child, cdir, f"{prefix}/{name}")

    def build_zip(self, path, names):
        return self._zip(path, names, None)

    def compress(self, path, names, archive):
        data, arcname = self._zip(path, names, archive)
        self._put_file(path, arcname, data)
        return {"created": self._join(path, arcname)}

    def _put_file(self, folder, name, data):
        """Store `data` as `name` inside `folder` (the compress leg). Raises
        DriveError; the vendor's single-call size cap applies."""
        raise NotImplementedError

    # ---- account ----------------------------------------------------------

    def whoami(self):
        """The signed-in account's e-mail (or login name) — stored into config
        by the consent flow so the picker can say WHOSE drive this is."""
        raise NotImplementedError

    def status(self):
        account = self.config.get("account") or ""
        if not self.config.get("refresh_token"):
            return {"ok": False, "account": account, "error": "not authorized"}
        try:
            return {"ok": True, "account": self.whoami() or account}
        except DriveError as e:
            return {"ok": False, "account": account, "error": str(e)}


class GoogleDrive(_OAuthDrive):
    """Google Drive v3 adapter (Phase 2). The vendor addresses files by id, but
    the fs routes and UI speak paths, so a path like /a/b/c.docx is resolved by
    walking from the root folder one segment at a time. Every method returns the
    exact shape the local/SSH legs produce (see the BaseDrive contract above).

    Refresh-token lifetime: only *testing-mode* GCP projects cap the restricted
    `drive` scope at 7 days. The shared client here belongs to a project in
    production (its calendar/gmail tokens carry no refresh_token_expires_in
    since 2026-09-08), so the token lives until revoked.
    """

    kind = "google"
    _TOKEN = "https://oauth2.googleapis.com/token"
    _API = "https://www.googleapis.com/drive/v3"
    _UPLOAD = "https://www.googleapis.com/upload/drive/v3"
    _FOLDER = "application/vnd.google-apps.folder"

    def __init__(self, drive):
        super().__init__(drive)
        self._meta_cache = {}  # id -> metadata, memoized for one request
        self._root_id = ""     # the root folder id, memoized

    # ---- transport --------------------------------------------------------

    def _get_json(self, path):
        status, body = self._req("GET", self._API + path)
        return self._decode(status, body)

    def _post_json(self, path, body):
        status, r = self._req("POST", self._API + path,
                              data=json.dumps(body).encode(),
                              headers={"Content-Type": "application/json"})
        return self._decode(status, r)

    def _patch_json(self, path, body):
        status, r = self._req("PATCH", self._API + path,
                              data=json.dumps(body).encode(),
                              headers={"Content-Type": "application/json"})
        return self._decode(status, r)

    def _decode(self, status, body):
        """Decode a JSON vendor response; an error status raises a DriveError
        with Google's message and a mapped status."""
        if status == 200:
            return json.loads(body)
        msg = self._msg(status, body)
        if status in (400, 403, 404):
            raise DriveError(msg, status)
        if status == 429:
            raise DriveError("Google is rate-limiting right now — try again shortly", 502)
        raise DriveError(msg, 502)

    def _msg(self, status, body):
        """The vendor error message, or a bare HTTP code — for per-file results
        where one bad file must not abort the whole batch. One case is
        rewritten: consent succeeds even when the Drive API is switched off in
        the owner's Google Cloud project, and the first listing then fails with
        a wall of console prose. That is a setup step, so say it as one."""
        try:
            err = json.loads(body).get("error") or {}
        except Exception:
            return f"HTTP {status}"
        reasons = {e.get("reason") for e in err.get("errors") or [] if isinstance(e, dict)}
        if "accessNotConfigured" in reasons or "Drive API has not been used" in (err.get("message") or ""):
            return ("The Google Drive API is turned off in the Google Cloud project that owns this OAuth client. "
                    "Open console.cloud.google.com → APIs & Services → Library → Google Drive API → Enable, "
                    "then pull to refresh (Google can take a minute to apply it).")
        return err.get("message") or f"HTTP {status}"

    # ---- path model -------------------------------------------------------

    def _root(self):
        if not self._root_id:
            r = self._get_json("/files/root?fields=id,name,mimeType")
            self._root_id = r["id"]
        return self._root_id

    def _meta(self, fid):
        if fid not in self._meta_cache:
            self._meta_cache[fid] = self._get_json(f"/files/{fid}?fields=id,name,mimeType,size,modifiedTime")
        return self._meta_cache[fid]

    def _child(self, parent_id, name, folder=False):
        """The id of a direct child of `parent_id` named `name` (or None). When
        several share a name, prefer a folder if one is required, else the
        lowest id — deterministic."""
        q = f"'{parent_id}' in parents and name = '{name.replace(chr(39), chr(39) * 2)}' and trashed = false"
        j = self._get_json(f"/files?q={urllib.parse.quote(q)}&fields=files(id,name,mimeType)&pageSize=20")
        cands = j.get("files") or []
        if folder:
            dirs = [c for c in cands if c.get("mimeType") == self._FOLDER]
            cands = dirs or cands
        if not cands:
            return None
        cands.sort(key=lambda c: (c.get("mimeType") != self._FOLDER, c.get("id", "")))
        return cands[0]["id"]

    def _resolve(self, path):
        """(id, is_dir, name) for a path. `~`/`/`/empty → the root folder;
        otherwise walk from root, requiring each non-final segment to be a
        folder (a path to a file whose prefix names a file is a 404)."""
        p = self._norm(path)
        if p == "/":
            return self._root(), True, "/"
        segs = [s for s in p.split("/") if s]
        cur = self._root()
        name, is_dir = "/", True
        for i, seg in enumerate(segs):
            # Every segment but the last must be a folder; the last may be a file.
            fid = self._child(cur, seg, folder=(i < len(segs) - 1))
            if fid is None:
                raise DriveError(f"Path segment not found: {seg}", 404)
            m = self._meta(fid)
            name, is_dir = m.get("name") or seg, m.get("mimeType") == self._FOLDER
            cur = fid
        return cur, is_dir, name

    def _list_dir(self, fid):
        q = f"'{fid}' in parents and trashed = false"
        j = self._get_json(f"/files?q={urllib.parse.quote(q)}&fields=files(id,name,mimeType)&pageSize=1000")
        return [(f["id"], f["name"], f.get("mimeType") == self._FOLDER) for f in (j.get("files") or [])]

    def _read_raw(self, fid):
        status, body = self._req("GET", f"{self._API}/files/{fid}?alt=media")
        if status != 200:
            raise DriveError(self._msg(status, body), 502)
        return body

    def _upload(self, parent_id, name, mime, data):
        """Create a file with a NAME via multipart/related. A bare media upload
        would leave the file unnamed (Drive assigns a random name), which would
        make every `created`/`path` we report a lie — so the metadata part always
        carries the name and MIME type. Returns the created file resource."""
        boundary = "harman-" + secrets.token_hex(16)
        # `parents` rides in the metadata part, like every File field: as a
        # URL query it is silently ignored and the file lands in the root.
        meta = json.dumps({"name": name, "mimeType": mime, "parents": [parent_id]}).encode()
        body = (
            f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
            + meta.decode()
            + f"\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n"
        ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
        url = f"{self._UPLOAD}/files?uploadType=multipart&fields=id,name,parents"
        status, r = self._req("POST", url, data=body,
                              headers={"Content-Type": f"multipart/related; boundary={boundary}"})
        if status != 200:
            raise DriveError(self._msg(status, r), 502)
        return json.loads(r)

    # ---- zip nodes (a node is a file id) ---------------------------------

    def _node(self, path):
        fid, is_dir, _ = self._resolve(path)
        return fid, is_dir

    def _node_children(self, node):
        return self._list_dir(node)

    def _node_read(self, node):
        return self._read_raw(node)

    def _put_file(self, folder, name, data):
        pid, is_dir, _ = self._resolve(folder)
        if not is_dir:
            raise DriveError("Target is not a folder", 400)
        self._upload(pid, name, "application/zip" if name.endswith(".zip") else "application/octet-stream", data)

    # ---- the operations ---------------------------------------------------

    def fs_list(self, path, show_hidden=False):
        fid, is_dir, _ = self._resolve(path)
        if not is_dir:
            raise DriveError("Path is a file, not a folder", 400)
        q = f"'{fid}' in parents and trashed = false"
        j = self._get_json(
            f"/files?q={urllib.parse.quote(q)}"
            "&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=1000&orderBy=name_natural")
        entries, truncated = [], False
        for f in (j.get("files") or []):
            name = f.get("name") or ""
            if not show_hidden and name.startswith("."):
                continue
            if len(entries) >= 800:
                truncated = True
                break
            entries.append({
                "name": name,
                "dir": f.get("mimeType") == self._FOLDER,
                "size": int(f.get("size") or 0),
                "mtime": self._ts(f.get("modifiedTime")),
            })
        return self._listing(path, entries, truncated)

    def read_bytes(self, path):
        fid, is_dir, name = self._resolve(path)
        if is_dir:
            raise DriveError("Path is a folder — download it as a zip instead", 400)
        return self._read_raw(fid), name

    def upload(self, path, files):
        pid, is_dir, _ = self._resolve(path)
        if not is_dir:
            raise DriveError("Upload target is not a folder", 400)
        uploaded = []
        for name, content in files:
            try:
                self._upload(pid, name, "application/octet-stream", content)
                uploaded.append({"name": name, "size": len(content), "path": self._join(path, name)})
            except DriveError as e:
                uploaded.append({"name": name, "error": str(e)})
        return {"uploaded": uploaded}

    def mkdir(self, path, name):
        pid, is_dir, _ = self._resolve(path)
        if not is_dir:
            raise DriveError("Parent is not a folder", 400)
        self._post_json("/files?fields=id,name",
                        {"name": name, "mimeType": self._FOLDER, "parents": [pid]})
        return {"created": self._join(path, name)}

    def rename(self, path, name):
        fid, _, _ = self._resolve(path)
        self._patch_json(f"/files/{fid}", {"name": name})
        return {"renamed": self._join(self._parent_path(self._norm(path)) or "/", name)}

    def delete(self, path):
        fid, _, _ = self._resolve(path)
        self._post_json(f"/files/{fid}/trash?fields=id", {})
        return {"deleted": self._norm(path), "trash": "google-drive"}

    def whoami(self):
        j = self._get_json("/about?fields=user(emailAddress)")
        return (j.get("user") or {}).get("emailAddress") or ""


class DropboxDrive(_OAuthDrive):
    """Dropbox adapter (Phase 3). Path-addressed: the vendor speaks the same
    /a/b/c paths the routes do, with the root spelled as the empty string.
    Metadata ops are JSON RPC on api.dropboxapi.com; bytes move through
    content.dropboxapi.com with the arguments in the Dropbox-API-Arg header.
    A public PKCE client — no client secret exists for this vendor."""

    kind = "dropbox"
    _PUBLIC = True
    _TOKEN = "https://api.dropboxapi.com/oauth2/token"
    _API = "https://api.dropboxapi.com/2"
    _CONTENT = "https://content.dropboxapi.com/2"
    _UPLOAD_CAP = 150 * 1024 * 1024   # files/upload single-call limit

    # ---- transport --------------------------------------------------------

    @staticmethod
    def _dbx(path):
        """Our normalized path in Dropbox's spelling (root = "")."""
        p = _OAuthDrive._norm(path)
        return "" if p == "/" else p

    def _rpc(self, endpoint, arg):
        status, body = self._req("POST", f"{self._API}/{endpoint}",
                                 data=json.dumps(arg).encode(),
                                 headers={"Content-Type": "application/json"})
        return self._decode(status, body)

    def _content(self, endpoint, arg, data=None):
        """A content endpoint call: args ride in the header (json.dumps'
        default ensure_ascii gives the \\uXXXX escaping the header needs)."""
        headers = {"Dropbox-API-Arg": json.dumps(arg)}
        if data is not None:
            headers["Content-Type"] = "application/octet-stream"
        status, body = self._req("POST", f"{self._CONTENT}/{endpoint}", data=data, headers=headers)
        if status != 200:
            raise self._error(status, body)
        return body

    def _decode(self, status, body):
        if status == 200:
            return json.loads(body) if body else {}
        raise self._error(status, body)

    @staticmethod
    def _error(status, body):
        """Dropbox reports endpoint errors as 409 + error_summary (e.g.
        'path/not_found/..', 'to/conflict/folder/...'); map the summaries
        the UI acts on to 404/400, everything else to the vendor's own
        status or 502."""
        summary, user_msg = "", ""
        try:
            j = json.loads(body)
            summary = j.get("error_summary") or ""
            user_msg = (j.get("user_message") or {}).get("text") if isinstance(j.get("user_message"), dict) else (j.get("user_message") or "")
        except Exception:
            pass
        msg = user_msg or summary or f"Dropbox returned HTTP {status}"
        if status == 409:
            if "not_found" in summary:
                return DriveError("Path not found", 404)
            if "not_folder" in summary:
                return DriveError("Path is a file, not a folder", 400)
            if "not_file" in summary:
                return DriveError("Path is a folder — download it as a zip instead", 400)
            if "conflict" in summary:
                return DriveError("A file or folder with that name already exists", 400)
            return DriveError(msg, 400)
        if status in (400, 403):
            return DriveError(msg, status)
        if status == 429:
            return DriveError("Dropbox is rate-limiting right now — try again shortly", 502)
        return DriveError(msg, 502)

    # ---- listing ----------------------------------------------------------

    def _entries(self, path):
        """Every entry of a folder, following the cursor until has_more is
        false. Raises 400 when `path` is a file, 404 when it is missing."""
        j = self._rpc("files/list_folder", {"path": self._dbx(path), "include_deleted": False, "limit": 1000})
        out = list(j.get("entries") or [])
        while j.get("has_more"):
            j = self._rpc("files/list_folder/continue", {"cursor": j["cursor"]})
            out.extend(j.get("entries") or [])
        return out

    def _metadata(self, path):
        return self._rpc("files/get_metadata", {"path": self._dbx(path)})

    # ---- zip nodes (a node is a path) -------------------------------------

    def _node(self, path):
        m = self._metadata(path)
        return self._norm(path), m.get(".tag") == "folder"

    def _node_children(self, node):
        return [(self._join(node, e["name"]), e["name"], e.get(".tag") == "folder")
                for e in self._entries(node)]

    def _node_read(self, node):
        return self._content("files/download", {"path": self._dbx(node)})

    def _put_file(self, folder, name, data):
        if len(data) > self._UPLOAD_CAP:
            raise DriveError("File is over 150 MB — Dropbox's single-call upload cap", 400)
        self._content("files/upload",
                      {"path": self._join(self._norm(folder), name), "mode": "add", "autorename": False},
                      data=data)

    # ---- the operations ---------------------------------------------------

    def fs_list(self, path, show_hidden=False):
        entries, truncated = [], False
        rows = sorted(self._entries(path), key=lambda e: (e.get(".tag") != "folder", (e.get("name") or "").lower()))
        for e in rows:
            name = e.get("name") or ""
            if not show_hidden and name.startswith("."):
                continue
            if len(entries) >= 800:
                truncated = True
                break
            entries.append({
                "name": name,
                "dir": e.get(".tag") == "folder",
                "size": int(e.get("size") or 0),
                "mtime": self._ts(e.get("server_modified")),
            })
        return self._listing(path, entries, truncated)

    def read_bytes(self, path):
        p = self._norm(path)
        if p == "/":
            raise DriveError("Path is a folder — download it as a zip instead", 400)
        return self._content("files/download", {"path": p}), p.rsplit("/", 1)[-1]

    def upload(self, path, files):
        uploaded = []
        for name, content in files:
            try:
                self._put_file(path, name, content)
                uploaded.append({"name": name, "size": len(content), "path": self._join(self._norm(path), name)})
            except DriveError as e:
                uploaded.append({"name": name, "error": str(e)})
        return {"uploaded": uploaded}

    def mkdir(self, path, name):
        target = self._join(self._norm(path), name)
        self._rpc("files/create_folder_v2", {"path": target, "autorename": False})
        return {"created": target}

    def rename(self, path, name):
        p = self._norm(path)
        if p == "/":
            raise DriveError("The root folder cannot be renamed", 400)
        target = self._join(self._parent_path(p) or "/", name)
        self._rpc("files/move_v2", {"from_path": p, "to_path": target, "autorename": False})
        return {"renamed": target}

    def delete(self, path):
        p = self._norm(path)
        if p == "/":
            raise DriveError("The root folder cannot be deleted", 400)
        self._rpc("files/delete_v2", {"path": p})
        return {"deleted": p, "trash": "dropbox"}

    def build_zip(self, path, names):
        """One folder → the vendor zips it server-side (files/download_zip:
        <20 GB, <10,000 entries); anything else is built client-side."""
        if len(names) == 1:
            target = self._join(self._norm(path), names[0])
            if self._metadata(target).get(".tag") == "folder":
                return self._content("files/download_zip", {"path": target}), names[0] + ".zip"
        return self._zip(path, names, None)

    def whoami(self):
        j = self._rpc("users/get_current_account", None)
        return j.get("email") or ""


class OneDriveDrive(_OAuthDrive):
    """OneDrive adapter (Phase 3) over Microsoft Graph v1.0, personal
    accounts (the /consumers tenant). Path-addressed with Graph's
    `root:/{path}:` grammar, so no id walk is needed; item ids appear only
    inside responses. A public PKCE client — no client secret."""

    kind = "onedrive"
    _PUBLIC = True
    _TOKEN = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"
    _GRAPH = "https://graph.microsoft.com/v1.0"
    _API = _GRAPH + "/me/drive"
    _UPLOAD_CAP = 250 * 1024 * 1024   # simple PUT /content limit
    _SELECT = "$select=id,name,size,lastModifiedDateTime,folder,file"

    # ---- transport --------------------------------------------------------

    @staticmethod
    def _item(path):
        """The Graph address of a path: /root for the root, else
        /root:/{url-encoded path}: — both accept a /children or /content
        suffix by plain concatenation."""
        p = _OAuthDrive._norm(path)
        return "/root" if p == "/" else "/root:" + urllib.parse.quote(p, safe="/") + ":"

    def _call(self, method, url, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        h = dict(headers or {})
        if data is not None:
            h["Content-Type"] = "application/json"
        status, raw = self._req(method, url, data=data, headers=h)
        return self._decode(status, raw)

    def _decode(self, status, body):
        if 200 <= status < 300:
            return json.loads(body) if body else {}
        msg = f"OneDrive returned HTTP {status}"
        try:
            msg = (json.loads(body).get("error") or {}).get("message") or msg
        except Exception:
            pass
        if status in (400, 403, 404):
            raise DriveError(msg, status)
        if status == 429:
            raise DriveError("OneDrive is rate-limiting right now — try again shortly", 502)
        raise DriveError(msg, 502)

    def _children(self, path):
        """Every child of a folder, following @odata.nextLink. Graph answers
        400 for /children on a file, which _decode passes through as 400."""
        url = f"{self._API}{self._item(path)}/children?{self._SELECT}&$top=1000"
        out = []
        while url:
            j = self._call("GET", url)
            out.extend(j.get("value") or [])
            url = j.get("@odata.nextLink")
        return out

    def _meta(self, path):
        return self._call("GET", f"{self._API}{self._item(path)}")

    def _download(self, meta):
        """Fetch a file's bytes through its pre-authenticated download URL —
        deliberately WITHOUT the bearer header (that URL is unauthenticated,
        and urllib would otherwise forward our token across the 302)."""
        url = meta.get("@microsoft.graph.downloadUrl")
        if not url:
            raise DriveError("OneDrive did not offer a download URL for this file", 502)
        status, _, body = _http("GET", url)
        if status != 200:
            raise DriveError(f"OneDrive download failed (HTTP {status})", 502)
        return body

    # ---- zip nodes (a node is an item's metadata) -------------------------

    def _node(self, path):
        m = self._meta(path)
        m["_path"] = self._norm(path)
        return m, "folder" in m

    def _node_children(self, node):
        out = []
        for c in self._children(node["_path"]):
            c["_path"] = self._join(node["_path"], c["name"])
            out.append((c, c["name"], "folder" in c))
        return out

    def _node_read(self, node):
        return self._download(node)

    def _put_file(self, folder, name, data):
        if len(data) > self._UPLOAD_CAP:
            raise DriveError("File is over 250 MB — OneDrive's simple-upload cap", 400)
        target = self._item(self._join(self._norm(folder), name))
        status, body = self._req("PUT", f"{self._API}{target}/content", data=data,
                                 headers={"Content-Type": "application/octet-stream"})
        self._decode(status, body)

    # ---- the operations ---------------------------------------------------

    def fs_list(self, path, show_hidden=False):
        entries, truncated = [], False
        rows = sorted(self._children(path), key=lambda c: ("folder" not in c, (c.get("name") or "").lower()))
        for c in rows:
            name = c.get("name") or ""
            if not show_hidden and name.startswith("."):
                continue
            if len(entries) >= 800:
                truncated = True
                break
            entries.append({
                "name": name,
                "dir": "folder" in c,
                "size": int(c.get("size") or 0),
                "mtime": self._ts(c.get("lastModifiedDateTime")),
            })
        return self._listing(path, entries, truncated)

    def read_bytes(self, path):
        m = self._meta(path)
        if "folder" in m:
            raise DriveError("Path is a folder — download it as a zip instead", 400)
        return self._download(m), m.get("name") or self._norm(path).rsplit("/", 1)[-1]

    def upload(self, path, files):
        uploaded = []
        for name, content in files:
            try:
                self._put_file(path, name, content)
                uploaded.append({"name": name, "size": len(content), "path": self._join(self._norm(path), name)})
            except DriveError as e:
                uploaded.append({"name": name, "error": str(e)})
        return {"uploaded": uploaded}

    def mkdir(self, path, name):
        self._call("POST", f"{self._API}{self._item(path)}/children",
                   {"name": name, "folder": {}, "@microsoft.graph.conflictBehavior": "fail"})
        return {"created": self._join(self._norm(path), name)}

    def rename(self, path, name):
        p = self._norm(path)
        if p == "/":
            raise DriveError("The root folder cannot be renamed", 400)
        self._call("PATCH", f"{self._API}{self._item(p)}", {"name": name})
        return {"renamed": self._join(self._parent_path(p) or "/", name)}

    def delete(self, path):
        p = self._norm(path)
        if p == "/":
            raise DriveError("The root folder cannot be deleted", 400)
        self._call("DELETE", f"{self._API}{self._item(p)}")
        return {"deleted": p, "trash": "onedrive"}

    def whoami(self):
        j = self._call("GET", f"{self._GRAPH}/me?$select=mail,userPrincipalName")
        return j.get("mail") or j.get("userPrincipalName") or ""


# kind → adapter class. The ONLY place vendor names exist in the backend.
ADAPTERS = {
    "google": GoogleDrive,
    "dropbox": DropboxDrive,
    "onedrive": OneDriveDrive,
}


def adapter_for(drive_id):
    """Resolve a drive id to a live adapter, enforcing the plugin lifecycle.
    Unknown id → 404; hidden → 403; paused → 403; unknown kind → 501. This
    is the single choke point every file route passes through for a drive —
    pause or hide a drive and it stops working everywhere at once."""
    drive = db.drive_get(drive_id)
    if drive is None:
        raise DriveError(f"Unknown drive {drive_id!r}", 404)
    if drive["hidden"]:
        raise DriveError(f"Drive {drive_id!r} is hidden", 403)
    if drive["status"] != "active":
        raise DriveError(f"Drive {drive_id!r} is {drive['status']}", 403)
    cls = ADAPTERS.get(drive["kind"])
    if cls is None:
        raise DriveError(f"No adapter for drive kind {drive['kind']!r}", 501)
    return cls(drive)
