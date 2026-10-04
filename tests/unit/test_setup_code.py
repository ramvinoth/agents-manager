"""First-run setup code: while no account exists, signup creates the OWNER, so it
must present the one-time code the installer/server printed — otherwise whoever
reaches a fresh install over the network first owns it. Hermetic: the code file
is a tmp path, db accessors are stubbed."""
import os
import stat

import pytest

from viewer import db, setupcode
from viewer.routes import auth
from viewer.routes.auth import AuthMixin


@pytest.fixture(autouse=True)
def code_file(tmp_path, monkeypatch):
    monkeypatch.setenv("HARMAN_SETUP_CODE_FILE", str(tmp_path / "h" / "setup-code"))
    monkeypatch.setattr(auth, "_login_hits", {})
    return tmp_path / "h" / "setup-code"


class _Handler(AuthMixin):
    client_address = ("100.64.0.9", 5555)

    def __init__(self, body):
        self._body, self.sent, self.headers, self.cookie = body, None, {}, "unset"

    def read_body(self):
        return self._body

    def send_json(self, data, status=200):
        self.sent = (data, status)

    def set_session_cookie(self, tok):
        self.cookie = tok


def _signup(monkeypatch, body, users=0):
    created = []
    monkeypatch.setattr(db, "user_count", lambda: users)
    monkeypatch.setattr(db, "create_user",
                        lambda u, p: created.append(u) or {"id": 1, "username": u, "role": "owner"})
    monkeypatch.setattr(db, "create_session", lambda uid: "tok")
    h = _Handler(body)
    h._p_auth_signup(None)
    return h.sent, created


def test_code_is_stable_private_and_typeable(code_file):
    c = setupcode.ensure()
    assert setupcode.ensure() == c                     # survives restarts until used
    assert stat.S_IMODE(os.stat(code_file).st_mode) == 0o600
    assert len(c) == 10 and not set(c) & set("01OIL")


def test_match_forgives_case_spaces_dashes():
    c = setupcode.ensure()
    assert setupcode.matches(f" {c[:5].lower()}-{c[5:]} ")
    assert not setupcode.matches(c[:-1] + ("2" if c[-1] != "2" else "3"))
    assert not setupcode.matches("") and not setupcode.matches(None)


def test_signup_without_code_is_refused(monkeypatch):
    setupcode.ensure()
    (data, status), created = _signup(monkeypatch, {"username": "eve", "password": "pw123456"})
    assert status == 403 and created == []


def test_signup_with_code_creates_owner_and_burns_code(monkeypatch, code_file):
    c = setupcode.ensure()
    (data, status), created = _signup(monkeypatch, {"username": "ram", "password": "pw123456", "setupCode": c})
    assert status == 200 and created == ["ram"]
    assert not code_file.exists()


def test_deleted_code_file_regenerates_instead_of_wedging(monkeypatch, code_file):
    # No file at all: the request is refused (no code to match) but a fresh code
    # now exists for the operator to read — first-run can't get stuck.
    (data, status), _ = _signup(monkeypatch, {"username": "ram", "password": "pw", "setupCode": "X"})
    assert status == 403 and code_file.exists()


def test_closed_after_owner_exists(monkeypatch):
    c = setupcode.ensure()
    (data, status), created = _signup(monkeypatch, {"username": "x", "password": "pw", "setupCode": c}, users=1)
    assert status == 403 and created == []


def test_code_guessing_is_throttled(monkeypatch):
    setupcode.ensure()
    statuses = [_signup(monkeypatch, {"username": "e", "password": "p", "setupCode": "WRONG"})[0][1]
                for _ in range(auth._LOGIN_MAX + 1)]
    assert statuses[-1] == 429 and set(statuses[:-1]) == {403}
