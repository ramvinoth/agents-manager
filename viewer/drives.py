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

Vendor facts (VERIFIED against primary docs 2026-09-19):
  google   : an unverified app using sensitive scopes (e.g. `drive`) shows
             an "unverified app" warning before the consent screen and is
             capped at 100 NEW users; verification is only required before
             a public launch, and an internal/personal use case is exempt.
             For a single-owner self-hosted app that is just a warning.
             Web (authorization-code) flow only — no device flow for
             Drive. (support.google.com/cloud/answer/7454865)
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
             (docs.dropboxapi.com: /get-started/authorization, /oauth,
             /technical-reference/data-transport-limit)
  onedrive : personal (consumer) Microsoft accounts are supported by the
             device code flow via the /consumers tenant — the best
             onboarding path for a self-hosted box (user types a code).
             Simple upload (PUT /content) accepts up to 250 MB; above
             that use a resumable upload session. There is NO API to
             download a folder as a zip (it exists only in the web UI;
             an April-2024 feature request is still Status: NEW) — so
             build_zip/compress for OneDrive is download→zip→upload or
             capability-hidden, NOT a native call.
             (learn.microsoft.com: /entra/identity-platform/
             v2-oauth2-device-code, /graph/api/driveitem-put-content;
             techcommunity.microsoft.com idea 4116936)
"""

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


# kind → adapter class. The ONLY place vendor names exist in the backend.
ADAPTERS = {
    "google": _Pending,     # Phase 2: web OAuth (Testing-mode consent)
    "dropbox": _Pending,    # Phase 3: PKCE web flow, no client secret
    "onedrive": _Pending,   # Phase 3: consumer device flow
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
