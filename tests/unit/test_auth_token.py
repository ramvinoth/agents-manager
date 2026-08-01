"""Unit tests for request auth-token resolution: the cookie (web UI) vs an
`Authorization: Bearer <token>` header (non-browser clients like the mobile app).
Hermetic — binds the real method to a fake request, no server/DB/SSH."""
from viewer.server import SessionViewerHandler


def _token(cookie="", authorization=None):
    """Resolve _auth_token against a fake request with the given cookie value
    and Authorization header (None = header absent)."""
    headers = {} if authorization is None else {"Authorization": authorization}

    class FakeReq:
        pass
    fake = FakeReq()
    fake.headers = headers
    fake._cookie = lambda name: cookie
    return SessionViewerHandler._auth_token(fake)


class TestAuthToken:
    def test_cookie_only(self):
        assert _token(cookie="abc123") == "abc123"

    def test_bearer_header_when_no_cookie(self):
        assert _token(authorization="Bearer xyz789") == "xyz789"

    def test_bearer_is_case_insensitive_and_trimmed(self):
        assert _token(authorization="bearer   spaced  ") == "spaced"

    def test_cookie_wins_over_header(self):
        assert _token(cookie="from-cookie", authorization="Bearer from-header") == "from-cookie"

    def test_nothing_present(self):
        assert _token() == ""

    def test_non_bearer_scheme_ignored(self):
        assert _token(authorization="Basic dXNlcjpwYXNz") == ""

    def test_empty_bearer_value(self):
        assert _token(authorization="Bearer ") == ""
