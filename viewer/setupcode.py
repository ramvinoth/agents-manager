"""viewer.setupcode — the one-time code that guards the very first signup.

Until an account exists, signup creates the OWNER, and the server may already
be reachable from the LAN, a tailnet or a tunnel. Without a gate, whoever
reaches a fresh install first owns it. So while there are no users the server
keeps a random code in a 0600 file under the service user's home, prints it at
boot, and the installer prints it too (`harman setup-code`). Signup must
present it; once the owner exists the code is deleted and signup is closed.
No loopback exemption: a reverse proxy on the box makes every visitor look
local, so the code is required everywhere (Jupyter's token model)."""
import hmac
import os
import secrets
from pathlib import Path

# No 0/O/1/I/L: the code is read off a terminal and typed by hand.
_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
_LEN = 10   # 31^10 ≈ 2^49; with the 20/min signup throttle, unguessable


def path():
    return Path(os.environ.get("HARMAN_SETUP_CODE_FILE") or Path.home() / ".harman" / "setup-code")


def ensure():
    """The current code, creating it (0600) if absent. Idempotent across restarts,
    so the code printed by the installer stays valid until it is used."""
    p = path()
    try:
        code = p.read_text().strip()
        if code:
            return code
    except FileNotFoundError:
        pass
    p.parent.mkdir(parents=True, exist_ok=True)
    code = "".join(secrets.choice(_ALPHABET) for _ in range(_LEN))
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(code + "\n")
    return code


def matches(given):
    """Constant-time check; case, spaces and dashes are forgiven (typed by hand)."""
    try:
        want = path().read_text().strip()
    except FileNotFoundError:
        return False
    norm = "".join(ch for ch in str(given or "").upper() if ch.isalnum())
    return bool(want) and hmac.compare_digest(norm.encode(), want.encode())


def clear():
    try:
        path().unlink()
    except FileNotFoundError:
        pass
