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

Vendor facts (ASSUMPTIONS until verified against primary docs — Phase 0):
  google   : an individual dev's OAuth app runs in "Testing" consent
             (~100 test users, warning banner); web flow only (no device
             flow for Drive); scopes drive + drivefile.
  dropbox  : PKCE web flow (no client secret); files.content.read/write;
             150 MB simple-upload cap (chunked upload above it); refresh
             tokens expire after ~30 days unused; no server-side zip.
  onedrive : consumer (personal Microsoft) accounts use the device flow
             (user types a code — best onboarding for a self-hosted box);
             Files.ReadWrite; GET on a folder id returns a ZIP (the only
             native zip of the three); rename = PATCH item name; delete →
             vendor trash (~30 days).
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
