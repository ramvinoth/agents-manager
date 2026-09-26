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
adapter_for().

Vendor facts. VERIFIED against the primary docs 2026-09-19, RE-VERIFIED
against the same primary docs 2026-09-26 (card #32 comment 19 required a
recheck before resuming; the recheck corrected two entries — marked ✗):
  google   : an unverified app using sensitive scopes (e.g. `drive`) shows
             an "unverified app" warning before the consent screen and is
             capped at 100 NEW users; verification is only required before
             a public launch, and an internal/personal use case is exempt.
             For a single-owner self-hosted app that is just a warning.
             Web (authorization-code) flow only — no device flow for
             Drive. (support.google.com/cloud/answer/7454865)
             [2026-09-26] Scopes are tiered (api-specific-auth, updated
             2026-09-03): non-sensitive (drive.appdata, drive.appfolder,
             drive.file, drive.install), sensitive (drive.apps.readonly),
             restricted (drive, drive.readonly, drive.activity.*, …).
             drive.file = per-file, shared ONLY through the Picker — it
             cannot browse. Restricted-scope apps get category + security
             assessment review before production. Testing-mode (external
             user type): refresh tokens EXPIRE IN 7 DAYS unless the app
             uses only name/email/profile/OpenID scopes, and a Google
             account holds at most 100 refresh tokens per client (oldest
             auto-invalidated, no warning). Uploads: media (binary body),
             multipart, resumable (session) — max file 5,120 GB (5 TB)
             per file, any MIME type.
             (developers.google.com: /workspace/drive/api/guides/
             api-specific-auth, /identity/protocols/oauth2, /workspace/
             drive/api/guides/manage-uploads, /workspace/drive/api/
             reference/rest/v3/files/create)
  dropbox  : PKCE is the public-client flow — no client secret needed.
             A refresh token is ONLY returned when the authorize URL
             carries token_access_type=offline; refresh tokens are
             long-lived ("a user's approval remains valid until
             explicitly revoked" — the old ~30-day-expiry claim is not in
             the current docs, so don't design around it; surface a failed
             refresh so the user can re-authorize). Access tokens are
             opaque and may exceed 1 KB. Data calls go to
             api.dropboxapi.com / content.dropboxapi.com; only the
             /oauth2/authorize page lives on www.dropbox.com. Business
             teams can have a monthly "data transport calls" cap — the
             failure carries a user_message to show the user.
             [2026-09-26] Docs moved: /get-started/authorization and
             /oauth → docs.dropboxapi.com/dropbox-api/docs/oauth and
             /developer-resources/developer-guide (the old /developers-v2/
             tree is 404). Single /files/upload caps at 150 MB; above
             that, /files/upload_session/{start,append_v2,finish} in
             4 MB-multiple chunks, ≤1000 appends per batch, 429
             too_many_write_operations when saturated.
             ✗ CORRECTION — server-side zip DOES exist: POST /2/files/
             download-zip (Dropbox-API-Arg: JSON {"paths":[…]}/{"ids":[…]})
             makes the vendor zip up to 10,000 files and returns a temp
             path (metadata + size + timestamp). The temp zip must be
             DOWNLOADED WITHIN 30 MINUTES or it is deleted; the temp path
             cannot be listed/moved/renamed/deleted; any single file it
             cannot include → 400; a long build can time out; a large zip
             can be throttled (429). → build_zip is NATIVE on Dropbox
             (Phase 6 no longer "off the table" for this vendor, with
             those caps); the original card assumption was wrong.
             Data-access level is an app-level console choice: App folder
             (dedicated folder under the user's Apps folder; read/write
             there only) vs Full Dropbox (everything); scopes control
             WHAT actions, the access level controls WHICH content.
             Least-privilege is reviewed at production approval.
             (docs.dropboxapi.com: /dropbox-api/docs/oauth, /dropbox-api/
             docs/performance, /dropbox-api/docs/file-access, /dropbox-
             api/api-reference/user-endpoints/files/download-zip,
             /dropbox-api/docs/developer-resources/developer-guide)
  onedrive : personal (consumer) Microsoft accounts are supported by the
             device code flow via the /consumers tenant — the best
             onboarding path for a self-hosted box (user types a code).
             Simple upload (PUT /content) accepts up to 250 MB; above
             that use a resumable upload session. There is NO API to
             download a folder as a zip (it exists only in the web UI;
             an April-2024 feature request is still Status: NEW) — so
             build_zip/compress for OneDrive is download→zip→upload or
             capability-hidden, NOT a native call.
             [2026-09-26] Device flow detail: the /devicecode response
             carries the poll `interval` and an `expires_in` defaulting
             to 15 minutes for the user to sign in; polling errors are
             authorization_pending / slow_down / expired_token /
             bad_verification_code. ✗ QUIRK — a PERSONAL account signed
             in via /common or /consumers is asked to sign in AGAIN on
             the other device (the code device has no cookies); work or
             school accounts are not. The onboarding UI must expect a
             second sign-in and say so.
             ✗ CORRECTION — upload-session chunk rules (current docs):
             max 60 MiB per request (the older 32 MiB number is out of
             date); fragments must be a MULTIPLE OF 320 KiB (327,680
             bytes) and are uploaded SEQUENTIALLY (out-of-order → error);
             recommended fragment size 5–10 MiB. The session's
             expirationDateTime extends with each fragment; a dropped
             mid-request upload discards only that request's bytes and
             resumes from the last completed fragment (nextExpectedRanges
             tells you where). Total file length is known up front.
             The folder-zip line above stands, sharpened: current v1.0
             AND beta /content docs say "only driveItems with the file
             property can be downloaded" — a March-2025 Q&A (official
             responder) reports folder /content DID return a zip, so the
             behavior may exist undocumented; treat it as unverified and
             live-test against a real OneDrive before relying on it.
             (learn.microsoft.com: /entra/identity-platform/
             v2-oauth2-device-code, /graph/api/driveitem-put-content,
             /graph/api/driveitem-createuploadsession, /graph/api/
             resources/uploadsession, /graph/api/driveitem-get-content;
             learn.microsoft.com/answers/questions/2201182;
             techcommunity.microsoft.com idea 4116936)
"""

import datetime
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

from viewer import db
from viewer import config as _config


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


class _Pending(BaseDrive):
    """A recognized vendor kind whose adapter isn't built yet: the registry
    accepts the kind, but every op answers 501 until its phase lands.
    Replacing its ADAPTERS entry ships the vendor."""

    def _not_yet(self, op):
        raise DriveError(f"{self.drive.get('kind')}: {op} is not available yet", 501)

    def fs_list(self, path, show_hidden=False):
        self._not_yet("list")

    def read_bytes(self, path):
        self._not_yet("read")

    def upload(self, path, files):
        self._not_yet("upload")

    def mkdir(self, path, name):
        self._not_yet("mkdir")

    def rename(self, path, name):
        self._not_yet("rename")

    def delete(self, path):
        self._not_yet("delete")

    def compress(self, path, names, archive):
        self._not_yet("compress")

    def build_zip(self, path, names):
        self._not_yet("zip")

    def status(self):
        return {"ok": False, "account": "", "error": "adapter not built yet"}


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


def _google_client():
    """The viewer's own Google OAuth client — ONE shared client for every google
    drive (per-user tokens live in the drive row). Read from DRIVES_OAUTH_FILE
    as {"google": {"client_id","client_secret"}}. Missing/incomplete → 403 with
    guidance, so a first run says exactly what to do instead of failing opaquely."""
    path = _config.DRIVES_OAUTH_FILE
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        raise DriveError(f"No Google OAuth client configured — put one in {path}", 403)
    except Exception:
        raise DriveError("Google OAuth client file is not valid JSON", 403)
    c = data.get("google") or {}
    if not c.get("client_id") or not c.get("client_secret"):
        raise DriveError("Google OAuth client is incomplete (needs client_id and client_secret)", 403)
    return c


class GoogleDrive(BaseDrive):
    """Google Drive v3 adapter (Phase 2). The vendor addresses files by id, but
    the fs routes and UI speak paths, so a path like /a/b/c.docx is resolved by
    walking from the root folder one segment at a time. Every method returns the
    exact shape the local/SSH legs produce (see the BaseDrive contract above).

    Tokens: the drive's config JSONB holds {account, access_token, refresh_token,
    token_expiry}. The OAuth client (id/secret) is a viewer-level secret shared
    by all google drives. A 401 on any call forces one refresh + retry.

    The 7-day constraint (Phase 0 facts): Google's *testing-mode* apps get a
    7-day refresh token for the restricted `drive` scope. So _refresh() failing
    is an expected lifecycle event, not a bug — it is surfaced as a 403 the UI
    turns into a one-click re-authorize, and we never design a feature that
    assumes the refresh token outlives a week.
    """

    kind = "google"
    caps = {"list": True, "read": True, "upload": True, "mkdir": True,
            "rename": True, "delete": True, "compress": True, "zip": True}

    _API = "https://www.googleapis.com/drive/v3"
    _UPLOAD = "https://www.googleapis.com/upload/drive/v3"
    _TOKEN = "https://oauth2.googleapis.com/token"
    _FOLDER = "application/vnd.google-apps.folder"

    def __init__(self, drive):
        super().__init__(drive)
        self._meta_cache = {}  # id -> metadata, memoized for one request
        self._root_id = ""     # the root folder id, memoized

    # ---- tokens -----------------------------------------------------------

    def _access_token(self):
        cfg = self.config
        at, exp = cfg.get("access_token"), cfg.get("token_expiry") or 0
        if at and time.time() < exp - 60:
            return at
        if not cfg.get("refresh_token"):
            raise DriveError("Drive is not authorized — run the Google OAuth flow", 403)
        return self._refresh()

    def _refresh(self):
        client = _google_client()
        form = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "refresh_token": self.config.get("refresh_token"),
            "client_id": client["client_id"],
            "client_secret": client["client_secret"],
        }).encode()
        status, _, body = _http("POST", self._TOKEN,
                                headers={"Content-Type": "application/x-www-form-urlencoded"},
                                data=form)
        if status != 200:
            # 7-day testing-mode expiry (or revoked) → the owner must re-consent.
            raise DriveError("Google authorization expired — re-authorize this drive", 403)
        j = json.loads(body)
        now = time.time()
        self.config["access_token"] = j["access_token"]
        self.config["refresh_token"] = j.get("refresh_token") or self.config.get("refresh_token")
        self.config["token_expiry"] = now + int(j.get("expires_in") or 3600)
        db.drive_upsert(self.drive["id"], self.drive)
        return j["access_token"]

    # ---- transport --------------------------------------------------------

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
        err = {}
        try:
            err = (json.loads(body).get("error") or {})
        except Exception:
            pass
        msg = err.get("message") or f"Google returned HTTP {status}"
        if status == 404:
            raise DriveError(msg, 404)
        if status == 403:
            raise DriveError(msg, 403)
        if status == 400:
            raise DriveError(msg, 400)
        if status == 429:
            raise DriveError("Google is rate-limiting right now — try again shortly", 502)
        raise DriveError(msg, 502)

    def _msg(self, status, body):
        """The vendor error message, or a bare HTTP code — for per-file results
        where one bad file must not abort the whole batch."""
        try:
            return (json.loads(body).get("error") or {}).get("message") or f"HTTP {status}"
        except Exception:
            return f"HTTP {status}"

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
            m = self._get_json("/files/root?fields=id,name,mimeType")
            return m["id"], True, "/"
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

    def _norm(self, path):
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

    def _ts(self, s):
        if not s:
            return 0
        try:
            dt = datetime.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc)
            return dt.timestamp()
        except Exception:
            return 0

    def _list_dir(self, fid):
        q = f"'{fid}' in parents and trashed = false"
        j = self._get_json(f"/files?q={urllib.parse.quote(q)}&fields=files(id,name,mimeType)&pageSize=1000")
        return [{"id": f["id"], "name": f["name"],
                 "dir": f.get("mimeType") == self._FOLDER} for f in (j.get("files") or [])]

    def _read_raw(self, fid):
        status, body = self._req("GET", f"{self._API}/files/{fid}?alt=media")
        if status != 200:
            raise DriveError(self._msg(status, body), 502)
        return body, self._meta(fid).get("name") or ""

    def _upload(self, parent_id, name, mime, data):
        """Create a file with a NAME via multipart/related. A bare media upload
        would leave the file unnamed (Drive assigns a random name), which would
        make every `created`/`path` we report a lie — so the metadata part always
        carries the name and MIME type. Returns the created file resource."""
        boundary = "harman-" + secrets.token_hex(16)
        meta = json.dumps({"name": name, "mimeType": mime}).encode()
        body = (
            f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
            + meta.decode()
            + f"\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n"
        ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
        url = f"{self._UPLOAD}/files?uploadType=multipart&parents={parent_id}&fields=id,name"
        status, r = self._req("POST", url, data=body,
                              headers={"Content-Type": f"multipart/related; boundary={boundary}"})
        if status != 200:
            raise DriveError(self._msg(status, r), 502)
        return json.loads(r)

    # ---- the nine operations (BaseDrive contract) -------------------------

    def fs_list(self, path, show_hidden=False):
        fid, is_dir, _ = self._resolve(path)
        if not is_dir:
            raise DriveError("Path is a file, not a folder", 400)
        q = f"'{fid}' in parents and trashed = false"
        j = self._get_json(
            f"/files?q={urllib.parse.quote(q)}"
            "&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=1000&orderBy=name,natural")
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
        return {"path": self._norm(path), "parent": self._parent_path(self._norm(path)),
                "entries": entries, "home": "/", "truncated": truncated}

    def read_bytes(self, path):
        fid, is_dir, name = self._resolve(path)
        if is_dir:
            raise DriveError("Path is a folder — download it as a zip instead", 400)
        return self._read_raw(fid)

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

    def compress(self, path, names, archive):
        pid, is_dir, _ = self._resolve(path)
        if not is_dir:
            raise DriveError("Compress target is not a folder", 400)
        data, arcname = self._zip(path, names, archive)
        self._upload(pid, arcname, "application/zip", data)
        return {"created": self._join(path, arcname)}

    def build_zip(self, path, names):
        data, arcname = self._zip(path, names, None)
        return data, arcname

    def _zip(self, path, names, archive):
        import io
        import zipfile
        arc = (archive or "").strip()
        arcname = arc if arc else (names[0] + ".zip" if len(names) == 1 else "Archive.zip")
        if not arcname.endswith(".zip"):
            arcname += ".zip"
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for n in names:
                fid, is_dir, _ = self._resolve(self._join(path, n))
                self._zip_one(z, fid, is_dir, n)
        return buf.getvalue(), arcname

    def _zip_one(self, z, fid, is_dir, prefix):
        if not is_dir:
            data, _ = self._read_raw(fid)
            z.writestr(prefix, data)
            return
        for c in self._list_dir(fid):
            sub = f"{prefix}/{c['name']}"
            if c["dir"]:
                self._zip_one(z, c["id"], True, sub)
            else:
                data, _ = self._read_raw(c["id"])
                z.writestr(sub, data)

    def status(self):
        account = self.config.get("account") or ""
        if not self.config.get("refresh_token"):
            return {"ok": False, "account": account, "error": "not authorized"}
        try:
            self._root()
            return {"ok": True, "account": account}
        except DriveError as e:
            return {"ok": False, "account": account, "error": str(e)}


# kind → adapter class. The ONLY place vendor names exist in the backend.
ADAPTERS = {
    "google": GoogleDrive,   # Phase 2: Drive v3 adapter (loopback OAuth below)
    "dropbox": _Pending,     # Phase 3: PKCE web flow, no client secret
    "onedrive": _Pending,    # Phase 3: consumer device flow
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
