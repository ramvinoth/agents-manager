"""viewer.routes.integrations — IntegrationsMixin: the Integrations page and
the agent-facing mail/calendar routes.

The page is one GET (integrations.view: providers → client setup, services,
connected accounts with per-service state) plus the owner actions: save or
forget a provider's OAuth client, connect
(create the account row if needed and start a consent that adds a service),
switch a granted service on/off, and — via the existing /api/drives/delete —
disconnect. Every decision about state lives in viewer.integrations; this
module maps HTTP onto it.

The mail/calendar routes are what the MCP gmail_* / calendar_* tools call.
Each resolves its account with integrations.pick_connection — so a service the
owner switched off is refused here, at the one place every caller passes.
"""
import secrets

from viewer import db, drive_oauth, integrations, workspace
from viewer.drives import DriveError
from viewer.routes import require_human


def _q(req, name, default=""):
    return (req.query.get(name) or [default])[0]


class IntegrationsMixin:
    # Errors answer through DrivesMixin._err: a DriveError and an
    # IntegrationError both carry the HTTP status as .status.

    # -- the page ----------------------------------------------------------

    def _g_integrations(self, req):
        self.send_json(integrations.view(
            list(db.drives_load().values()), db.drive_clients_load(),
            drive_oauth.redirect_uri_for(self.request_origin())))

    def _p_integrations_connect(self, req):
        """Body: {service, connection?}. Without `connection` a new account row
        is created for the service's provider (connecting a second Google
        account is a new row, not a re-consent of the first). Returns the
        consent {url, pending, redirect_uri} plus the connection id."""
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        sid = (body.get("service") or "").strip()
        cid = (body.get("connection") or "").strip()
        created = False
        try:
            svc = integrations.service(sid)
            if cid:
                conn = db.drive_get(cid)
                if conn is None:
                    raise DriveError("Unknown connection %r" % cid, 404)
                if conn["kind"] != svc["provider"]:
                    raise DriveError("%s belongs to another provider" % cid, 400)
            else:
                integrations.consent_scopes(None, sid)   # refuse an unavailable service before creating a row
                cid = "dr-" + secrets.token_hex(4)
                db.drive_upsert(cid, {"label": integrations.provider(svc["provider"])["label"],
                                      "kind": svc["provider"], "config": {},
                                      "status": "active", "hidden": False})
                created = True
            r = drive_oauth.start(cid, self.request_origin(), sid)
        except (DriveError, integrations.IntegrationError) as e:
            if created:
                db.drive_delete(cid)   # a refused consent (no client set up) must not leave an empty account behind
            self._err(e)
            return
        self.send_json(dict(r, connection=cid))

    def _p_integrations_client(self, req):
        """Save a provider's OAuth client (Harman's own identity to that
        vendor, shared by every account of the provider). Body: {provider,
        client_id, client_secret?}. Human-only. An omitted client_secret keeps
        the one on record (no client ever holds it); "" clears it. Takes effect
        immediately — drives._vendor_client reads the store per call."""
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        pid = (body.get("provider") or "").strip().lower()
        client_id = (body.get("client_id") or "").strip()
        secret = body.get("client_secret")
        if pid not in integrations.PROVIDERS:
            self.send_json({"error": "Unknown provider %r" % pid}, status=404)
        elif not client_id:
            self.send_json({"error": "client_id is required"}, status=400)
        elif secret is not None and not isinstance(secret, str):
            self.send_json({"error": "client_secret must be a string"}, status=400)
        else:
            db.drive_client_set(pid, client_id, None if secret is None else secret.strip())
            self._g_integrations(req)

    def _p_integrations_client_delete(self, req):
        """Forget a provider's client. Body: {provider}. Human-only. Its
        accounts stay listed but cannot sign in or refresh until a client is
        entered again."""
        if not require_human(self, req):
            return
        pid = ((self.read_body() or {}).get("provider") or "").strip().lower()
        if not db.drive_client_delete(pid):
            self.send_json({"error": "No %r client on record" % pid}, status=404)
            return
        self._g_integrations(req)

    def _p_integrations_service(self, req):
        """Body: {connection, service, on}. Switch a GRANTED service on or off
        for one account — no consent, no token change. Turning on a service
        that still needs a grant is a 409: the client must connect instead."""
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        cid = body.get("connection") or ""
        sid = body.get("service") or ""
        conn = db.drive_get(cid)
        if conn is None:
            self.send_json({"error": "Unknown connection %r" % cid}, status=404)
            return
        try:
            if integrations.service(sid)["provider"] != conn["kind"]:
                raise integrations.IntegrationError("%s is not a %s service" % (sid, conn["kind"]), 400)
            if integrations.state(conn, sid) not in ("on", "off"):
                raise integrations.IntegrationError(
                    "%s has not been granted on this account — connect it first" % integrations.service(sid)["label"], 409)
        except integrations.IntegrationError as e:
            self._err(e)
            return
        db.drive_upsert(cid, dict(conn, config=integrations.with_service(conn.get("config"), sid, bool(body.get("on")))))
        self._g_integrations(req)

    # -- what agents call ----------------------------------------------------

    def _account(self, sid, cid):
        conn = integrations.pick_connection(list(db.drives_load().values()), sid, cid or None)
        cls = workspace.Gmail if sid == "google.gmail" else workspace.Calendar
        return cls(conn)

    def _ws(self, sid, cid, fn):
        try:
            self.send_json(fn(self._account(sid, cid)))
        except (DriveError, integrations.IntegrationError) as e:
            self._err(e)
        except ValueError:
            self.send_json({"error": "limit must be a number"}, status=400)

    def _g_gmail_search(self, req):
        self._ws("google.gmail", _q(req, "connection"),
                 lambda g: g.search(_q(req, "q"), _q(req, "limit", "20")))

    def _g_gmail_read(self, req):
        self._ws("google.gmail", _q(req, "connection"), lambda g: g.read(_q(req, "id")))

    def _p_gmail_draft(self, req):
        b = self.read_body() or {}
        self._ws("google.gmail", b.get("connection"), lambda g: g.draft(
            b.get("to") or "", b.get("subject") or "", b.get("body") or "",
            b.get("cc") or "", b.get("reply_to") or ""))

    def _g_calendar_events(self, req):
        self._ws("google.calendar", _q(req, "connection"), lambda c: c.events(
            _q(req, "start"), _q(req, "end"), _q(req, "q"), _q(req, "calendar", "primary"),
            _q(req, "limit", "50")))
