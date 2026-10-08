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

Token providers. Most clouds, networks and community APIs sign in with an
API token the owner creates in the vendor's console, not OAuth: `via` is
"token", the connect route probes the vendor's `verify` endpoint before saving
(drives row config: api_token, account, scopes — never access/refresh_token,
so no OAuth refresh ever touches it), and agents reach the API through ONE
proxy (api_call): the server adds the credential, pins the request to the
provider's own host, and maps the HTTP method to an op — `read` (GET, or a
POST the provider lists as a read) on by default, `change` off by default
because a change can spend money or move DNS. A provider whose every service
is unavailable is catalog-only: listed with the reason, never connectable.

Token vendor facts (VERIFIED 2026-10-07 against each vendor's API docs):
  - Cloudflare GET /client/v4/user/tokens/verify; a bad token is 400, not 401.
  - DigitalOcean GET /v2/account → account.email; Vultr GET /v2/account →
    account.email; Linode GET /v4/profile → username; Hetzner Cloud tokens
    are per project (GET /v1/locations, 401 when bad).
  - Tailscale API access tokens last 1–90 days (GET /api/v2/tailnet/-/keys).
  - Discord bot calls need "Authorization: Bot <token>" and a User-Agent of
    the form "DiscordBot (url, version)".
  - Mixpanel service accounts use HTTP Basic (username:secret), GET /api/app/me.
  - Odoo's JSON-2 API: POST https://<host>/json/2/<model>/<method>, Bearer API
    key, X-Odoo-Database when the server hosts several; reads are POSTs too.
  - Not connectable yet, with the vendor's reason: AWS/Lightsail (SigV4
    signing not built; the Free plan gives $100–200 credits for 6 months),
    Azure (Entra service principal), Google Cloud (Always Free = one e2-micro
    in us-west1/us-central1/us-east1), X (pay-per-use credits), Reddit
    (Responsible Builder approval), Meta (App Review), TikTok (unaudited apps
    post privately), IRS e-file (authorized providers only, no consumer API).
HYPOTHESIS: YouTube and Google Ads will ride the Google sign-in (youtube.*,
adwords scopes); Google Ads also needs an approved developer token.

Setup. Each provider carries `setup`: the ordered steps the owner follows in
the vendor's console, with deep links; a step marked `redirect` is where the
page shows this deployment's callback address. Clients render the list — no
client spells a vendor console step.
"""
import base64
import json


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

# Where each provider shows under "Add an account", in this order.
CATEGORIES = (("workspace", "Files, mail & calendar"), ("compute", "Compute"),
              ("network", "Networking & DNS"), ("social", "Social & community"),
              ("analytics", "Analytics"), ("ads", "Ads"), ("erp", "Business (ERP)"),
              ("tax", "Tax"))
for _p in PROVIDERS.values():
    _p.update(via="oauth", category="workspace")

# A token provider's extra inputs beyond the token. `name` (every provider) is
# how the owner tells two accounts apart — a Hetzner token covers ONE project.
_NAME = {"id": "name", "label": "Name", "placeholder": "Optional — e.g. Production", "required": False}
_UA = "Harman/1.0 (+https://life.suhai.ai)"
_TOKEN = []      # (provider id, service entry), turned into SERVICES below


def _token(pid, label, category, base, verify, setup, agent, try_, docs, account="",
           auth="bearer", fields=(), headers=None, reads=(), verify_method="GET"):
    PROVIDERS[pid] = {"label": label, "via": "token", "category": category, "public": False,
                      "base": base, "verify": verify, "verify_method": verify_method,
                      "account": account, "header": auth, "headers": dict({"User-Agent": _UA}, **(headers or {})),
                      "fields": (_NAME,) + tuple(fields), "reads": tuple(reads), "docs": docs,
                      "setup": tuple(setup) + ({"text": "Paste the token below. Harman checks it with "
                                                        + label + " before saving."},)}
    _TOKEN.append({"id": pid + ".api", "provider": pid, "label": label, "kind": "api",
                   "scopes": (pid + ".api",),
                   "ops": {"read": {"scopes": (), "default": True},
                           "change": {"scopes": (), "default": False}},
                   "agent": agent, "try": try_, "available": True})


def _planned(pid, label, category, reason, link=None):
    """Listed so the owner knows it was considered and why it can't connect."""
    PROVIDERS[pid] = {"label": label, "via": "token", "category": category, "public": False,
                      "fields": (), "setup": ({"text": reason, "links": (link,) if link else ()},)}
    _TOKEN.append({"id": pid + ".api", "provider": pid, "label": label, "kind": "api",
                   "scopes": (), "ops": {}, "agent": "", "try": "", "available": False,
                   "unavailable": reason})


_token("cloudflare", "Cloudflare", "network", "https://api.cloudflare.com/client/v4", "/user/tokens/verify",
       ({"text": "Create a token under My Profile → API Tokens. Start from a template such as Edit zone DNS, "
                 "or tick only what agents should touch.",
         "links": (("API Tokens", "https://dash.cloudflare.com/profile/api-tokens"),)},),
       "DNS, Workers, Pages, R2 storage and tunnels — free tiers included. Agents read freely; "
       "changes only if you allow them.",
       "List my Cloudflare zones and their DNS records, and point out anything misconfigured.",
       "https://developers.cloudflare.com/api/")
_token("tailscale", "Tailscale", "network", "https://api.tailscale.com/api/v2", "/tailnet/-/keys",
       ({"text": "Generate an API access token. It lasts 1 to 90 days; when it ends, Harman asks you for a new one.",
         "links": (("Keys", "https://login.tailscale.com/admin/settings/keys"),)},),
       "See your tailnet's machines, keys and access rules; change them only if you allow it.",
       "List the machines on my tailnet, when each was last seen, and any key that expires within 30 days.",
       "https://tailscale.com/api")
_token("hetzner", "Hetzner Cloud", "compute", "https://api.hetzner.cloud/v1", "/locations",
       ({"text": "Open a project → Security → API tokens → Generate API token. Choose Read unless agents "
                 "should create servers (that costs money). A token covers one project.",
         "links": (("Projects", "https://console.hetzner.cloud/projects"),)},),
       "See servers, volumes, firewalls and prices in one project; create or change them only if you allow it.",
       "List my Hetzner Cloud servers with their type, location and monthly price.",
       "https://docs.hetzner.cloud/")
_token("digitalocean", "DigitalOcean", "compute", "https://api.digitalocean.com/v2", "/account",
       ({"text": "Generate a personal access token. Choose Read only unless agents should create droplets "
                 "(that costs money).",
         "links": (("API tokens", "https://cloud.digitalocean.com/account/api/tokens"),)},),
       "See droplets, apps, databases, Spaces and billing; create or change them only if you allow it.",
       "List my DigitalOcean droplets and apps with their size, region and this month's bill so far.",
       "https://docs.digitalocean.com/reference/api/", account="account.email")
_token("vultr", "Vultr", "compute", "https://api.vultr.com/v2", "/account",
       ({"text": "Enable the API and copy the key. Under Access Control, allow this server's address.",
         "links": (("API", "https://my.vultr.com/settings/#settingsapi"),)},),
       "See instances, bare metal and billing; create or change them only if you allow it.",
       "List my Vultr instances with their plan, region and monthly cost.",
       "https://www.vultr.com/api/", account="account.email")
_token("linode", "Akamai (Linode)", "compute", "https://api.linode.com/v4", "/profile",
       ({"text": "Create a personal access token. Give Read Only to what agents should only look at.",
         "links": (("API tokens", "https://cloud.linode.com/profile/tokens"),)},),
       "See Linodes, volumes, domains and invoices; create or change them only if you allow it.",
       "List my Linodes with their plan, region and status.",
       "https://techdocs.akamai.com/linode-api/reference/api", account="username")
_planned("aws", "Amazon Web Services", "compute",
         "Needs AWS request signing, which Harman doesn't do yet. New AWS accounts get $100–200 of credits for 6 months.",
         ("AWS Free Tier", "https://aws.amazon.com/free/"))
_planned("lightsail", "AWS Lightsail", "compute",
         "Uses the same AWS request signing, which Harman doesn't do yet.",
         ("Lightsail", "https://aws.amazon.com/lightsail/"))
_planned("azure", "Microsoft Azure", "compute",
         "Needs a Microsoft Entra service principal, which Harman doesn't set up yet.",
         ("Azure free account", "https://azure.microsoft.com/free/"))
_planned("gcp", "Google Cloud", "compute",
         "Will connect through your Google sign-in; not built yet. Always Free includes one e2-micro VM "
         "in us-west1, us-central1 or us-east1.",
         ("Free tier", "https://cloud.google.com/free"))
_planned("oracle", "Oracle Cloud", "compute",
         "Needs Oracle's request signing, which Harman doesn't do yet.",
         ("Always Free", "https://www.oracle.com/cloud/free/"))
_token("discord", "Discord", "social", "https://discord.com/api/v10", "/users/@me",
       ({"text": "Create an application, open Bot, press Reset Token and copy it.",
         "links": (("Applications", "https://discord.com/developers/applications"),)},
        {"text": "Invite the bot to your server: OAuth2 → URL Generator, tick bot and the permissions it needs."}),
       "Read your servers' channels as your bot; post messages only if you allow it.",
       "List the Discord servers and channels my bot can see.",
       "https://discord.com/developers/docs/reference", account="username", auth="bot",
       headers={"User-Agent": "DiscordBot (https://life.suhai.ai, 1.0)"})
_planned("x", "X (Twitter)", "social",
         "X charges for API use (pay-per-use credits). Connect it once you decide to buy credits; not built yet.",
         ("Developer portal", "https://developer.x.com/"))
_planned("reddit", "Reddit", "social",
         "Reddit must approve each app under its Responsible Builder policy before it may use the API.",
         ("Developer platform", "https://www.reddit.com/prefs/apps"))
_planned("instagram", "Instagram", "social",
         "Meta must review the app (App Review) before it may post for you.",
         ("Meta for Developers", "https://developers.facebook.com/"))
_planned("facebook", "Facebook", "social",
         "Meta must review the app (App Review) before it may post for you.",
         ("Meta for Developers", "https://developers.facebook.com/"))
_planned("tiktok", "TikTok", "social",
         "Until TikTok audits the app, everything it posts stays private.",
         ("TikTok for Developers", "https://developers.tiktok.com/"))
_planned("youtube", "YouTube", "social",
         "Will connect through your Google sign-in; not built yet.")
_token("mixpanel", "Mixpanel", "analytics", "https://mixpanel.com/api", "/app/me",
       ({"text": "Create a service account under Organization settings → Service accounts and give it your project.",
         "links": (("Service accounts", "https://mixpanel.com/settings/org#serviceaccounts"),)},
        {"text": "Enter its username, and paste its secret as the token."}),
       "Query events, funnels and retention in your projects; change data only if you allow it.",
       "Which Mixpanel events grew or dropped the most in the last 7 days compared with the 7 before?",
       "https://developer.mixpanel.com/reference/overview", auth="basic",
       fields=({"id": "username", "label": "Service account username", "placeholder": "name.123abc.mp-service-account",
                "required": True},))
_planned("googleads", "Google Ads", "ads",
         "Needs a developer token Google approves, on top of your Google sign-in; not built yet.",
         ("Google Ads API", "https://developers.google.com/google-ads/api/docs/get-started/dev-token"))
_token("odoo", "Odoo", "erp", "https://{host}/json/2", "/res.users/context_get",
       ({"text": "In Odoo, open your profile → Account Security → New API Key. Odoo Online needs a Custom plan "
                 "for API access.",
         "links": (("External API", "https://www.odoo.com/documentation/19.0/developer/reference/external_api.html"),)},),
       "Read customers, invoices, sales and stock; create or change records only if you allow it.",
       "Summarize my open Odoo sales orders and unpaid invoices.",
       "https://www.odoo.com/documentation/19.0/developer/reference/external_api.html",
       verify_method="POST",
       fields=({"id": "host", "label": "Odoo address", "placeholder": "mycompany.odoo.com", "required": True},
               {"id": "db", "label": "Database", "placeholder": "Only if the server hosts several", "required": False}),
       reads=("/search", "/search_read", "/search_count", "/read", "/read_group", "/fields_get",
              "/name_search", "/context_get"))
_planned("tax", "Tax filing", "tax",
         "The IRS takes e-filing only from authorized providers, and none offers a consumer API. "
         "Agents can prepare your numbers and forms in Files for you to file.",
         ("IRS e-file", "https://www.irs.gov/e-file-providers/authorized-irs-e-file-providers-for-individuals"))

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
) + tuple(_TOKEN)

OP_LABELS = {"read": "Read", "write": "Save files", "delete": "Delete", "draft": "Write drafts",
             "create": "Add events", "update": "Edit events", "change": "Make changes"}

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
    if p["via"] != "oauth":
        raise IntegrationError("%s connects with an API token, not a sign-in" % p["label"], 400)
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


# --- API-token providers -----------------------------------------------------

def _clean_fields(p, fields):
    """The provider's declared fields from the owner's input, trimmed; a
    missing required one is a 400 naming it."""
    fields = fields if isinstance(fields, dict) else {}
    out = {}
    for f in p.get("fields", ()):
        v = fields.get(f["id"])
        v = v.strip() if isinstance(v, str) else ""
        if f["required"] and not v:
            raise IntegrationError("%s is required" % f["label"], 400)
        if v:
            out[f["id"]] = v
    if "host" in out:
        host = out["host"].split("://", 1)[-1].strip("/").lower()
        if not host or any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789.-:" for ch in host):
            raise IntegrationError("Enter the address as a host name, e.g. mycompany.odoo.com", 400)
        out["host"] = host
    return out


def _headers(p, token, fields):
    if p["header"] == "basic":
        auth = "Basic " + base64.b64encode(("%s:%s" % (fields.get("username", ""), token)).encode()).decode()
    else:
        auth = ("Bot " if p["header"] == "bot" else "Bearer ") + token
    h = dict(p["headers"], Authorization=auth, Accept="application/json")
    if fields.get("db"):
        h["X-Odoo-Database"] = fields["db"]
    return h


def _base(p, fields):
    return p["base"].replace("{host}", fields.get("host", ""))


def verify_request(pid, token, fields):
    """(method, url, headers, data, fields) for the probe that proves a token
    works before it is saved. Raises 400/404/409 for what the owner must fix."""
    p = provider(pid)
    if p["via"] != "token":
        raise IntegrationError("%s connects with a sign-in, not an API token" % p["label"], 400)
    if "verify" not in p:
        raise IntegrationError("%s can't be connected yet: %s" % (p["label"], services_of(pid)[0]["unavailable"]), 409)
    token = token.strip() if isinstance(token, str) else ""
    if not token:
        raise IntegrationError("Paste the token first", 400)
    fields = _clean_fields(p, fields)
    data = b"{}" if p["verify_method"] == "POST" else None
    h = _headers(p, token, fields)
    if data is not None:
        h["Content-Type"] = "application/json"
    return p["verify_method"], _base(p, fields) + p["verify"], h, data, fields


def account_from(pid, body, fields):
    """A readable account name from the probe's JSON (DigitalOcean's
    account.email, Linode's username…), else the owner's name for it, else
    the host, else ""."""
    path = provider(pid).get("account") or ""
    v = body if path else None
    for k in path.split(".") if path else ():
        v = v.get(k) if isinstance(v, dict) else None
    if isinstance(v, str) and v:
        return "%s (%s)" % (fields["name"], v) if fields.get("name") else v
    return fields.get("name") or fields.get("host") or ""


API_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")


def api_op(pid, method, path):
    """'read' or 'change': GETs read; a POST the provider lists in `reads`
    (Odoo's search_read…) reads too; anything else changes something."""
    p = provider(pid)
    if method == "GET" or (method == "POST" and any(path.split("?")[0].endswith(r) for r in p.get("reads", ()))):
        return "read"
    return "change"


def api_request(conn, method, path, body=None):
    """(op, method, url, headers, data) for an agent's call through a token
    connection. The path is pinned under the provider's own base URL — no
    scheme, host, `..` or fragment may steer the credential elsewhere."""
    p = provider(conn["kind"])
    if p["via"] != "token" or "base" not in p:
        raise IntegrationError("%s is not an API-token connection" % account_of(conn), 400)
    method = (method or "GET").upper()
    if method not in API_METHODS:
        raise IntegrationError("method must be one of %s" % ", ".join(API_METHODS), 400)
    path = path if isinstance(path, str) else ""
    if not path.startswith("/") or "://" in path or ".." in path or "#" in path or "\\" in path \
            or any(ord(ch) < 33 for ch in path):
        raise IntegrationError("path must be an API path such as /zones, relative to %s" % p["label"], 400)
    cfg = conn.get("config") or {}
    fields = cfg.get("fields") or {}
    h = _headers(p, cfg.get("api_token") or "", fields)
    data = None
    if body is not None and method != "GET":
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    return api_op(conn["kind"], method, path), method, _base(p, fields) + path, h, data


def token_config(pid, token, account, fields):
    """The drives-row config for a verified token: every service of the
    provider granted (the token's own permissions are the vendor's to
    enforce). Stored as api_token — never access/refresh_token, so no OAuth
    refresh path ever picks it up."""
    return {"api_token": token.strip(), "account": account, "fields": fields,
            "scopes": sorted({x for s in services_of(pid) for x in s["scopes"]})}


def view(conns, clients, redirect_uri):
    """Everything the Integrations page renders, in one response. Secrets and
    tokens never appear: a client reports presence flags, a connection its
    account and per-service state."""
    out = []
    for pid, p in PROVIDERS.items():
        c = clients.get(pid) or {}
        svcs = services_of(pid)
        token = p["via"] == "token"
        out.append({
            "id": pid,
            "label": p["label"],
            "auth": p["via"],
            "category": p["category"],
            "fields": [dict(f) for f in p.get("fields", ())],
            "public": p["public"],
            "setup": [{"text": st["text"], "redirect": bool(st.get("redirect")),
                       "links": [{"label": l, "url": u} for l, u in st.get("links", ())]}
                      for st in p["setup"]],
            "client": {"client_id": "", "has_secret": False, "configured": True} if token else {
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
    return {"providers": out, "redirect_uri": redirect_uri,
            "categories": [{"id": k, "label": v} for k, v in CATEGORIES]}


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
            if s["kind"] == "api":
                entry["docs"] = PROVIDERS[conn["kind"]]["docs"]
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
              "api": "api_call with connection=",
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
            bits.append("tools " + e["tools"] + (e["drive"] if "drive" in e else
                                                 e["connection"] if "docs" in e else ""))
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
