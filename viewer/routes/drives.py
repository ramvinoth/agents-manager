"""viewer.routes.drives — DrivesMixin: the file-layer's cloud-drive control
surface.

These routes let the UI (the file browser's location picker) manage drives and
run the consent flow. They are thin: each maps one HTTP request to a call into
the pure layer (viewer.db drive helpers + viewer.drive_oauth) and translates a
DriveError into its HTTP status. The list route returns a SANITIZED view — it
never echoes the per-user tokens or the vendor client secret back out.

A drive is one row (viewer.db.drives); its per-user tokens live in that row's
config. `adapter_for` (viewer.drives) is the single choke point every file
route passes through, so a drive created here becomes immediately usable in
the file browser with no other change.
"""
import secrets

from viewer import db, drive_oauth
from viewer.drives import DriveError
from viewer.routes import require_human

def _public_view(d):
    """What the UI may see about a drive. The config (per-user tokens, the
    vendor client) is deliberately NOT returned — a list endpoint leaking
    refresh tokens to any logged-in client is exactly the secret-leak these
    routes exist to prevent. `authorized` is a presence flag, not a token."""
    cfg = d.get("config") or {}
    return {
        "id": d["id"],
        "label": d.get("label") or d["id"],
        "kind": d.get("kind") or "",
        "status": d.get("status") or "active",
        "hidden": bool(d.get("hidden")),
        "authorized": bool(cfg.get("refresh_token") or cfg.get("access_token")),
    }


class DrivesMixin:
    def _err(self, e, req=None):
        """A DriveError is already a finished HTTP response: its .status IS
        the status code and its message is user-facing. Never 500 these."""
        self.send_json({"error": str(e)}, status=e.status)

    # -- list / create / delete --------------------------------------------

    def _g_drives(self, req):
        """Every drive the picker can offer, sanitized. `vendors` is the set
        the UI may offer for a NEW drive (the built consent flows)."""
        try:
            rows = [
                _public_view(d)
                for d in db.drives_load().values()
                if not d.get("hidden")
            ]
        except DriveError as e:
            self._err(e, req)
            return
        self.send_json({
            "drives": rows,
            "vendors": sorted(drive_oauth.available_vendors()),
        })

    def _p_drives_create(self, req):
        """Create an empty drive row the user can then connect. Body:
        {label, kind}. The kind must have a built consent flow — creating a
        row for a vendor with no adapter/OAuth would be a dead end in the
        picker, so that's refused up front (501), not a 201 you can never use."""
        body = self.read_body() or {}
        label = (body.get("label") or "").strip()
        kind = (body.get("kind") or "").strip().lower()
        if not label:
            self.send_json({"error": "label is required"}, status=400)
            return
        if kind not in drive_oauth.available_vendors():
            self.send_json({
                "error": "No %r drive can be connected yet (no consent flow "
                         "built)" % kind,
            }, status=501)
            return
        did = "dr-" + secrets.token_hex(4)
        try:
            db.drive_upsert(did, {"label": label, "kind": kind, "config": {},
                                  "status": "active", "hidden": False})
        except DriveError as e:
            self._err(e, req)
            return
        self.send_json({"drive": _public_view(db.drive_get(did))}, status=201)

    def _p_drives_delete(self, req):
        """Remove a drive row (and its stored tokens). Body: {drive}. Idempotent
        in the UI sense: deleting an already-gone drive is a 404, not a 500."""
        body = self.read_body() or {}
        did = body.get("drive") or ""
        if not did:
            self.send_json({"error": "drive is required"}, status=400)
            return
        if not db.drive_delete(did):
            self.send_json({"error": "Unknown drive %r" % did}, status=404)
            return
        self.send_json({"ok": True, "drive": did})

    # -- vendor clients (the viewer's own OAuth identity per vendor) ----------

    def _g_drive_clients(self, req):
        """Per vendor with a built flow: whether a client is on record, its id,
        whether it needs a secret, and the exact redirect URI to register with
        that vendor for THIS deployment (from the origin the request came in
        on). The secret is never returned — `has_secret` is a presence flag."""
        stored = db.drive_clients_load()
        redirect_uri = drive_oauth.redirect_uri_for(self.request_origin())
        out = []
        for kind in sorted(drive_oauth.available_vendors()):
            v = drive_oauth.vendor(kind)
            c = stored.get(kind) or {}
            out.append({
                "kind": kind,
                "label": v["label"],
                "public": v["public"],
                "client_id": c.get("client_id") or "",
                "has_secret": bool(c.get("client_secret")),
                "configured": bool(c.get("client_id")) and (v["public"] or bool(c.get("client_secret"))),
            })
        self.send_json({"clients": out, "redirect_uri": redirect_uri})

    def _p_drive_clients(self, req):
        """Save one vendor client. Body: {kind, client_id, client_secret?}.
        Human-only. An omitted client_secret keeps the one on record (the UI
        never holds it); an empty string clears it. Takes effect immediately —
        _vendor_client reads the store per call."""
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        kind = (body.get("kind") or "").strip().lower()
        client_id = (body.get("client_id") or "").strip()
        if kind not in drive_oauth.available_vendors():
            self.send_json({"error": "Unknown vendor %r" % kind}, status=404)
            return
        if not client_id:
            self.send_json({"error": "client_id is required"}, status=400)
            return
        secret = body.get("client_secret")
        if secret is not None and not isinstance(secret, str):
            self.send_json({"error": "client_secret must be a string"}, status=400)
            return
        db.drive_client_set(kind, client_id, None if secret is None else secret.strip())
        self._g_drive_clients(req)

    def _p_drive_clients_delete(self, req):
        """Forget a vendor client. Body: {kind}. Human-only. Drives of that
        kind stay listed but can no longer refresh or connect until a client
        is entered again."""
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        kind = (body.get("kind") or "").strip().lower()
        if not db.drive_client_delete(kind):
            self.send_json({"error": "No %r client on record" % kind}, status=404)
            return
        self._g_drive_clients(req)

    # -- the hosted consent flow ---------------------------------------------

    def _p_drive_oauth_start(self, req):
        """Start a consent flow for an existing drive. Body: {drive}. Returns
        the consent URL the UI opens in a browser, the pending handle to poll
        with /api/drive/oauth/status, and the redirect_uri the vendor will send
        the browser back to — derived from the origin THIS request came in on,
        so the callback lands on the same public hostname the user is using."""
        body = self.read_body() or {}
        did = body.get("drive") or ""
        if not did:
            self.send_json({"error": "drive is required"}, status=400)
            return
        drive = db.drive_get(did)
        if drive is None:
            self.send_json({"error": "Unknown drive %r" % did}, status=404)
            return
        try:
            r = drive_oauth.start(drive["kind"], did, self.request_origin())
        except DriveError as e:
            self._err(e, req)
            return
        self.send_json(r)

    def _g_drive_oauth_status(self, req):
        """Poll an in-flight flow. Query: ?pending=<pid>. The UI polls this
        until status is 'authorized' / 'failed' / 'expired'."""
        pid = (req.query.get("pending") or [""])[0]
        if not pid:
            self.send_json({"error": "pending is required"}, status=400)
            return
        try:
            self.send_json(drive_oauth.status(pid))
        except DriveError as e:
            self._err(e, req)

    def _g_drive_oauth_callback(self, req):
        """Where the vendor redirects the user's browser after consent. Public
        (no cookie crosses a top-level redirect from another site); the
        one-time `state` in the query is what ties it to a flow started here.
        Always a human-readable HTML page — the polling app is where the
        result actually lands."""
        self.send_html(drive_oauth.callback(req.query))
