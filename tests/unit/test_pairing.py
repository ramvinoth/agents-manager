"""QR pairing: a signed-in human mints a one-time code, a phone redeems it for a
session token. Codes are single-use, short-lived, capped per user, and only a
person (never an agent's MCP session) can mint one."""
import pytest

from viewer import db, pairing
from viewer.routes import auth
from viewer.routes.auth import AuthMixin


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.setattr(pairing, "_codes", {})
    monkeypatch.setattr(auth, "_login_hits", {})


class _Req:
    def __init__(self, principal):
        self.principal = principal


class _Handler(AuthMixin):
    client_address = ("100.64.0.9", 5555)

    def __init__(self, body=None):
        self._body, self.sent, self.headers = body, None, {}

    def read_body(self):
        return self._body

    def send_json(self, data, status=200):
        self.sent = (data, status)


APP = {"kind": "app", "user": {"id": 7, "username": "ram", "role": "owner"}}


def test_code_redeems_once_then_dies():
    code, _ = pairing.create(7, now=100)
    assert pairing.redeem(code, now=101) == 7
    assert pairing.redeem(code, now=102) is None


def test_code_expires():
    code, exp = pairing.create(7, now=100)
    assert exp == 100 + pairing.TTL
    assert pairing.redeem(code, now=exp) is None


def test_codes_capped_per_user_oldest_dropped():
    codes = [pairing.create(7, now=100 + i)[0] for i in range(pairing._MAX_PER_USER + 2)]
    assert pairing.redeem(codes[0], now=110) is None
    assert pairing.redeem(codes[-1], now=110) == 7
    other, _ = pairing.create(8, now=110)          # another user's codes are untouched
    assert pairing.redeem(other, now=111) == 8


def test_junk_never_redeems():
    for junk in (None, "", 5, {"a": 1}, "nope"):
        assert pairing.redeem(junk) is None


def test_start_requires_a_person():
    h = _Handler()
    h._p_auth_pair_start(_Req({"kind": "mcp", "user": None, "session": "s1"}))
    assert h.sent[1] == 403
    h._p_auth_pair_start(_Req({"kind": "app", "user": {"id": 0, "username": "local"}}))
    assert h.sent[1] == 400                          # VIEWER_NO_AUTH has no account
    h._p_auth_pair_start(_Req(APP))
    data, status = h.sent
    assert status == 200 and data["ttl"] == pairing.TTL and len(data["code"]) >= 20


def test_redeem_issues_token_for_the_minting_user(monkeypatch):
    monkeypatch.setattr(db, "create_session", lambda uid: f"tok{uid}")
    monkeypatch.setattr(db, "user_for_session", lambda t: {"id": 7, "username": "ram", "role": "owner"})
    start = _Handler()
    start._p_auth_pair_start(_Req(APP))
    h = _Handler({"code": start.sent[0]["code"]})
    h._p_auth_pair_redeem(None)
    assert h.sent == ({"user": {"id": 7, "username": "ram", "role": "owner"}, "token": "tok7"}, 200)
    again = _Handler({"code": start.sent[0]["code"]})
    again._p_auth_pair_redeem(None)
    assert again.sent[1] == 401


def test_redeem_for_deleted_account_revokes_the_token(monkeypatch):
    dropped = []
    monkeypatch.setattr(db, "create_session", lambda uid: "tok")
    monkeypatch.setattr(db, "user_for_session", lambda t: None)
    monkeypatch.setattr(db, "delete_session", dropped.append)
    code, _ = pairing.create(7)
    h = _Handler({"code": code})
    h._p_auth_pair_redeem(None)
    assert h.sent[1] == 401 and dropped == ["tok"]


def test_redeem_is_throttled():
    for _ in range(auth._LOGIN_MAX):
        _Handler({"code": "x"})._p_auth_pair_redeem(None)
    h = _Handler({"code": "x"})
    h._p_auth_pair_redeem(None)
    assert h.sent[1] == 429
