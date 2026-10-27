"""viewer.pairing — one-time codes that sign a phone in by scanning a QR.

A signed-in human asks for a code (web Profile → "Pair a phone"); the web shows
it as a QR of `agents://pair?url=<server>&code=<code>`. The iPhone Camera opens
that link in the app, which redeems the code for a normal session token — no
password typed on the phone. Codes are 128-bit, single-use and live 5 minutes,
so a code seen over a shoulder is worthless soon after.

In memory on purpose: the server is one process, a code outlives no restart
worth keeping, and nothing durable should hold a live credential."""
import secrets
import threading
import time

TTL = 300          # seconds a code stays redeemable
_MAX_PER_USER = 5  # older unredeemed codes are dropped past this
_codes = {}        # code -> (user_id, expires_at)
_lock = threading.Lock()


def _prune(now):
    for c in [c for c, (_, exp) in _codes.items() if exp <= now]:
        del _codes[c]


def create(user_id, now=None):
    """A fresh code for `user_id`; returns (code, expires_at)."""
    now = time.time() if now is None else now
    code = secrets.token_urlsafe(16)
    with _lock:
        _prune(now)
        mine = sorted((exp, c) for c, (uid, exp) in _codes.items() if uid == user_id)
        for _, c in mine[: max(0, len(mine) - _MAX_PER_USER + 1)]:
            del _codes[c]
        _codes[code] = (user_id, now + TTL)
    return code, now + TTL


def redeem(code, now=None):
    """The user_id a live code belongs to, consuming it; None if unknown/expired."""
    now = time.time() if now is None else now
    if not isinstance(code, str) or not code:
        return None
    with _lock:
        hit = _codes.pop(code, None)
    if not hit or hit[1] <= now:
        return None
    return hit[0]
