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

Operations. A service lists what agents can do with it (`ops`): each op names
the scopes it needs beyond the service's base `scopes` and whether agents may
use it before the owner says otherwise (`default` — destructive ops start
off). The owner narrows or widens that per account (config.ops); the vendor
grant still bounds it — an op whose scopes were never granted is 'grant', and
connecting it asks only for those scopes. Ops govern AGENTS: the owner acting
in the app is bounded by the grant alone.

Folder root. A files connection may be narrowed to one folder (config.root):
the adapter then treats that folder as "/", for the app and agents alike — the
rest of the account is simply not connected.

Local disk. This machine's disk is not an OAuth account, so it is not a
connection row: its rules (allowed folders + ops) live in one setting and
local_allows() is the single check the file routes run for agents.

Adding a service = one SERVICES entry + the adapter that uses its scopes.

Vendor facts (VERIFIED 2026-10-05 against developers.google.com):
  - Incremental authorization: include_granted_scopes=true makes a new consent
    return a token covering everything granted before plus the new scopes, and
    the token response's `scope` field lists what was granted.
  - Gmail scopes used here (gmail.readonly, gmail.compose) are RESTRICTED: a
    personal project (<100 users) works after an "unverified app" click-through;
    distributing Harman beyond that needs Google verification + a security
    assessment. calendar.readonly is sensitive (same click-through).
  - calendar.events lets an app read and write events on every calendar the
    user can access (events.list/insert/patch/delete all accept it);
    events.patch/delete take sendUpdates=all|externalOnly|none.
  - An External app left in "Testing" gets refresh tokens that expire in 7
    days (unless it asks only for name/email/profile) — so setup tells the
    owner to publish it; every agent integration would otherwise silently
    die a week after connecting.
  - Enable-API links: console.cloud.google.com/flows/enableapi?apiid=<api>
    (drive, gmail, calendar-json .googleapis.com) — from Google's quickstarts.
  - Google Keep's API is Workspace-only (domain-wide delegation or an
    admin-approved client); a personal Google account cannot grant it.
Microsoft (VERIFIED 2026-10-06, learn.microsoft.com quickstart-register-app):
"Personal accounts only" is the account type the /consumers endpoints serve.
HYPOTHESIS (not exercised end to end): the code is redeemed server-side with
PKCE and no secret, which needs the "Mobile and desktop" platform — a "Web"
platform demands a secret and an "SPA" one refuses non-browser redemption.

Setup. Each provider carries `setup`: the ordered steps the owner follows in
the vendor's console, with deep links; a step marked `redirect` is where the
page shows this deployment's callback address. Clients render the list — no
client spells a vendor console step.
"""

_ENABLE = "https://console.cloud.google.com/flows/enableapi?apiid="

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
        "setup": (
            {"text": "Create an OAuth client of type Web application (any Google Cloud project).",
             "links": (("Credentials", "https://console.cloud.google.com/apis/credentials"),)},
            {"text": "Under Authorized redirect URIs, add this address:", "redirect": True},
            {"text": "Enable the APIs for the services you want.",
             "links": (("Drive", _ENABLE + "drive.googleapis.com"),
                       ("Gmail", _ENABLE + "gmail.googleapis.com"),
                       ("Calendar", _ENABLE + "calendar-json.googleapis.com"))},
            {"text": "Under Audience, choose External and press Publish app. While an app is in "
                     "Testing, Google ends every sign-in after 7 days. When you connect, Google warns "
                     "the app is unverified: choose Advanced, then continue.",
             "links": (("Audience", "https://console.cloud.google.com/auth/audience"),)},
            {"text": "Paste the client ID and secret below."},
        ),
    },
    "dropbox": {
        "label": "Dropbox",
        "auth": "https://www.dropbox.com/oauth2/authorize",
        "token": "https://api.dropboxapi.com/oauth2/token",
        "base_scopes": ("account_info.read",),
        "extra": {"token_access_type": "offline"},
        "public": True,
        "setup": (
            {"text": "Create an app with Scoped access and Full Dropbox.",
             "links": (("App console", "https://www.dropbox.com/developers/apps"),)},
            {"text": "In the app's OAuth 2 settings, add this redirect URI:", "redirect": True},
            {"text": "On its Permissions tab, tick files.metadata.read, files.content.read and "
                     "files.content.write, then Submit."},
            {"text": "Paste the App key below. Dropbox issues no secret for this kind of sign-in."},
        ),
    },
    "onedrive": {
        "label": "Microsoft",
        "auth": "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
        "token": "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        "base_scopes": ("offline_access", "User.Read"),
        "extra": {},
        "public": True,
        "setup": (
            {"text": "Register an app; under Supported account types choose Personal accounts only.",
             "links": (("App registrations", "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps"),)},
            {"text": "Under Authentication, add a Mobile and desktop applications platform with this "
                     "redirect URI:", "redirect": True},
            {"text": "Paste the Application (client) ID below. No secret is needed."},
        ),
    },
}

_G = "https://www.googleapis.com/auth/"

# Order is display order. `files` services back the file browser (one per
# provider — FILES_SERVICE below); `agent` is the one-line answer to "what will
# agents do with this?" the owner reads before granting; `ops` see above.
_FILE_OPS = {"read": {"scopes": (), "default": True},
             "write": {"scopes": (), "default": True},
             "delete": {"scopes": (), "default": False}}

SERVICES = (
    {"id": "google.drive", "provider": "google", "label": "Google Drive", "kind": "files",
     "scopes": (_G + "drive",), "ops": _FILE_OPS,
     "agent": "Browse, read and save files; files appear in the Files tab.",
     "try": "List the ten most recently changed files in my Google Drive and summarize the newest document.",
     "available": True},
    {"id": "google.gmail", "provider": "google", "label": "Gmail", "kind": "mail",
     "scopes": (_G + "gmail.readonly", _G + "gmail.compose"),
     "ops": {"read": {"scopes": (), "default": True},
             "draft": {"scopes": (), "default": True}},
     "agent": "Search and read mail, and write drafts. Agents never send — you send a draft from Gmail.",
     "try": "Summarize my unread email from the last two days and tell me which ones need a reply from me.",
     "available": True},
    {"id": "google.calendar", "provider": "google", "label": "Google Calendar", "kind": "calendar",
     "scopes": (_G + "calendar.readonly",),
     "ops": {"read": {"scopes": (), "default": True},
             "create": {"scopes": (_G + "calendar.events",), "default": True},
             "update": {"scopes": (_G + "calendar.events",), "default": True},
             "delete": {"scopes": (_G + "calendar.events",), "default": False}},
     "agent": "Read your events to plan around them; add or move events if you allow it. "
              "Agents never email your guests.",
     "try": "What is on my calendar for the next seven days? Point out conflicts and free blocks of two hours or more.",
     "available": True},
    {"id": "google.keep", "provider": "google", "label": "Google Keep", "kind": "notes",
     "scopes": (), "ops": {},
     "agent": "",
     "try": "",
     "available": False,
     "unavailable": "Google only opens the Keep API to Workspace admins, not personal "
                    "accounts. Use Harman Notes — agents already read and write them."},
    {"id": "dropbox.files", "provider": "dropbox", "label": "Dropbox", "kind": "files",
     "scopes": ("files.metadata.read", "files.content.read", "files.content.write"), "ops": _FILE_OPS,
     "agent": "Browse, read and save files; files appear in the Files tab.",
     "try": "List the ten most recently changed files in my Dropbox and summarize the newest document.",
     "available": True},
    {"id": "onedrive.files", "provider": "onedrive", "label": "OneDrive", "kind": "files",
     "scopes": ("Files.ReadWrite",), "ops": _FILE_OPS,
     "agent": "Browse, read and save files; files appear in the Files tab.",
     "try": "List the ten most recently changed files in my OneDrive and summarize the newest document.",
     "available": True},
)

OP_LABELS = {"read": "Read", "write": "Save files", "delete": "Delete", "draft": "Write drafts",
             "create": "Add events", "update": "Edit events"}

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


def op_spec(sid, op):
    o = service(sid)["ops"].get(op)
    if o is None:
        raise IntegrationError("%s has no %r operation" % (service(sid)["label"], op), 400)
    return o


def op_state(conn, sid, op):
    """Whether AGENTS may do `op` with `sid` on this connection: 'on' | 'off'
    (service switched off, or the owner disallowed the op) | 'grant' (its
    scopes were never granted) | 'unavailable'."""
    st = state(conn, sid)
    if st in ("unavailable", "grant"):
        return st
    if not set(op_spec(sid, op)["scopes"]) <= granted(conn):
        return "grant"
    if st == "off":
        return "off"
    choice = ((conn.get("config") or {}).get("ops") or {}).get(sid, {}).get(op)
    return "on" if (op_spec(sid, op)["default"] if choice is None else choice) else "off"


def with_op(conn_config, sid, op, on):
    """A copy of a connection's config recording the owner's choice for one op."""
    op_spec(sid, op)
    cfg = dict(conn_config or {})
    ops = {k: dict(v) for k, v in (cfg.get("ops") or {}).items()}
    ops.setdefault(sid, {})[op] = bool(on)
    cfg["ops"] = ops
    return cfg


def consent_scopes(conn, sid, op=None):
    """The scope string for a consent that keeps everything this connection
    already holds and adds `sid`'s (and `op`'s, when the owner is granting one
    operation such as editing calendar events). Listing the held scopes
    explicitly (as well as include_granted_scopes) keeps vendors without
    incremental auth from dropping a service the owner already turned on."""
    s = service(sid)
    if not s["available"]:
        raise IntegrationError("%s can't be connected: %s" % (s["label"], s["unavailable"]), 409)
    p = provider(s["provider"])
    want = set(p["base_scopes"]) | set(s["scopes"])
    if op:
        want |= set(op_spec(sid, op)["scopes"])
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


def pick_connection(conns, sid, connection_id=None, op=None):
    """The connection a call should use for `sid`: the named one, else the
    only connection where it is on. Two candidates is a question, not a guess
    — the error names them so the caller can pass `connection`. With `op` (an
    agent's call) the owner must also allow that operation; the refusal says
    exactly what to switch on."""
    c = _pick(conns, sid, connection_id)
    if op:
        st = op_state(c, sid, op)
        if st != "on":
            raise IntegrationError("Agents may not %s with %s on %s — %s" % (
                OP_LABELS.get(op, op).lower(), service(sid)["label"], account_of(c),
                "the owner allows it in Integrations" if st == "off"
                else "the owner grants it in Integrations"), 403)
    return c


def _pick(conns, sid, connection_id):
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


def expired(conn):
    """The vendor refused this account's refresh token (revoked, password
    change, a Google app left in Testing) — only a new consent revives it.
    drives.OAuthAccount records it; a later good refresh or consent clears it."""
    return bool((conn.get("config") or {}).get("expired"))


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
            "setup": [{"text": st["text"], "redirect": bool(st.get("redirect")),
                       "links": [{"label": l, "url": u} for l, u in st.get("links", ())]}
                      for st in p["setup"]],
            "client": {
                "client_id": c.get("client_id") or "",
                "has_secret": bool(c.get("client_secret")),
                "configured": bool(c.get("client_id")) and (p["public"] or bool(c.get("client_secret"))),
            },
            "services": [{
                "id": s["id"], "label": s["label"], "kind": s["kind"], "agent": s["agent"],
                "try": s["try"], "available": s["available"], "unavailable": s.get("unavailable", ""),
                "ops": [{"id": o, "label": OP_LABELS[o]} for o in s["ops"]],
            } for s in svcs],
            "connections": [{
                "id": conn["id"],
                "account": (conn.get("config") or {}).get("account") or "",
                "authorized": bool(granted(conn)),
                "expired": expired(conn),
                "services": {s["id"]: state(conn, s["id"]) for s in svcs},
                "ops": {s["id"]: {o: op_state(conn, s["id"], o) for o in s["ops"]}
                        for s in svcs if s["available"]},
                "root": (conn.get("config") or {}).get("root") or "/",
            } for conn in conns if conn.get("kind") == pid and not conn.get("hidden")],
        })
    return {"providers": out, "redirect_uri": redirect_uri}


def agent_view(conns, rules):
    """What an AGENT needs to know: one entry per usable service per account,
    with the operations it may do there. No client ids, setup steps or
    redirect URIs — those are the owner's page (view())."""
    out = []
    for conn in conns:
        if conn.get("hidden") or conn.get("kind") not in PROVIDERS:
            continue
        for s in services_of(conn["kind"]):
            if not s["available"] or state(conn, s["id"]) != "on":
                continue
            ops = {o: op_state(conn, s["id"], o) for o in s["ops"]}
            entry = {"service": s["id"], "label": s["label"], "account": account_of(conn),
                     "tools": KIND_TOOLS.get(s["kind"], ""),
                     "connection": conn["id"],
                     "may": [o for o, st in ops.items() if st == "on"],
                     "ask_owner": [o for o, st in ops.items() if st != "on"]}
            if expired(conn):
                entry["expired"] = "sign-in expired — the owner reconnects it in Integrations"
            if s["kind"] == "files":
                entry["drive"] = conn["id"]
                entry["root"] = (conn.get("config") or {}).get("root") or "/"
            out.append(entry)
    have = {e["service"] for e in out}
    return {"services": out,
            "not_connected": [s["label"] for s in SERVICES
                              if s["available"] and s["id"] not in have],
            "this_machine": {"folders": rules["roots"], "may": rules["ops"]}}


# The MCP tools that reach each kind of service (viewer_mcp.py), so the
# summary tells an agent how to use what is connected, not just that it is.
KIND_TOOLS = {"files": "fs_list/fs_read/fs_write/fs_mkdir with drive=",
              "mail": "gmail_search/gmail_read/gmail_draft",
              "calendar": "calendar_events/calendar_create/calendar_update/calendar_delete"}


def agent_summary(av):
    """agent_view() as the few lines every session's system prompt carries,
    so an agent knows what it can use without a tool call."""
    lines = []
    for e in av["services"]:
        bits = ["%s (%s): may %s" % (e["label"], e["account"], ", ".join(e["may"]) or "nothing")]
        if e["ask_owner"]:
            bits.append("not %s" % ", ".join(e["ask_owner"]))
        if e["tools"]:
            bits.append("tools " + e["tools"] + (e["drive"] if "drive" in e else ""))
        if e.get("expired"):
            bits.append("SIGN-IN EXPIRED")
        lines.append("- " + "; ".join(bits))
    m = av["this_machine"]
    lines.append("- This machine: %s in %s (fs_* tools, no drive=)" % (", ".join(m["may"]) or "nothing",
                                                ", ".join(m["folders"]) or "no folder"))
    if av["not_connected"]:
        lines.append("- Not connected (ask the owner to add it in Integrations): "
                     + ", ".join(av["not_connected"]))
    return ("Integrations connected right now (the owner manages them in Integrations; "
            "integrations_list re-checks):\n" + "\n".join(lines))


# --- local disk ------------------------------------------------------------

LOCAL_OPS = ("read", "write", "delete")
LOCAL_DEFAULT = {"roots": ["~"], "ops": ["read", "write"]}


def local_rules(raw):
    """The local-disk rules from the stored setting, defaults filled in."""
    r = dict(LOCAL_DEFAULT, **(raw or {}))
    return {"roots": [x for x in r["roots"] if isinstance(x, str) and x.strip()],
            "ops": [o for o in LOCAL_OPS if o in r["ops"]]}


def local_set(roots, ops):
    """Validated rules from the owner's edit. Roots must be absolute or ~."""
    if not isinstance(roots, list) or not isinstance(ops, list):
        raise IntegrationError("roots and ops must be lists", 400)
    clean = []
    for x in roots:
        x = (x or "").strip() if isinstance(x, str) else ""
        if not (x.startswith("/") or x == "~" or x.startswith("~/")):
            raise IntegrationError("Folders must start with / or ~ (got %r)" % x, 400)
        if x not in clean:
            clean.append(x)
    bad = [o for o in ops if o not in LOCAL_OPS]
    if bad:
        raise IntegrationError("Unknown operation %r" % bad[0], 400)
    return {"roots": clean, "ops": [o for o in LOCAL_OPS if o in ops]}


def local_allows(rules, real_path, op, expand):
    """Whether an agent may do `op` at `real_path` (already resolved — no ..
    or symlink left). `expand(root)` resolves a root the same way, so the
    containment check compares like with like. Pure apart from `expand`."""
    if op not in rules["ops"]:
        return False
    for root in rules["roots"]:
        r = expand(root).rstrip("/") or "/"
        if r == "/" or real_path == r or real_path.startswith(r + "/"):
            return True
    return False


def local_view(rules):
    return {"roots": rules["roots"], "ops": [{"id": o, "label": OP_LABELS[o], "on": o in rules["ops"]}
                                             for o in LOCAL_OPS]}
