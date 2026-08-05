"""viewer.push — background push notifications to the mobile app via APNs.

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

from viewer import db

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


def notify_all(title, body, data=None):
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
        aps = {"aps": {"alert": {"title": title, "body": (body or "")[:300]},
                       "sound": "default"}}
        if data:
            # Merge caller data as top-level keys, but never let it clobber the
            # constructed "aps" alert (which would silently drop the notification).
            aps.update({k: v for k, v in data.items() if k != "aps"})
        payload = json.dumps(aps)
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

