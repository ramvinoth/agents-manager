"""orchestrator.push — background push notifications to the mobile app via APNs.

The iOS app registers its raw APNs device token (getDevicePushTokenAsync) after
login. When a chat run finishes a turn or a tool needs approval, the server
signs a short-lived ES256 JWT with the team's APNs auth key (.p8) and POSTs the
alert to Apple over HTTP/2. No Expo dependency — Apple is contacted directly.

Config comes from the environment (set in the systemd unit / launch env):
  APNS_KEY_PATH   path to the .p8 auth key         (e.g. ~/private_keys/AuthKey_XXXX.p8)
  APNS_KEY_ID     the key's 10-char Key ID         (e.g. WY9L32JV8P)
  APNS_TEAM_ID    the Apple Developer team id       (e.g. 38C6HVZQSV)
  APNS_TOPIC      the app bundle id                 (e.g. com.suhai.agents)
  APNS_HOST       api.push.apple.com (prod, default) or api.sandbox.push.apple.com

Sending is best-effort on a daemon thread — a push must never delay a run. The
JWT is cached ~50 min (Apple allows reuse up to 60). Delivery uses `curl --http2`
(APNs is HTTP/2-only) so there's no extra Python HTTP/2 dependency to install.
"""
import json
import os
import subprocess
import threading
import time

from orchestrator import db

_APNS_KEY_PATH = os.environ.get("APNS_KEY_PATH", "")
_APNS_KEY_ID = os.environ.get("APNS_KEY_ID", "")
_APNS_TEAM_ID = os.environ.get("APNS_TEAM_ID", "")
_APNS_TOPIC = os.environ.get("APNS_TOPIC", "com.suhai.agents")
_APNS_HOST = os.environ.get("APNS_HOST", "api.push.apple.com")

_jwt_cache = {"token": None, "made": 0.0}
_jwt_lock = threading.Lock()


def _configured():
    return bool(_APNS_KEY_PATH and _APNS_KEY_ID and _APNS_TEAM_ID and os.path.exists(_APNS_KEY_PATH))


def push_preview(text, maxlen=178):
    """A clean one-line notification body from an agent reply: first meaningful
    line, stripped of markdown noise, truncated. APNs shows ~178 chars."""
    import re
    line = ""
    for raw in (text or "").splitlines():
        s = raw.strip()
        if s and not re.fullmatch(r"[#>*\-|`_~]+", s):
            line = s
            break
    line = re.sub(r"`([^`]+)`", r"\1", line)
    line = re.sub(r"\*\*([^*]+)\*\*", r"\1", line)
    line = re.sub(r"^#+\s*", "", line)
    line = line.strip()
    return line[:maxlen - 1] + "…" if len(line) > maxlen else line


def _auth_jwt():
    """A cached ES256 JWT (iss=team, kid=key id). Apple accepts a token for up to
    60 min and rejects refreshes faster than ~20 min, so we reuse for ~50."""
    now = time.time()
    with _jwt_lock:
        if _jwt_cache["token"] and now - _jwt_cache["made"] < 3000:
            return _jwt_cache["token"]
        # PyJWT signs ES256 from the raw .p8 (PEM) — no crypto boilerplate.
        import jwt as pyjwt
        with open(_APNS_KEY_PATH) as f:
            key = f.read()
        tok = pyjwt.encode(
            {"iss": _APNS_TEAM_ID, "iat": int(now)},
            key, algorithm="ES256", headers={"kid": _APNS_KEY_ID},
        )
        if isinstance(tok, bytes):
            tok = tok.decode()
        _jwt_cache["token"] = tok
        _jwt_cache["made"] = now
        return tok


def _send_one(token, payload, jwt_token):
    """POST one notification to APNs over HTTP/2 via curl. Returns (ok, reason)."""
    url = f"https://{_APNS_HOST}/3/device/{token}"
    try:
        r = subprocess.run(
            ["curl", "-s", "--http2", "-X", "POST",
             "-H", f"authorization: bearer {jwt_token}",
             "-H", f"apns-topic: {_APNS_TOPIC}",
             "-H", "apns-push-type: alert",
             "-H", "apns-priority: 10",
             "-d", payload,
             "-w", "\n%{http_code}", url],
            capture_output=True, text=True, timeout=20,
        )
        out = (r.stdout or "").rsplit("\n", 1)
        status = out[-1].strip() if len(out) > 1 else ""
        body = out[0] if len(out) > 1 else r.stdout
        if status == "200":
            return True, ""
        reason = ""
        try:
            reason = (json.loads(body) or {}).get("reason", "")
        except Exception:
            pass
        return False, reason or status
    except Exception as e:
        return False, str(e)


def build_payload(title, body, data=None, time_sensitive=False):
    """The APNs JSON payload for one notification.

    Deep-link contract: expo-notifications 0.28's EXNotificationSerializer
    exposes a REMOTE notification's `content.data` as the userInfo value of the
    ROOT `body` key only (the `aps.alert.body` string is not it). So a tappable
    payload must carry its data dict there — before this, the data keys were
    merged at the root, the serializer read `userInfo[@"body"]` = null, and a
    tap just opened the app instead of the chat it belonged to.
    """
    payload = {"aps": {"alert": {"title": title, "body": (body or "")[:300]},
                       "sound": "default"}}
    if time_sensitive:
        # Breaks through Focus and the scheduled summary; the interruption level
        # rides in the JSON, so the curl headers stay the same.
        payload["aps"]["interruption-level"] = "time-sensitive"
    if data:
        payload["body"] = data
    return payload


# A delivery reminder needs a durable outcome, unlike ordinary best-effort UI
# notifications. These reasons are stable categories; neither APNs bodies nor
# transport exceptions enter the delivery ledger.
_PERMANENT_APNS_FAILURES = frozenset({
    "BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered", "410",
    "400", "403", "404", "405", "413",
})


def notify_delivery(title, body, data=None, time_sensitive=False):
    """Synchronously submit one advisory delivery notification.

    Returns ``(accepted, retryable, reason)``. ``accepted`` means at least one
    APNs request returned 200, not that a device displayed it. A failure before
    any accepted submission retries only when APNs/credential access may recover;
    known dead or absent device/configuration states are final for this reminder
    revision. This narrowly serves the durable delivery scheduler; normal app
    pushes remain asynchronous in ``notify_all`` below.
    """
    if not _configured():
        return False, False, "owner_push_unavailable"
    try:
        tokens = db.all_push_tokens()
    except Exception:
        return False, True, "owner_push_dispatch_failed"
    if not tokens:
        return False, False, "owner_push_unavailable"
    try:
        jwt_token = _auth_jwt()
    except Exception:
        return False, True, "owner_push_dispatch_failed"
    payload = json.dumps(build_payload(title, body, data, time_sensitive))
    transient_failure = False
    for token in tokens:
        ok, reason = _send_one(token, payload, jwt_token)
        if ok:
            # Do not retry after any accepted submission: retry would make an
            # already-alerted device receive a duplicate reminder.
            return True, False, "owner_attention"
        if reason in ("BadDeviceToken", "Unregistered", "410"):
            try:
                db.remove_push_token(token)
            except Exception:
                pass
        if reason not in _PERMANENT_APNS_FAILURES:
            transient_failure = True
    if transient_failure:
        return False, True, "owner_push_dispatch_failed"
    return False, False, "owner_push_unavailable"


def notify_all(title, body, data=None, time_sensitive=False):
    """Push to every registered device (the base is single-owner). No-ops when
    unconfigured or no devices. Daemon thread so callers never block on the net."""
    if not _configured():
        return

    def send():
        try:
            tokens = db.all_push_tokens()
        except Exception:
            tokens = []
        if not tokens:
            return
        payload = json.dumps(build_payload(title, body, data, time_sensitive))
        try:
            jwt_token = _auth_jwt()
        except Exception:
            return
        for tok in tokens:
            ok, reason = _send_one(tok, payload, jwt_token)
            # BadDeviceToken / Unregistered → the token is dead; prune it.
            if not ok and reason in ("BadDeviceToken", "Unregistered", "410"):
                try:
                    db.remove_push_token(tok)
                except Exception:
                    pass

    threading.Thread(target=send, daemon=True).start()

