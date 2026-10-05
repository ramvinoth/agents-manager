"""viewer.integrations — the catalog of what Harman can connect to, and the
pure rules that say what a connected account may be used for.

Two nouns:
  provider   — who signs the user in (Google, Dropbox, Microsoft): OAuth
               endpoints, the authorize-URL dialect, whether the client is a
               public PKCE client. One OAuth client per provider, entered once
               in Integrations (db.drive_clients).
  service    — one thing an agent can use on that account (Google Drive,
               Gmail, Calendar…): the scopes it needs and what agents may do
               with it. A service is AVAILABLE when Harman has an adapter
               for it; Keep is listed but unavailable (see below), so the page
               tells the owner the truth instead of hiding the request.

A *connection* is one signed-in account: a row of the `drives` table (the
table predates this module; its rows were always per-account OAuth grants).
Its config records the scopes the vendor ACTUALLY granted — Google lets the
user untick individual permissions, so what was requested is not proof — and
the services the owner switched off. A service is usable on a connection when
its scopes ⊆ granted and the owner has not switched it off. Everything here is
pure (no I/O): the routes, the OAuth flow, the file layer and the MCP tools all
ask these functions, and the web and mobile pages render the view the server
builds from them — no client hardcodes a vendor or a scope.

Adding a service = one SERVICES entry + the adapter that uses its scopes.

Vendor facts (VERIFIED 2026-10-05 against developers.google.com):
  - Incremental authorization: include_granted_scopes=true makes a new consent
    return a token covering everything granted before plus the new scopes, and
    the token response's `scope` field lists what was granted.
  - Gmail scopes used here (gmail.readonly, gmail.compose) are RESTRICTED: a
    personal project (<100 users) works after an "unverified app" click-through;
    distributing Harman beyond that needs Google verification + a security
    assessment. calendar.readonly is sensitive (same click-through).
  - Google Keep's API is Workspace-only (domain-wide delegation or an
    admin-approved client); a personal Google account cannot grant it.
"""

PROVIDERS = {
    "google": {
        "label": "Google",
        "auth": "https://accounts.google.com/o/oauth2/v2/auth",
        "token": "https://oauth2.googleapis.com/token",
        # openid+email put the account address in the token response's
        # id_token, so a connection knows WHOSE it is whichever services it has.
        "base_scopes": ("openid", "email"),
        "extra": {"access_type": "offline", "prompt": "consent",
                  "include_granted_scopes": "true"},
        "public": False,
        "console": "https://console.cloud.google.com/apis/credentials",
    },
    "dropbox": {
        "label": "Dropbox",
        "auth": "https://www.dropbox.com/oauth2/authorize",
        "token": "https://api.dropboxapi.com/oauth2/token",
        "base_scopes": ("account_info.read",),
        "extra": {"token_access_type": "offline"},
        "public": True,
        "console": "https://www.dropbox.com/developers/apps",
    },
    "onedrive": {
        "label": "Microsoft",
        "auth": "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
        "token": "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        "base_scopes": ("offline_access", "User.Read"),
        "extra": {},
        "public": True,
        "console": "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps",
    },
}

_G = "https://www.googleapis.com/auth/"

# Order is display order. `files` services back the file browser (one per
# provider — FILES_SERVICE below); `agent` is the one-line answer to "what will
# agents do with this?" the owner reads before granting.
SERVICES = (
    {"id": "google.drive", "provider": "google", "label": "Google Drive", "kind": "files",
     "scopes": (_G + "drive",),
     "agent": "Browse, read and save files; files appear in the Files tab.",
     "available": True},
    {"id": "google.gmail", "provider": "google", "label": "Gmail", "kind": "mail",
     "scopes": (_G + "gmail.readonly", _G + "gmail.compose"),
     "agent": "Search and read mail, and write drafts. Agents never send — you send a draft from Gmail.",
     "available": True},
    {"id": "google.calendar", "provider": "google", "label": "Google Calendar", "kind": "calendar",
     "scopes": (_G + "calendar.readonly",),
     "agent": "Read your events to plan around them. Read-only.",
     "available": True},
    {"id": "google.keep", "provider": "google", "label": "Google Keep", "kind": "notes",
     "scopes": (),
     "agent": "",
     "available": False,
     "unavailable": "Google only opens the Keep API to Workspace admins, not personal "
                    "accounts. Use Harman Notes — agents already read and write them."},
    {"id": "dropbox.files", "provider": "dropbox", "label": "Dropbox", "kind": "files",
     "scopes": ("files.metadata.read", "files.content.read", "files.content.write"),
     "agent": "Browse, read and save files; files appear in the Files tab.",
     "available": True},
    {"id": "onedrive.files", "provider": "onedrive", "label": "OneDrive", "kind": "files",
     "scopes": ("Files.ReadWrite",),
     "agent": "Browse, read and save files; files appear in the Files tab.",
     "available": True},
)

_BY_ID = {s["id"]: s for s in SERVICES}
FILES_SERVICE = {s["provider"]: s["id"] for s in SERVICES if s["kind"] == "files"}


class IntegrationError(Exception):
    """A user-facing refusal; .status is the HTTP status to answer with."""

    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


def provider(pid):
    p = PROVIDERS.get(pid)
    if p is None:
        raise IntegrationError("Unknown provider %r" % pid, 404)
    return p


def service(sid):
    s = _BY_ID.get(sid)
    if s is None:
        raise IntegrationError("Unknown service %r" % sid, 404)
    return s


def services_of(pid):
    return [s for s in SERVICES if s["provider"] == pid]


def _norm_scope(s):
    """Microsoft echoes Graph scopes either bare or as
    https://graph.microsoft.com/<scope>; compare on the bare name."""
    return s.rsplit("/", 1)[-1] if s.startswith("https://graph.microsoft.com/") else s


def parse_granted(scope_field, requested):
    """The granted-scope set from a token response's `scope` (space-separated).
    A vendor that omits the field granted what was asked (RFC 6749 §5.1: scope
    is OPTIONAL when identical to the request)."""
    raw = (scope_field or "").split() or list(requested)
    return sorted({_norm_scope(s) for s in raw})


def granted(conn):
    """What this connection's token may do. A row connected before scopes were
    recorded was consented with its provider's files scope only (the single
    flow that existed) — so that is what it is treated as holding."""
    cfg = conn.get("config") or {}
    if "scopes" in cfg:
        return {_norm_scope(s) for s in cfg["scopes"]}
    if not (cfg.get("refresh_token") or cfg.get("access_token")):
        return set()
    fs = FILES_SERVICE.get(conn.get("kind"))
    return set(_BY_ID[fs]["scopes"]) if fs else set()


def state(conn, sid):
    """'on' | 'off' (granted, switched off by the owner) | 'grant' (needs a
    consent that adds its scopes) | 'unavailable'."""
    s = service(sid)
    if not s["available"]:
        return "unavailable"
    if not set(s["scopes"]) <= granted(conn):
        return "grant"
    off = (conn.get("config") or {}).get("off") or ()
    return "off" if sid in off else "on"


def usable(conn, sid):
    return state(conn, sid) == "on"


def consent_scopes(conn, sid):
    """The scope string for a consent that keeps everything this connection
    already holds and adds `sid`'s. Listing the held scopes explicitly (as well
    as include_granted_scopes) keeps vendors without incremental auth from
    dropping a service the owner already turned on."""
    s = service(sid)
    if not s["available"]:
        raise IntegrationError("%s can't be connected: %s" % (s["label"], s["unavailable"]), 409)
    p = provider(s["provider"])
    want = set(p["base_scopes"]) | set(s["scopes"])
    if conn is not None:
        want |= {x for x in granted(conn)}
    return " ".join(sorted(want))


def with_service(conn_config, sid, on):
    """A copy of a connection's config with `sid` switched on/off (owner
    choice; it never touches the grant)."""
    cfg = dict(conn_config or {})
    off = [x for x in (cfg.get("off") or []) if x != sid]
    if not on:
        off.append(sid)
    cfg["off"] = sorted(off)
    return cfg


def pick_connection(conns, sid, connection_id=None):
    """The connection an agent call should use for `sid`: the named one, else
    the only connection where it is on. Two candidates is a question, not a
    guess — the error names them so the caller can pass `connection`."""
    if connection_id:
        c = next((c for c in conns if c["id"] == connection_id), None)
        if c is None:
            raise IntegrationError("Unknown connection %r" % connection_id, 404)
        if not usable(c, sid):
            raise IntegrationError("%s is not turned on for %s — turn it on in Integrations"
                                   % (service(sid)["label"], account_of(c)), 403)
        return c
    on = [c for c in conns if not c.get("hidden") and c.get("status", "active") == "active"
          and usable(c, sid)]
    if not on:
        raise IntegrationError("%s is not connected — the owner turns it on in Integrations"
                               % service(sid)["label"], 403)
    if len(on) > 1:
        raise IntegrationError("Several accounts have %s on (%s) — pass connection=<id>" % (
            service(sid)["label"], ", ".join("%s=%s" % (c["id"], account_of(c)) for c in on)), 400)
    return on[0]


def account_of(conn):
    return (conn.get("config") or {}).get("account") or conn.get("label") or conn["id"]


def view(conns, clients, redirect_uri):
    """Everything the Integrations page renders, in one response. Secrets and
    tokens never appear: a client reports presence flags, a connection its
    account and per-service state."""
    out = []
    for pid, p in PROVIDERS.items():
        c = clients.get(pid) or {}
        svcs = services_of(pid)
        out.append({
            "id": pid,
            "label": p["label"],
            "public": p["public"],
            "console": p["console"],
            "client": {
                "client_id": c.get("client_id") or "",
                "has_secret": bool(c.get("client_secret")),
                "configured": bool(c.get("client_id")) and (p["public"] or bool(c.get("client_secret"))),
            },
            "services": [{
                "id": s["id"], "label": s["label"], "kind": s["kind"], "agent": s["agent"],
                "available": s["available"], "unavailable": s.get("unavailable", ""),
            } for s in svcs],
            "connections": [{
                "id": conn["id"],
                "account": (conn.get("config") or {}).get("account") or "",
                "status": conn.get("status") or "active",
                "authorized": bool(granted(conn)),
                "services": {s["id"]: state(conn, s["id"]) for s in svcs},
            } for conn in conns if conn.get("kind") == pid and not conn.get("hidden")],
        })
    return {"providers": out, "redirect_uri": redirect_uri}
