"""Reaching the viewer from a remote host: this machine's tailnet address and
the permission MCP shipped to the host so a remote chat can ask the owner."""
import ipaddress
import json
import re
from pathlib import Path
from orchestrator.remote.transport import SSH


# ---- remote permission MCP (for AskUserQuestion on SSH hosts) -------------------
# A driven `claude` on a remote host must reach the viewer's /api/chat/permission to
# ask the user a question. Rather than an SSH reverse tunnel (many sshd configs deny
# remote port-forwarding), the remote MCP dials the viewer DIRECTLY at its
# tailnet IP:PORT (the viewer binds 0.0.0.0, reachable across the tailnet). We SFTP
# the tiny stdio permission_mcp.py + its --mcp-config onto the host and pass
# VIEWER_PERM_BASE=<tailnet base> in the remote env.

_REMOTE_PERM_DIR = ".claude/.viewer-perm"
_viewer_tailnet_ip = None

# Tailscale hands every node an address in the CGNAT range (RFC 6598); the
# kernel's interface table is where that fact is true no matter which Tailscale
# variant is installed. The `tailscale` CLI is asked first because it is the
# canonical answer, but on the macOS App-Store/standalone variants the Homebrew
# binary wants a tailscaled socket that does not exist and the app's own CLI
# fails under launchd's bare environment — so the interface table is the
# fallback that actually works for the viewer as a launchd service.
_TAILNET_NET = ipaddress.ip_network("100.64.0.0/10")
_TAILNET_PROBES = (
    ["tailscale", "ip", "-4"],
    ["ip", "-4", "-o", "addr"],
    ["/sbin/ip", "-4", "-o", "addr"],
    ["ifconfig"],
    ["/sbin/ifconfig"],
)
_INET_RE = re.compile(r"\binet\s+(\d{1,3}(?:\.\d{1,3}){3})\b")


def tailnet_ipv4_from_text(text):
    """First CGNAT-range IPv4 in a `tailscale ip -4` / `ip -o addr` / `ifconfig`
    dump, or None. Pure, so the parser is unit-testable without a network."""
    candidates = _INET_RE.findall(text) or text.split()
    for tok in candidates:
        try:
            addr = ipaddress.ip_address(tok.strip())
        except ValueError:
            continue
        if addr.version == 4 and addr in _TAILNET_NET:
            return str(addr)
    return None


def tailnet_ipv4(_run=None):
    """This machine's Tailscale IPv4, or None. A successful answer is cached for
    the process lifetime; a failed lookup is NOT, so a tailnet that comes up
    after the viewer boots is found on the next call."""
    global _viewer_tailnet_ip
    if _viewer_tailnet_ip:
        return _viewer_tailnet_ip
    import subprocess
    run = _run or (lambda cmd: subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout)
    for cmd in _TAILNET_PROBES:
        try:
            ip = tailnet_ipv4_from_text(run(cmd) or "")
        except Exception:
            continue
        if ip:
            _viewer_tailnet_ip = ip
            return ip
    return None


def viewer_tailnet_base(port):
    """The viewer's own tailnet URL a remote host can call back to
    (http://<tailscale-ip>:<port>), or None if tailscale isn't available."""
    ip = tailnet_ipv4()
    return f"http://{ip}:{port}" if ip else None


def remote_setup_perm_mcp(hid, port):
    """Ship permission_mcp.py + an --mcp-config onto the host so a remote claude can
    drive the viewer permission tool (reaching the viewer at its tailnet IP).
    Returns the REMOTE --mcp-config path, or raises if the viewer isn't reachable."""
    if not viewer_tailnet_base(port):
        raise RuntimeError("no tailnet address for the viewer (remote AUQ needs it)")
    helper_src = (Path(__file__).parent / "permission_mcp.py").read_text()
    viewer_mcp_src = (Path(__file__).parent / "viewer_mcp.py").read_text()
    with SSH.sftp(hid) as sftp:
        home = SSH.get(hid)["home"].rstrip("/")
        d = f"{home}/{_REMOTE_PERM_DIR}"
        # mkdir -p the perm dir, segment by segment (SFTP has no recursive mkdir)
        cur = home
        for seg in _REMOTE_PERM_DIR.split("/"):
            cur = f"{cur}/{seg}"
            try:
                sftp.mkdir(cur)
            except IOError:
                pass
        helper_path = f"{d}/permission_mcp.py"
        viewer_mcp_path = f"{d}/viewer_mcp.py"
        cfg_path = f"{d}/mcp.json"
        with sftp.open(helper_path, "w") as f:
            f.write(helper_src)
        with sftp.open(viewer_mcp_path, "w") as f:
            f.write(viewer_mcp_src)
        cfg = {"mcpServers": {
            "viewerperm": {"command": "python3", "args": [helper_path]},
            "viewer": {"command": "python3", "args": [viewer_mcp_path]},
        }}
        # Merge user MCP servers from ~/.claude/mcp.json on the remote host
        try:
            user_mcp_path = f"{home}/.claude/mcp.json"
            with sftp.open(user_mcp_path, "r") as uf:
                user_cfg = json.loads(uf.read())
            for name, srv in (user_cfg.get("mcpServers") or {}).items():
                if name not in cfg["mcpServers"]:
                    cfg["mcpServers"][name] = srv
        except Exception:
            pass
        with sftp.open(cfg_path, "w") as f:
            f.write(json.dumps(cfg))
    return cfg_path
