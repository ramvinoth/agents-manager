"""Sign-in throttle keying: the raw peer IP, except a loopback peer (the local
Cloudflare tunnel) is keyed on CF-Connecting-IP so internet clients don't
share — and jointly exhaust — one bucket. Hermetic: pure functions only."""
from viewer.routes import auth


def test_direct_peer_ignores_cf_header():
    # A LAN/tailnet client can't pick its own bucket by sending the header.
    assert auth._client_ip("100.64.0.5", {"CF-Connecting-IP": "1.2.3.4"}) == "100.64.0.5"


def test_loopback_peer_uses_cf_header():
    assert auth._client_ip("127.0.0.1", {"CF-Connecting-IP": " 203.0.113.9 "}) == "203.0.113.9"
    assert auth._client_ip("::1", {"CF-Connecting-IP": "2001:db8::1"}) == "2001:db8::1"


def test_loopback_without_header_is_loopback():
    # Local browser on the box itself: unchanged behaviour.
    assert auth._client_ip("127.0.0.1", {}) == "127.0.0.1"
    assert auth._client_ip("127.0.0.1", {"CF-Connecting-IP": "  "}) == "127.0.0.1"


def test_tunnel_clients_get_separate_buckets(monkeypatch):
    monkeypatch.setattr(auth, "_login_hits", {})
    attacker = auth._client_ip("127.0.0.1", {"CF-Connecting-IP": "198.51.100.1"})
    owner = auth._client_ip("127.0.0.1", {"CF-Connecting-IP": "203.0.113.2"})
    for _ in range(auth._LOGIN_MAX):
        assert not auth._login_over_limit(attacker)
    assert auth._login_over_limit(attacker)
    assert not auth._login_over_limit(owner)
