"""viewer.routes.integrations — IntegrationsMixin: the Integrations page and
the agent-facing mail/calendar routes.

The page is one GET (integrations.view: providers → client setup, services,
connected accounts with per-service state) plus the owner actions: save or
forget a provider's OAuth client, connect
(create the account row if needed and start a consent that adds a service),
switch a granted service on/off, and — via the existing /api/drives/delete —
disconnect. Every decision about state lives in viewer.integrations; this
module maps HTTP onto it.

The mail/calendar routes are what the MCP gmail_* / calendar_* tools call,
and what the app's Calendar screen calls. Each resolves its account with
integrations.pick_connection — so a service the owner switched off is refused
here, at the one place every caller passes. An AGENT's call also names the
operation (read, draft, create…), which the owner allows per account; the
owner acting in the app is bounded by the vendor grant alone.

Local disk: the owner's rules for what agents may touch on this machine
(integrations.local_*), stored in one setting and enforced by routes.fs.
"""
import secrets

from viewer import db, drive_oauth, integrations, workspace
from viewer.drives import ADAPTERS, DriveError
from viewer.routes import require_human


LOCAL_DISK_KEY = "local_disk"


def _q(req, name, default=""):
    return (req.query.get(name) or [default])[0]


def local_rules():
    return integrations.local_rules(db.setting_get(LOCAL_DISK_KEY))


class IntegrationsMixin:
    # Errors answer through DrivesMixin._err: a DriveError and an
    # IntegrationError both carry the HTTP status as .status.

    # -- the page ----------------------------------------------------------

    def _g_integrations(self, req):
        """The owner's page view; an agent (MCP principal) gets agent_view —
        what it may use, not how the owner set it up."""
        if (getattr(req, "principal", None) or {}).get("kind") == "mcp":
            self.send_json(integrations.agent_view(list(db.drives_load().values()), local_rules()))
            return
        self.send_json(dict(integrations.view(
            list(db.drives_load().values()), db.drive_clients_load(),
            drive_oauth.redirect_uri_for(self.request_origin())),
            local=integrations.local_view(local_rules())))

    def _p_integrations_connect(self, req):
        """Body: {service, connection?, op?}. Without `connection` a new account row
        is created for the service's provider (connecting a second Google
        account is a new row, not a re-consent of the first). Returns the
        consent {url, pending, redirect_uri} plus the connection id. `op` asks
        for one operation's extra scopes too (calendar editing) and allows it."""
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        sid = (body.get("service") or "").strip()
        cid = (body.get("connection") or "").strip()
        op = (body.get("op") or "").strip() or None
        created = False
        try:
            svc = integrations.service(sid)
            if op:
                integrations.op_spec(sid, op)
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
            r = drive_oauth.start(cid, self.request_origin(), sid, op)
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

    def _p_integrations_op(self, req):
        """Body: {connection, service, op, on}. Allow or disallow one
        operation for agents on one account. Allowing an op whose scopes were
        never granted is a 409: the client connects with that op instead."""
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        conn = db.drive_get(body.get("connection") or "")
        sid, op, on = body.get("service") or "", body.get("op") or "", bool(body.get("on"))
        try:
            if conn is None:
                raise integrations.IntegrationError("Unknown connection %r" % body.get("connection"), 404)
            if integrations.service(sid)["provider"] != conn["kind"]:
                raise integrations.IntegrationError("%s is not a %s service" % (sid, conn["kind"]), 400)
            if on and integrations.op_state(conn, sid, op) == "grant":
                raise integrations.IntegrationError("%s needs a new grant — connect it first"
                                                    % integrations.OP_LABELS.get(op, op), 409)
            cfg = integrations.with_op(conn.get("config"), sid, op, on)
        except integrations.IntegrationError as e:
            self._err(e)
            return
        db.drive_upsert(conn["id"], dict(conn, config=cfg))
        self._g_integrations(req)

    def _p_integrations_root(self, req):
        """Body: {connection, root}. Narrow a files connection to one folder
        ("/" = the whole account). The folder must exist: it is checked through
        the adapter before it is saved, so a typo never empties the drive."""
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        conn = db.drive_get(body.get("connection") or "")
        if conn is None or conn["kind"] not in integrations.FILES_SERVICE:
            self.send_json({"error": "Unknown files connection %r" % body.get("connection")}, status=404)
            return
        root = (body.get("root") or "/").strip()
        cfg = dict(conn.get("config") or {})
        try:
            probe = ADAPTERS[conn["kind"]](dict(conn, config=dict(cfg, root="/")))
            root = probe._norm(root)
            if root != "/":
                probe.fs_list(root)    # 404 / 400 (a file) before anything is saved
        except DriveError as e:
            self._err(e)
            return
        if root == "/":
            cfg.pop("root", None)
        else:
            cfg["root"] = root
        db.drive_upsert(conn["id"], dict(conn, config=cfg))
        self._g_integrations(req)

    def _p_integrations_local(self, req):
        """Body: {roots: [folder…], ops: ["read","write","delete"…]}. What
        agents may do on this machine's disk. Human-only."""
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        try:
            rules = integrations.local_set(body.get("roots"), body.get("ops"))
        except integrations.IntegrationError as e:
            self._err(e)
            return
        db.setting_set(LOCAL_DISK_KEY, rules)
        self._g_integrations(req)

    # -- mail and calendar (agents, and the app's Calendar screen) ------------

    def _account(self, req, sid, cid, op):
        """The vendor client for this call. An agent (MCP principal) must hold
        the owner's leave for `op`; a human is bounded by the grant alone."""
        agent = (getattr(req, "principal", None) or {}).get("kind") == "mcp"
        conn = integrations.pick_connection(list(db.drives_load().values()), sid, cid or None,
                                            op if agent else None)
        cls = workspace.Gmail if sid == "google.gmail" else workspace.Calendar
        if not agent and integrations.op_state(conn, sid, op) == "grant":
            raise integrations.IntegrationError(
                "%s needs a new grant — connect it in Integrations" % integrations.OP_LABELS.get(op, op), 403)
        return cls(conn)

    def _ws(self, req, sid, cid, op, fn):
        try:
            self.send_json(fn(self._account(req, sid, cid, op)))
        except (DriveError, integrations.IntegrationError) as e:
            self._err(e)
        except ValueError:
            self.send_json({"error": "limit must be a number"}, status=400)

    def _g_gmail_search(self, req):
        self._ws(req, "google.gmail", _q(req, "connection"), "read",
                 lambda g: g.search(_q(req, "q"), _q(req, "limit", "20")))

    def _g_gmail_read(self, req):
        self._ws(req, "google.gmail", _q(req, "connection"), "read", lambda g: g.read(_q(req, "id")))

    def _p_gmail_draft(self, req):
        b = self.read_body() or {}
        self._ws(req, "google.gmail", b.get("connection"), "draft", lambda g: g.draft(
            b.get("to") or "", b.get("subject") or "", b.get("body") or "",
            b.get("cc") or "", b.get("reply_to") or ""))

    def _g_calendar_events(self, req):
        self._ws(req, "google.calendar", _q(req, "connection"), "read", lambda c: c.events(
            _q(req, "start"), _q(req, "end"), _q(req, "q"), _q(req, "calendar", "primary"),
            _q(req, "limit", "50")))

    _EVENT_FIELDS = ("title", "start", "end", "all_day", "location", "description", "attendees")

    def _event_fields(self, b):
        return {k: b[k] for k in self._EVENT_FIELDS if k in b}

    def _p_calendar_create(self, req):
        b = self.read_body() or {}
        self._ws(req, "google.calendar", b.get("connection"), "create",
                 lambda c: c.create(self._event_fields(b), b.get("calendar") or "primary"))

    def _p_calendar_update(self, req):
        b = self.read_body() or {}
        self._ws(req, "google.calendar", b.get("connection"), "update",
                 lambda c: c.update(b.get("id") or "", self._event_fields(b), b.get("calendar") or "primary"))

    def _p_calendar_delete(self, req):
        b = self.read_body() or {}
        self._ws(req, "google.calendar", b.get("connection"), "delete",
                 lambda c: c.delete(b.get("id") or "", b.get("calendar") or "primary"))
