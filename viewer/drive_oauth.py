"""viewer.drive_oauth — the hosted OAuth consent flow for cloud-drive adapters.

The viewer is the OAuth *client*: it holds the vendor's client id (and, for a
confidential client such as Google, its secret) in settings['drive_clients'],
entered once from the app's Integrations dialog, and performs the PKCE code exchange itself. The user's browser may be on ANY
device — a phone reaching the viewer through its public hostname — so the
vendor redirects back to the viewer's own HTTPS callback
(`<origin>/api/drive/oauth/callback`), never to a loopback port on the server
machine. The origin is the one the requesting browser used (server.request_
origin), so a new deployment self-configures: register that hostname's callback
with the vendor once and nothing else is stored anywhere.

The callback is served without a session cookie (a cross-site top-level
redirect from the vendor carries no SameSite=Strict cookie); the `state`
value — 128 random bits minted at start() and consumed exactly once — is what
binds the redirect to an in-flight consent. In-flight flows live in _PENDING
(module memory, like CHAT_JOBS): a consent is a short interactive session, so
it need not survive a viewer restart — a restart just means the user clicks
"Add …" again.

Pure helpers (_pkce, _build_auth_url, redirect_uri_for) are unit-tested without
a network; start → callback → exchange → persist is tested end-to-end with the
_http seam faked, so "does a redirect really become stored tokens" is covered.
"""
import base64
import hashlib
import json
import secrets
import threading
import time
import urllib.parse

from viewer import db
from viewer.drives import ADAPTERS, DriveError, _http, _vendor_client

CALLBACK_PATH = "/api/drive/oauth/callback"

# pending_id -> {kind, drive_id, client, code_verifier, state, redirect_uri,
#                started, status, error}
_PENDING = {}
_LOCK = threading.Lock()

_CONSENT_TTL = 600   # seconds a started consent may wait for its redirect
_BROWSER_HTML = ("<html><head><title>Harman</title>"
                 "<meta charset=utf-8><meta name=viewport content='width=device-width'></head>"
                 "<body style='font-family:system-ui;padding:3rem'>"
                 "<h2>{title}</h2><p>{msg}</p>"
                 "<p style='color:#666'>You can close this window.</p>"
                 "</body></html>")

# Endpoints, scope and the vendor-specific authorize parameters for each vendor
# with a built OAuth flow. `public` marks a PKCE public client (no secret is
# sent anywhere); `extra` is what that vendor needs on the authorize URL to
# hand back a refresh token (each spells "offline" its own way).
_VENDORS = {
    "google": {
        "label": "Google Drive",
        "auth": "https://accounts.google.com/o/oauth2/v2/auth",
        "token": "https://oauth2.googleapis.com/token",
        "scope": "https://www.googleapis.com/auth/drive",
        "extra": {"access_type": "offline", "prompt": "consent"},
        "public": False,
    },
    "dropbox": {
        "label": "Dropbox",
        "auth": "https://www.dropbox.com/oauth2/authorize",
        "token": "https://api.dropboxapi.com/oauth2/token",
        "scope": "files.metadata.read files.content.read files.content.write account_info.read",
        "extra": {"token_access_type": "offline"},
        "public": True,
    },
    "onedrive": {
        "label": "OneDrive",
        "auth": "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
        "token": "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        "scope": "Files.ReadWrite offline_access User.Read",
        "extra": {},
        "public": True,
    },
}


def vendor(kind):
    """The public facts about one vendor's flow (label, public-client flag)
    the Integrations UI shows; KeyError for a kind outside available_vendors()."""
    return {"label": _VENDORS[kind]["label"], "public": _VENDORS[kind]["public"]}


def available_vendors():
    """The vendor kinds with a built consent flow — the set the UI may offer for
    connecting a new drive. A vendor ships by adding a _VENDORS entry; nothing
    else changes (the route and the picker both read this)."""
    return frozenset(_VENDORS)


def _pkce():
    """(code_verifier, code_challenge) using S256. The verifier is a random
    43-char URL-safe string (RFC 7636's 43-128 window); the challenge is
    base64url(SHA-256(verifier)) with no padding."""
    verifier = secrets.token_urlsafe(32)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def redirect_uri_for(origin):
    """The callback the vendor must have on record for this deployment, from
    the origin the browser reached us on (e.g. 'https://life.suhai.ai'). Every
    vendor matches redirect_uri against its registration verbatim, so this
    exact string is what the owner registers — start() returns it so a
    mismatch error can show precisely what to add."""
    return origin.rstrip("/") + CALLBACK_PATH


def _build_auth_url(kind, client, redirect_uri, state, challenge):
    """The consent URL the browser opens. Pure (no I/O)."""
    v = _VENDORS[kind]
    q = {
        "client_id": client["client_id"],
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": v["scope"],
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    q.update(v["extra"])   # the vendor's own "give me a refresh token" spelling
    return v["auth"] + "?" + urllib.parse.urlencode(q)


def _expire_stale(now):
    """A consent nobody completed within _CONSENT_TTL is 'expired' (the UI
    tells the user to try again) and is forgotten a TTL later so _PENDING
    cannot grow without bound."""
    for pid, p in list(_PENDING.items()):
        age = now - p["started"]
        if p["status"] == "waiting" and age > _CONSENT_TTL:
            p["status"], p["error"] = "expired", "no consent received in time"
        if age > 2 * _CONSENT_TTL:
            del _PENDING[pid]


def start(kind, drive_id, origin):
    """Begin a consent flow for `drive_id` from a browser that reached us at
    `origin`. Returns {url, pending, redirect_uri}: the caller opens `url` in
    a browser and polls status() with `pending`; the vendor lands the user on
    `redirect_uri` (this server's callback), which completes the exchange."""
    if kind not in _VENDORS:
        raise DriveError("No OAuth flow built for vendor '%s' yet" % kind, 501)
    drive = db.drive_get(drive_id)
    if drive is None:
        raise DriveError("Unknown drive %r" % drive_id, 404)
    client = _vendor_client(kind, public=_VENDORS[kind]["public"])  # 403 with guidance if unset

    verifier, challenge = _pkce()
    state = secrets.token_urlsafe(16)
    redirect_uri = redirect_uri_for(origin)
    url = _build_auth_url(kind, client, redirect_uri, state, challenge)

    p = {"kind": kind, "drive_id": drive_id, "client": client,
         "code_verifier": verifier, "state": state, "redirect_uri": redirect_uri,
         "started": time.time(), "status": "waiting", "error": None}
    with _LOCK:
        _expire_stale(p["started"])
        pid = secrets.token_urlsafe(8)
        _PENDING[pid] = p
    return {"url": url, "pending": pid, "redirect_uri": redirect_uri}


def status(pid):
    """The current state of an in-flight flow: {pending, status, error?} where
    status is 'waiting' | 'authorized' | 'failed' | 'expired'. Unknown pid →
    404."""
    with _LOCK:
        _expire_stale(time.time())
        p = _PENDING.get(pid)
        if p is None:
            raise DriveError("Unknown or expired OAuth flow", 404)
        out = {"pending": pid, "status": p["status"]}
        if p.get("error"):
            out["error"] = p["error"]
        return out


def _claim(state):
    """Consume the waiting flow whose state matches — exactly once. A replayed
    or forged redirect finds nothing and is answered with a generic page; it
    can never touch a flow it did not start."""
    with _LOCK:
        _expire_stale(time.time())
        for p in _PENDING.values():
            if p["status"] == "waiting" and secrets.compare_digest(p["state"], state):
                p["status"] = "exchanging"
                return p
    return None


def _finish(p, status_, error=None):
    with _LOCK:
        p["status"] = status_
        p["error"] = error


def _exchange(p):
    """Swap the authorization code for tokens at the vendor's token endpoint
    (runs in the viewer — the token never touches the browser). A public
    client proves itself with the PKCE verifier alone; a confidential one adds
    its secret."""
    v = _VENDORS[p["kind"]]
    form = {
        "code": p["code"],
        "client_id": p["client"]["client_id"],
        "grant_type": "authorization_code",
        "code_verifier": p["code_verifier"],
        "redirect_uri": p["redirect_uri"],
    }
    if p["client"].get("client_secret"):
        form["client_secret"] = p["client"]["client_secret"]
    body = urllib.parse.urlencode(form).encode()
    status_, _hdr, data = _http("POST", v["token"],
                                headers={"Content-Type": "application/x-www-form-urlencoded"},
                                data=body)
    if status_ != 200:
        msg = ""
        try:
            j = json.loads(data.decode("utf-8", "replace"))
            msg = j.get("error_description") or j.get("error") or ""
        except Exception:
            msg = data.decode("utf-8", "replace")[:200]
        raise DriveError("Token exchange failed: %s" % (msg or ("HTTP %d" % status_)), 502)
    return json.loads(data.decode("utf-8", "replace"))


def _store(p, tokens):
    """Persist the granted tokens into the drive row (the adapter reads them
    from config on its next call and refreshes via _refresh when expired), and
    record WHOSE account signed in (best-effort — the picker shows it, and a
    failed lookup must not undo a successful consent)."""
    drive = db.drive_get(p["drive_id"])
    if drive is None:
        raise DriveError("Drive row vanished during OAuth", 404)
    cfg = dict(drive.get("config") or {})
    cfg.update({
        "access_token": tokens.get("access_token"),
        "refresh_token": tokens.get("refresh_token"),
        "token_expiry": int(time.time()) + int(tokens.get("expires_in", 3600)),
    })
    row = {"label": drive["label"], "kind": drive["kind"], "config": cfg,
           "status": drive.get("status") or "active",
           "hidden": bool(drive.get("hidden"))}
    try:
        cls = ADAPTERS.get(drive["kind"])
        account = cls(dict(row, id=p["drive_id"])).whoami() if cls else ""
        if account:
            cfg["account"] = account
    except Exception:
        pass
    db.drive_upsert(p["drive_id"], row)


def _page(title, msg):
    return _BROWSER_HTML.format(title=title, msg=msg)


def callback(query):
    """Complete the consent the vendor just redirected: `query` is the parsed
    callback query ({name: [values]}). Exchanges the code, persists the tokens
    and marks the flow so the polling UI sees it; returns the HTML page the
    browser shows. Every failure path leaves a human-readable reason on the
    flow (the UI shows it) and a plain page here — the browser tab is a dead
    end by design, the app is where the result lands."""
    state = (query.get("state") or [""])[0]
    p = _claim(state) if state else None
    if p is None:
        return _page("Connection didn't complete",
                     "This sign-in link is not for a connection that is still waiting. "
                     "Go back to Harman and click Add again.")
    label = _VENDORS[p["kind"]]["label"]
    error = (query.get("error") or [None])[0]
    code = (query.get("code") or [None])[0]
    if error:
        _finish(p, "failed", "denied: %s" % error)
        return _page("Connection didn't complete", "%s did not grant access (%s)." % (label, error))
    if not code:
        _finish(p, "failed", "no code in redirect")
        return _page("Connection didn't complete", "%s did not return a code." % label)
    p["code"] = code
    try:
        _store(p, _exchange(p))
    except DriveError as e:
        _finish(p, "failed", str(e))
        return _page("Connection didn't complete", str(e))
    _finish(p, "authorized")
    return _page("%s connected" % label, "Harman can now use this drive.")
