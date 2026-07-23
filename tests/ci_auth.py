#!/usr/bin/env python3
"""Shared test-auth helper for the smoke + e2e suites.

Both suites authenticate as a dedicated `_ci` account so they exercise the real
login gate. The account's password is a RANDOM per-machine secret kept in a
gitignored file (tests/.ci-secret) — never committed. That way the open-source
repo ships no usable credential and no instance that ran the tests is left with
a known-password login. Delete tests/.ci-secret (the `_ci` row is healed on the
next run) to rotate it."""
import os
import secrets
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import viewer.db as db  # noqa: E402

_CI_USER = "_ci"
_SECRET_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".ci-secret")


def _ci_password():
    """Read the machine-local CI secret, minting a fresh random one on first use."""
    try:
        with open(_SECRET_FILE) as f:
            existing = f.read().strip()
        if existing:
            return existing
    except FileNotFoundError:
        pass
    secret = secrets.token_urlsafe(24)
    fd = os.open(_SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(secret)
    return secret


def mint():
    """Return a fresh login-session token for the `_ci` account, creating (or
    healing, if the secret rotated) the account as needed."""
    db.init_db()
    pw = _ci_password()
    user = db.verify_user(_CI_USER, pw)
    if not user:
        # First run, or a stale `_ci` row from before the secret rotated.
        db.delete_user(_CI_USER)
        user = db.create_user(_CI_USER, pw)
    return db.create_session(user["id"])
