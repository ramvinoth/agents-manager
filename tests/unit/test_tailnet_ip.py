"""The viewer's own tailnet address feeds the boot banner and, more importantly,
the callback URL a remote host's permission MCP uses to reach the viewer.
Regression: under launchd the `tailscale` CLI yields nothing on the macOS
App-Store/standalone variants (Homebrew binary: no tailscaled socket; app CLI:
needs a shell env var), so every remote-host run failed with "no tailnet
address for the viewer" and the banner printed http://:8091/ — and the empty
result was cached for the life of the process."""
import pytest

from viewer import remote


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch):
    monkeypatch.setattr(remote, "_viewer_tailnet_ip", None)


IFCONFIG = """lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.1.23 netmask 0xffffff00 broadcast 192.168.1.255
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
\tinet 100.76.141.120 --> 100.76.141.120 netmask 0xffffffff
"""
IP_ADDR = "2: eth0    inet 10.0.0.5/24 brd 10.0.0.255 scope global eth0\n" \
          "5: tailscale0    inet 100.101.102.103/32 scope global tailscale0\n"


def test_parser_picks_only_the_cgnat_address():
    assert remote.tailnet_ipv4_from_text("100.76.141.120\n") == "100.76.141.120"
    assert remote.tailnet_ipv4_from_text(IFCONFIG) == "100.76.141.120"
    assert remote.tailnet_ipv4_from_text(IP_ADDR) == "100.101.102.103"
    assert remote.tailnet_ipv4_from_text("192.168.1.23 10.0.0.5 fd7a:115c::1\n") is None
    assert remote.tailnet_ipv4_from_text("") is None


def test_cli_failure_falls_through_to_interface_table():
    def run(cmd):
        if cmd[0] == "tailscale":
            raise FileNotFoundError(cmd[0])
        if cmd[-1] == "addr":
            raise FileNotFoundError(cmd[0])
        return IFCONFIG
    assert remote.tailnet_ipv4(_run=run) == "100.76.141.120"
    assert remote.viewer_tailnet_base(8091) == "http://100.76.141.120:8091"


def test_cli_answer_wins_when_present():
    assert remote.tailnet_ipv4(_run=lambda cmd: "100.100.1.2\n" if cmd[0] == "tailscale" else IFCONFIG) == "100.100.1.2"


def test_failed_lookup_is_not_cached():
    calls = []
    def failing(cmd):
        calls.append(cmd)
        return ""
    assert remote.tailnet_ipv4(_run=failing) is None
    monkeypatched_calls = len(calls)
    assert monkeypatched_calls == len(remote._TAILNET_PROBES)
    assert remote.tailnet_ipv4(_run=lambda cmd: IFCONFIG) == "100.76.141.120"
    # ...and a success IS cached: a later probe that would fail is never asked.
    assert remote.tailnet_ipv4(_run=failing) == "100.76.141.120"
    assert len(calls) == monkeypatched_calls
