"""viewer.drive_oauth — the loopback OAuth consent flow for cloud-drive adapters.

The viewer is the OAuth *client*: it holds the vendor's client id (and, for a
confidential client such as Google, its secret) in one shared DRIVES_OAUTH_FILE
and performs the PKCE code exchange itself. The browser
is only a dumb opener of the consent URL — the per-user token never passes
through it, and no public callback URL is ever registered. This is the RFC 8252
desktop loopback flow: a transient 127.0.0.1 listener on a free port (random,
or the port the client file registers when the vendor — Dropbox — matches the
redirect_uri exactly, port included), PKCE S256. A second machine needs only the
shared client file — it runs its own loopback with its own PKCE.

In-flight flows live in _PENDING (module memory, like CHAT_JOBS): a consent is a
short interactive session, so it need not survive a viewer restart — a restart
just means the user opens the consent URL again.

Pure helpers (_pkce, _build_auth_url) are unit-tested without a network; the
loopback listener and token exchange are tested end-to-end against a real
127.0.0.1 socket with the _http seam faked, so the "does the loopback actually
work" risk is covered, not just the URL string.
"""
import base64
import hashlib
import json
import secrets
import socket
import threading
import time
import urllib.parse

from viewer import db
from viewer.drives import ADAPTERS, DriveError, _http, _vendor_client

# pending_id -> {kind, drive_id, client, code_verifier, state, redirect_uri,
#                port, status, error}
_PENDING = {}
_LOCK = threading.Lock()

_CONSENT_TTL = 600   # seconds to wait for the loopback redirect before expiring
_TOKEN_TTL = 30      # seconds for the token exchange itself
_BROWSER_HTML = ("<html><head><title>Harman</title>"
                 "<meta charset=utf-8></head>"
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


def _redirect_target(client):
    """(host, port) of the client's registered loopback redirect, e.g.
    ('localhost', 0) from 'http://localhost' or ('localhost', 53682) from
    'http://localhost:53682'. Google and Microsoft ignore the port when
    matching a loopback redirect (RFC 8252), so a registration without a port
    lets us bind any free one (port 0). Dropbox matches the whole URI, port
    included — registering a fixed port in the client file makes us bind
    exactly that port so the redirect_uri we send is the one on record."""
    urs = client.get("redirect_uris") or []
    if not urs:
        return "localhost", 0  # the desktop-client default
    u = urllib.parse.urlparse(urs[0])
    return u.hostname or "localhost", int(u.port or 0)


def _build_auth_url(kind, client, port, state, verifier, challenge):
    """The consent URL the browser opens + its redirect_uri. Pure (no I/O)."""
    v = _VENDORS[kind]
    redirect_uri = "http://%s:%d" % (_redirect_target(client)[0], port)
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
    return v["auth"] + "?" + urllib.parse.urlencode(q), redirect_uri


def start(kind, drive_id):
    """Begin a consent flow for `drive_id`. Returns {url, pending}: the caller
    opens `url` in a browser and polls status() with `pending`. The loopback
    listener completes the code exchange in the viewer and persists the tokens
    to the drive row when the vendor redirects back to it."""
    if kind not in _VENDORS:
        raise DriveError("No OAuth flow built for vendor '%s' yet" % kind, 501)
    drive = db.drive_get(drive_id)
    if drive is None:
        raise DriveError("Unknown drive %r" % drive_id, 404)
    client = _vendor_client(kind, public=_VENDORS[kind]["public"])  # 403 with guidance if unset

    verifier, challenge = _pkce()
    state = secrets.token_urlsafe(16)

    # Bind the registered loopback port (or :0 for any free one) and hand the
    # socket to the listener thread. Loopback-only: nothing external can reach it.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", _redirect_target(client)[1]))
    except OSError as e:
        sock.close()
        raise DriveError("The registered loopback port is busy (%s) — is another sign-in "
                         "still open? Finish or wait for it to expire." % e, 409)
    sock.listen(1)
    port = sock.getsockname()[1]
    sock.settimeout(_CONSENT_TTL)

    url, redirect_uri = _build_auth_url(kind, client, port, state, verifier, challenge)

    p = {"kind": kind, "drive_id": drive_id, "client": client,
         "code_verifier": verifier, "state": state, "redirect_uri": redirect_uri,
         "port": port, "status": "waiting", "error": None}
    with _LOCK:
        pid = secrets.token_urlsafe(8)
        _PENDING[pid] = p
    threading.Thread(target=_wait, args=(sock, pid), daemon=True).start()
    return {"url": url, "pending": pid}


def status(pid):
    """The current state of an in-flight flow: {pending, status, error?} where
    status is 'waiting' | 'authorized' | 'failed' | 'expired'. Unknown pid →
    404."""
    with _LOCK:
        p = _PENDING.get(pid)
        if p is None:
            raise DriveError("Unknown or expired OAuth flow", 404)
        out = {"pending": pid, "status": p["status"]}
        if p.get("error"):
            out["error"] = p["error"]
        return out


def _finish(pid, status_, error=None):
    with _LOCK:
        p = _PENDING.get(pid)
        if p is not None:
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
    status, _hdr, data = _http("POST", v["token"],
                               headers={"Content-Type": "application/x-www-form-urlencoded"},
                               data=body)
    if status != 200:
        msg = ""
        try:
            j = json.loads(data.decode("utf-8", "replace"))
            msg = j.get("error_description") or j.get("error") or ""
        except Exception:
            msg = data.decode("utf-8", "replace")[:200]
        raise DriveError("Token exchange failed: %s" % (msg or ("HTTP %d" % status)), 502)
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


def _respond(conn, kind, ok, msg):
    """Send a single HTML page to the browser and close it (best-effort — a
    send failure here must not lose the tokens we're about to exchange)."""
    page = _BROWSER_HTML.format(
        title="%s connected" % _VENDORS[kind]["label"] if ok else "Connection didn't complete",
        msg=msg)
    raw = page.encode("utf-8")
    http = ("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
            "Content-Length: %d\r\nConnection: close\r\n\r\n" % len(raw)).encode() + raw
    try:
        conn.sendall(http)
    except Exception:
        pass


def _wait(sock, pid):
    """Serve exactly one GET (the vendor's loopback redirect), exchange the code in
    the viewer, persist the tokens, and mark the flow done. Any failure path
    marks the flow 'failed'/'expired' with a human-readable reason so the UI
    can say what happened."""
    p = _PENDING.get(pid)
    if p is None:
        try:
            sock.close()
        except Exception:
            pass
        return
    code = state = error = None
    try:
        conn, _ = sock.accept()
    except socket.timeout:
        _finish(pid, "expired", "no consent received in time")
        try:
            sock.close()
        except Exception:
            pass
        return
    except Exception as e:
        _finish(pid, "failed", "listener error: %s" % e)
        try:
            sock.close()
        except Exception:
            pass
        return

    try:
        raw = b""
        conn.settimeout(10)
        while b"\r\n\r\n" not in raw and len(raw) < 16384:
            try:
                chunk = conn.recv(4096)
            except Exception:
                break
            if not chunk:
                break
            raw += chunk
        line = raw.split(b"\r\n", 1)[0].decode("utf-8", "replace")
        parts = line.split(" ")
        if len(parts) >= 2 and parts[0] == "GET":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(parts[1]).query)
            code = (q.get("code") or [None])[0]
            state = (q.get("state") or [None])[0]
            error = (q.get("error") or [None])[0]
        _respond(conn, p["kind"], error is None and code is not None and state == p["state"],
                 "The code exchange happens in Harman." if code else
                 "%s did not return a code (%s)." % (_VENDORS[p["kind"]]["label"], error or "unknown"))
    except Exception as e:
        _finish(pid, "failed", "error reading the redirect: %s" % e)
        try:
            conn.close()
        except Exception:
            pass
        try:
            sock.close()
        except Exception:
            pass
        return
    finally:
        try:
            conn.close()
        except Exception:
            pass
        try:
            sock.close()
        except Exception:
            pass

    if error:
        _finish(pid, "failed", "denied: %s" % error)
        return
    if code is None:
        _finish(pid, "failed", "no code in redirect")
        return
    if state != p["state"]:
        _finish(pid, "failed", "state mismatch (possible CSRF) — try again")
        return
    p["code"] = code
    try:
        tokens = _exchange(p)
    except DriveError as e:
        _finish(pid, "failed", str(e))
        return
    try:
        _store(p, tokens)
    except DriveError as e:
        _finish(pid, "failed", str(e))
        return
    _finish(pid, "authorized")
