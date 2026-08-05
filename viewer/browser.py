"""viewer.browser — headless-Chrome/CDP control, the browser & terminal
WebSocket engines, and MCP-CDP wiring."""
import base64
import fcntl
import hashlib
import json
import os
import posixpath
import pty
import re
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import termios
import threading
import time
from pathlib import Path
from urllib.parse import quote, urlparse
from viewer.remote import (
    SSH, remote_run_python,
)


BROWSER_PORT = 9222
BROWSER_PROFILE = ".viewer-browser-profile"   # user-data-dir marker, also used to pkill
BROWSER_XVFB_DISPLAY = 99                      # our virtual X display on headless Linux

# Distro package name + install command for Xvfb, so a headless Linux host can
# run a REAL headed browser (normal User-Agent, not HeadlessChrome — which is
# what sites like Google block). One-time, needs sudo; a fresh VM has root.
XVFB_PKG = {"apt-get": "xvfb", "dnf": "xorg-x11-server-Xvfb", "yum": "xorg-x11-server-Xvfb",
            "apk": "xvfb", "pacman": "xorg-server-xvfb", "zypper": "xorg-x11-server-Xvfb"}


def xvfb_install_cmd(pkg_mgr, sudo=True):
    if not pkg_mgr:
        return None
    pkg = XVFB_PKG.get(pkg_mgr, "xvfb")
    if pkg_mgr == "apt-get":
        inst = f"apt-get update && apt-get install -y {pkg}"
    elif pkg_mgr == "apk":
        inst = f"apk add {pkg}"
    elif pkg_mgr == "pacman":
        inst = f"pacman -S --noconfirm {pkg}"
    else:
        inst = f"{pkg_mgr} install -y {pkg}"
    # wrap in one shell so sudo covers every command (not just the first)
    return (f"sudo sh -c {shlex.quote(inst)}" if sudo else inst)


def browser_sock(hid, timeout=20):
    """Raw byte pipe to the host's CDP port: TCP for local, an SSH direct-tcpip
    channel for remote. Both expose sendall/recv/settimeout/close."""
    if hid == "local":
        s = socket.create_connection(("127.0.0.1", BROWSER_PORT), timeout=timeout)
        s.settimeout(timeout)
        return s
    with SSH.lock_for(hid):
        c = SSH.get(hid)
        ch = c["client"].get_transport().open_channel(
            "direct-tcpip", ("127.0.0.1", BROWSER_PORT), ("127.0.0.1", 0))
        ch.settimeout(timeout)
        return ch


class WSConn:
    """Minimal RFC6455 client over any sendall/recv byte pipe — enough for CDP
    (text frames, fragmentation, ping/pong). No external websocket dependency."""

    def __init__(self, sock, path, hostname="127.0.0.1"):
        self.s = sock
        self.buf = b""
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET {path} HTTP/1.1\r\nHost: {hostname}\r\nUpgrade: websocket\r\n"
                        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                        f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
        hdr = self._read_until(b"\r\n\r\n")
        if b" 101" not in hdr.split(b"\r\n", 1)[0]:
            raise OSError("WebSocket handshake failed: " + hdr[:200].decode(errors="replace"))

    def _fill(self):
        chunk = self.s.recv(65536)
        if not chunk:
            raise OSError("connection closed")
        self.buf += chunk

    def _read_until(self, delim):
        while delim not in self.buf:
            self._fill()
        i = self.buf.index(delim) + len(delim)
        out, self.buf = self.buf[:i], self.buf[i:]
        return out

    def _recv(self, n):
        while len(self.buf) < n:
            self._fill()
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send_frame(self, opcode, data):
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        ln = len(data)
        if ln < 126:
            hdr = struct.pack("!BB", 0x80 | opcode, 0x80 | ln)
        elif ln < 65536:
            hdr = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, ln)
        else:
            hdr = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, ln)
        self.s.sendall(hdr + mask + masked)

    def send_text(self, payload):
        self._send_frame(0x1, payload.encode())

    def drain(self):
        """Discard everything the peer sent (used for fire-and-forget input:
        we cdp.send() commands and never need the replies, but must drain them
        so they don't fill the socket buffer and stall Chrome)."""
        try:
            self.s.settimeout(0)
            while True:
                if not self.s.recv(65536):
                    break
        except Exception:
            pass
        finally:
            try: self.s.settimeout(None)
            except Exception: pass
            self.buf = b""

    def recv_text(self):
        msg = b""
        while True:
            b1, b2 = self._recv(2)
            fin, opcode = b1 & 0x80, b1 & 0x0F
            ln = b2 & 0x7F
            if ln == 126:
                ln = struct.unpack("!H", self._recv(2))[0]
            elif ln == 127:
                ln = struct.unpack("!Q", self._recv(8))[0]
            if b2 & 0x80:
                mask = self._recv(4)
                data = bytes(x ^ mask[i % 4] for i, x in enumerate(self._recv(ln)))
            else:
                data = self._recv(ln)
            if opcode == 0x9:                       # ping -> pong
                self._send_frame(0xA, data)
                continue
            if opcode == 0x8:
                raise OSError("websocket closed by peer")
            if opcode in (0x0, 0x1, 0x2):
                msg += data
                if fin:
                    return msg.decode("utf-8", "replace")

    def close(self):
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        try:
            self.s.close()
        except Exception:
            pass


class CDP:
    """Tiny JSON-RPC shim on a WSConn; call() drains events until the reply."""

    def __init__(self, ws):
        self.ws = ws
        self.next_id = 0
        self.events = []          # events seen while waiting for a reply

    def send(self, method, params=None):
        self.next_id += 1
        self.ws.send_text(json.dumps({"id": self.next_id, "method": method, "params": params or {}}))
        return self.next_id

    def call(self, method, params=None):
        want = self.send(method, params)
        while True:
            msg = json.loads(self.ws.recv_text())
            if msg.get("id") == want:
                if "error" in msg:
                    raise OSError(f"CDP {method}: {msg['error'].get('message', 'error')}")
                return msg.get("result")
            if "method" in msg:
                self.events.append(msg)

    def next_message(self):
        if self.events:
            return self.events.pop(0)
        return json.loads(self.ws.recv_text())


def cdp_http(hid, path, method="GET"):
    """One-shot HTTP request to the CDP endpoint over the byte pipe. Chrome's
    DevTools server ignores Connection: close, so read exactly Content-Length
    instead of waiting for EOF (which only arrives at the socket timeout)."""
    s = browser_sock(hid, timeout=15)
    try:
        s.sendall(f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".encode())
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
        head, _, body = data.partition(b"\r\n\r\n")
        m = re.search(rb"content-length:\s*(\d+)", head, re.I)
        want = int(m.group(1)) if m else None
        while want is not None and len(body) < want:
            chunk = s.recv(65536)
            if not chunk:
                break
            body += chunk
        txt = body.decode("utf-8", "replace").strip()
        if not txt:
            return None
        try:
            return json.loads(txt)
        except json.JSONDecodeError:
            return {"text": txt}   # /json/close and /json/activate answer in plain text
    finally:
        try:
            s.close()
        except Exception:
            pass


# Which tab should the live view show? /json/list order is ACTIVATION order,
# and the Playwright MCP navigates its page without ever activating it — so
# "front tab" goes stale (user watched Reddit while the agent was truthfully
# on Google). Instead, follow navigation activity: whichever page's
# scheme+host+path changed since the last look is where the action is.
# (Query strings are ignored: challenge pages mutate their query in a loop.)
TAB_FOLLOW = {}   # hid -> {"sig": {page_id: (scheme, host, path)}, "follow": page_id}


def _tab_sig_key(u):
    q = urlparse(u)
    return (q.scheme, q.netloc, q.path)


def _safe_nav_url(url):
    """Normalize an address-bar URL and return it only if it's a safe navigation
    target, else None. Blocks file://, chrome://, internal-metadata, and other
    non-web schemes so the live-view can't be turned into a local-file / SSRF read.
    A bare hostname gets https:// prepended (the common address-bar case)."""
    url = str(url or "").strip()
    if not url:
        return None
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", url):
        url = "https://" + url  # bare hostname typed in the address bar
    scheme = (urlparse(url).scheme or "").lower()
    return url if scheme in ("http", "https", "about") else None


def _hex_tab(tab_id):
    """CDP target ids are uppercase hex; validate so tab_id can't inject into the
    /json/activate|close request line."""
    return bool(re.fullmatch(r"[A-Fa-f0-9]+", str(tab_id or "")))


def _browser_pages(hid, create=True):
    pages = [t for t in (cdp_http(hid, "/json/list") or []) if t.get("type") == "page"]
    if not pages and create:
        made = cdp_http(hid, "/json/new?about:blank", method="PUT") \
            or cdp_http(hid, "/json/new?about:blank")   # older Chrome wants GET
        pages = [made] if made else []
    if not pages:
        raise OSError("browser has no debuggable page")
    return pages


def browser_front_page(hid):
    """(id, ws_path, url) of the page the agent is working in (see TAB_FOLLOW),
    creating one if none exists."""
    pages = _browser_pages(hid)
    st = TAB_FOLLOW.setdefault(hid, {"sig": {}, "follow": None, "pin": 0})
    sig = {p["id"]: _tab_sig_key(p.get("url", "")) for p in pages}
    changed = [pid for pid, k in sig.items() if pid in st["sig"] and st["sig"][pid] != k]
    new_tabs = [pid for pid in sig if pid not in st["sig"]]
    pinned = time.time() < st.get("pin", 0) and st.get("follow") in sig
    if st["follow"] is None:
        st["follow"] = pages[0]["id"]              # first look: front tab
    if not pinned:                                 # manual selection suppresses auto-follow briefly
        if new_tabs and st["sig"]:
            st["follow"] = new_tabs[0]             # a fresh tab is where work starts
        elif changed and st["follow"] not in changed:
            st["follow"] = changed[0]              # a navigation happened elsewhere
    if st["follow"] not in sig:
        st["follow"] = pages[0]["id"]              # followed tab was closed
    st["sig"] = sig
    p = next(x for x in pages if x["id"] == st["follow"])
    ws_url = p.get("webSocketDebuggerUrl", "")
    # Chrome may omit the port here (ws://127.0.0.1/devtools/page/ID) — take the
    # URL path only, never substring on the port number.
    path = urlparse(ws_url).path if ws_url else f"/devtools/page/{p['id']}"
    return p["id"], path, p.get("url", "")


def browser_page_ws_path(hid):
    return browser_front_page(hid)[1]


def _ordered_pages(hid, pages):
    """Pages in STABLE first-seen order. /json/list is activation order, so
    without this the tab strip reshuffles every time you click a tab (the
    activated one jumps to the front). New tabs append; closed ones drop."""
    st = TAB_FOLLOW.setdefault(hid, {"sig": {}, "follow": None, "pin": 0, "order": []})
    order = st.setdefault("order", [])
    ids = {p["id"] for p in pages}
    st["order"] = [i for i in order if i in ids] + [p["id"] for p in pages if p["id"] not in order]
    idx = {pid: n for n, pid in enumerate(st["order"])}
    return sorted(pages, key=lambda p: idx.get(p["id"], 1 << 30))


def browser_tabs(hid):
    """Tab strip data: every open page (stable order) plus which one the view follows."""
    pages = _ordered_pages(hid, _browser_pages(hid, create=False))
    follow = (TAB_FOLLOW.get(hid) or {}).get("follow") or pages[0]["id"]
    return [{"id": p["id"], "title": p.get("title", "") or p.get("url", ""),
             "url": p.get("url", ""), "active": p["id"] == follow} for p in pages]


def browser_tab_action(hid, action, tab_id=None, url=None):
    """User tab controls. Selecting also re-baselines the activity signatures so
    the pick isn't instantly overridden by the change detector; the view still
    follows the agent's NEXT navigation, which is the behavior users expect."""
    st = TAB_FOLLOW.setdefault(hid, {"sig": {}, "follow": None, "pin": 0})
    # A manual action pins the chosen tab for a few seconds so the auto-follow
    # detector (and background-tab churn like Cloudflare challenges) can't yank
    # the view away mid-interaction; auto-follow resumes after, tracking the agent.
    PIN = 8
    if action == "select" and tab_id:
        if not _hex_tab(tab_id):
            return
        st["follow"] = tab_id
        st["pin"] = time.time() + PIN
        st["sig"] = {p["id"]: _tab_sig_key(p.get("url", "")) for p in _browser_pages(hid)}
        cdp_http(hid, f"/json/activate/{tab_id}")   # bring forward in headed mode
    elif action == "new":
        nav = _safe_nav_url(url) if url else "about:blank"
        if not nav:
            return
        target = quote(nav, safe="")   # into the /json/new query — encode it
        made = cdp_http(hid, f"/json/new?{target}", method="PUT") \
            or cdp_http(hid, f"/json/new?{target}")
        if made and made.get("id"):
            st["follow"] = made["id"]
            st["pin"] = time.time() + PIN
            st["sig"] = {p["id"]: _tab_sig_key(p.get("url", "")) for p in _browser_pages(hid)}
    elif action == "close" and tab_id:
        if not _hex_tab(tab_id):
            return
        cdp_http(hid, f"/json/close/{tab_id}")
        if st.get("follow") == tab_id:
            st["follow"] = None                     # next frame falls back to front
            st["pin"] = 0
    else:
        return {"error": "unknown tab action"}
    browser_conn_drop(hid)                          # re-attach to the followed tab
    return {"ok": True, "tabs": browser_tabs(hid)}


# Facts needed to decide: stream now / launch / install / explain what's missing.
BROWSER_PROBE_SCRIPT = r"""
import json, os, glob, shutil, subprocess, platform
def run(cmd, t=8):
    try:
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=t)
        return p.returncode, p.stdout.strip()
    except Exception as e:
        return -1, str(e)
r = {"os": platform.system()}
cands = [w for n in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")
         if (w := shutil.which(n))]
for pat in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium", "/snap/bin/chromium"):
    if os.path.exists(pat): cands.append(pat)
for root in ("~/.cache/ms-playwright", "~/Library/Caches/ms-playwright"):
    cands += sorted(glob.glob(os.path.expanduser(root + "/chromium-*/chrome-linux/chrome")))
    cands += sorted(glob.glob(os.path.expanduser(root + "/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium")))
r["binary"] = cands[0] if cands else None
# Pick a node that modern tooling can actually run (>=18): the PATH node can be
# ancient (seen: /usr/local/bin/node v17 while nvm has v20+) and @playwright/mcp
# crashes on it. Prefer the newest version that qualifies.
def nodever(p):
    rc, out = run('"%s" --version' % p)
    try:
        return tuple(int(x) for x in out.lstrip("v").split("."))
    except Exception:
        return (0, 0, 0)
node_cands = ([shutil.which("node")] if shutil.which("node") else []) \
    + sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/node")), reverse=True)
node_cands = [(nodever(p), p) for p in node_cands]
node_cands.sort(reverse=True)
r["node"] = next((p for v, p in node_cands if v >= (18,)), node_cands[0][1] if node_cands else None)
try:
    st = os.statvfs(os.path.expanduser("~")); r["free_gb"] = round(st.f_bavail * st.f_frsize / 1e9, 1)
except Exception:
    r["free_gb"] = None
rc, _ = run("sudo -n true 2>/dev/null"); r["passwordless_sudo"] = rc == 0
if r["binary"] and r["os"] == "Linux":
    rc, out = run("ldd %r 2>/dev/null | grep 'not found'" % r["binary"])
    r["missing_libs"] = [l.split()[0] for l in out.splitlines() if l.strip()][:12]
else:
    r["missing_libs"] = []
r["display"] = (sorted(os.path.basename(s)[1:] for s in glob.glob("/tmp/.X11-unix/X*")) or [None])[0]
r["xvfb"] = shutil.which("Xvfb")
r["pkg_mgr"] = next((m for m in ("apt-get", "dnf", "yum", "apk", "pacman", "zypper") if shutil.which(m)), None)
print(json.dumps(r))
"""


def browser_probe(hid):
    if hid != "local":
        txt = remote_run_python(hid, BROWSER_PROBE_SCRIPT)
        return json.loads(txt.strip().splitlines()[-1])
    import platform as _pf
    import glob as _glob
    r = {"os": _pf.system()}
    cands = [w for n in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")
             if (w := shutil.which(n))]
    for root in ("~/.cache/ms-playwright",):
        cands += sorted(_glob.glob(os.path.expanduser(root + "/chromium-*/chrome-linux/chrome")))
    r["binary"] = cands[0] if cands else None
    r["node"] = shutil.which("node")
    try:
        st = os.statvfs(os.path.expanduser("~"))
        r["free_gb"] = round(st.f_bavail * st.f_frsize / 1e9, 1)
    except Exception:
        r["free_gb"] = None
    r["passwordless_sudo"] = subprocess.run("sudo -n true", shell=True, capture_output=True).returncode == 0
    r["missing_libs"] = []
    disp = sorted(os.path.basename(s)[1:] for s in _glob.glob("/tmp/.X11-unix/X*"))
    r["display"] = disp[0] if disp else None
    r["xvfb"] = shutil.which("Xvfb")
    r["pkg_mgr"] = next((m for m in ("apt-get", "dnf", "yum", "apk", "pacman", "zypper") if shutil.which(m)), None)
    return r


def browser_status(hid):
    """Everything the panel needs: running?, or what to do about it, with the
    exact reason for anything that blocks streaming."""
    st = {"running": False, "reasons": [], "action": None}
    running_ua = ""
    try:
        v = cdp_http(hid, "/json/version")
        if v and v.get("Browser"):
            st["running"] = True
            st["browser"] = v["Browser"]
            running_ua = v.get("User-Agent", "")
    except Exception:
        pass
    try:
        st.update(browser_probe(hid))
    except Exception as e:
        st["reasons"].append(f"Cannot probe host: {e}")
        return st
    # How the browser will get a screen. When one is already running, believe
    # its real User-Agent (a live HeadlessChrome must show the warning even if
    # a fresh launch would now pick a headed mode); otherwise report the plan.
    if st["running"]:
        st["display_mode"] = "headless" if "Headless" in running_ua else display_plan(st)[0]
    else:
        st["display_mode"] = display_plan(st)[0]
    if st["display_mode"] == "headless":
        # Explain the block and the best available fix for THIS host.
        base = ("Running headless — the User-Agent says 'HeadlessChrome', which Google and some "
                "sites block on sign-in. ")
        if st.get("os") == "Darwin":
            st["headless_note"] = base + ("Stop and relaunch to open a real headed window "
                "(works if someone is logged in at the Mac's screen).")
        elif st.get("xvfb") or st.get("display"):
            st["headless_note"] = base + "A display is now available — stop and relaunch for a real headed browser."
        elif st.get("pkg_mgr"):
            st["can_install_xvfb"] = True
            st["xvfb_cmd"] = xvfb_install_cmd(st.get("pkg_mgr"))
            st["headless_note"] = base + ("Install a virtual display (Xvfb) for a real headed browser: "
                     + st["xvfb_cmd"] + (" — sudo ready." if st.get("passwordless_sudo") else " — needs sudo."))
        else:
            st["headless_note"] = base + "No package manager found to install Xvfb automatically."
    if st["running"]:
        return st
    if st.get("missing_libs"):
        cmd = "sudo apt-get install -y " + " ".join(
            l.split(".so")[0].replace("_", "-") for l in st["missing_libs"][:8])
        st["reasons"].append(
            f"Browser at {st['binary']} cannot run — missing libraries: "
            + ", ".join(st["missing_libs"]) + f". Fix (needs sudo): {cmd}")
        return st
    if st.get("binary"):
        st["action"] = "launch"
        return st
    if not st.get("node"):
        st["reasons"].append("No Chrome/Chromium found, and node is missing (checked PATH and ~/.nvm) — "
                             "install node first, then Chromium can be installed without sudo.")
        return st
    if (st.get("free_gb") or 0) < 1:
        st["reasons"].append(f"No Chrome/Chromium found, and only {st.get('free_gb')} GB free in home — "
                             "Chromium needs about 0.5 GB.")
        return st
    st["action"] = "install"
    st["reasons"].append("No Chrome/Chromium on this host. Playwright can install Chromium into "
                         "~/.cache/ms-playwright (~300 MB download) — no sudo needed.")
    return st


def display_plan(st):
    """How to give the browser a screen — (mode, headless, display).
      x11      : a real X server is already running → headed on it.
      macos    : macOS window server → headed (needs an active console session).
      xvfb     : headless Linux with Xvfb → headed against a virtual display
                 (real Chrome UA, so Google & co. don't block it).
      headless : last resort → --headless (advertises HeadlessChrome; logins blocked)."""
    if st.get("display"):
        return "x11", False, st["display"]
    if st.get("os") == "Darwin":
        return "macos", False, None
    if st.get("xvfb"):
        return "xvfb", False, str(BROWSER_XVFB_DISPLAY)
    return "headless", True, None


def _run_host(hid, script, timeout=25):
    if hid == "local":
        subprocess.run(["bash", "-lc", script], timeout=timeout,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        with SSH.lock_for(hid):
            c = SSH.get(hid)
            _, o, _ = c["client"].exec_command("bash -lc " + shlex.quote(script), timeout=timeout)
            o.channel.settimeout(timeout)
            o.read()


def ensure_xvfb(hid, display):
    """Start a virtual X server on :display if one isn't already there. Idempotent
    and cheap; left running between browser restarts so relaunch is instant."""
    sock = f"/tmp/.X11-unix/X{display}"
    start = (f"nohup Xvfb :{display} -screen 0 1280x800x24 -nolisten tcp "
             f">/tmp/.viewer-xvfb-{display}.log 2>&1 & disown")
    script = (f"test -S {sock} || ( {start}; "
              f"for i in $(seq 1 25); do test -S {sock} && break; sleep 0.2; done )")
    _run_host(hid, script, timeout=25)


def browser_start(hid, headless=None):
    st = browser_status(hid)
    if st.get("running"):
        return {"started": True, "already": True}
    binary = st.get("binary")
    if not binary:
        return {"error": "No browser binary on host — " + "; ".join(st.get("reasons") or ["probe failed"])}
    mode, plan_headless, display = display_plan(st)
    if headless is None:
        headless = plan_headless
    else:
        mode = "headless" if headless else mode
    if mode == "xvfb":
        try:
            ensure_xvfb(hid, display)
        except Exception as e:
            return {"error": f"Could not start the virtual display (Xvfb): {e}"}
    profile = "$HOME/" + BROWSER_PROFILE if hid != "local" else str(Path.home() / BROWSER_PROFILE)
    # --headless needs --disable-gpu (its GPU compositor yields blank screenshots
    # on machines that have a GPU). Headed under Xvfb software-renders fine as-is.
    flags = (f"--remote-debugging-port={BROWSER_PORT} --user-data-dir={profile} "
             "--no-first-run --no-default-browser-check --disable-session-crashed-bubble "
             "--window-size=1280,800" + (" --headless --disable-gpu" if headless else ""))
    env = f"DISPLAY=:{display} " if (not headless and display) else ""
    launch = f"{env}nohup {shlex.quote(binary)} {flags} about:blank >/dev/null 2>&1 & disown"
    if hid == "local":
        subprocess.Popen(["bash", "-lc", launch], stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    else:
        with SSH.lock_for(hid):
            c = SSH.get(hid)
            c["client"].exec_command("bash -lc " + shlex.quote(launch), timeout=20)
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            v = cdp_http(hid, "/json/version")
            if v and v.get("Browser"):
                return {"started": True, "browser": v["Browser"], "headless": headless, "display_mode": mode}
        except Exception:
            pass
        time.sleep(0.7)
    hint = ("It may need a logged-in desktop session on macOS." if mode == "macos"
            else "Try launching it manually on the host to see its output.")
    return {"error": f"Browser did not open its debugging port within 20s — it may have crashed. {hint}"}


def browser_stop(hid):
    browser_conn_drop(hid)
    kill = f"pkill -f {shlex.quote(BROWSER_PROFILE)} 2>/dev/null; true"
    if hid == "local":
        subprocess.run(kill, shell=True, timeout=15)
    else:
        with SSH.lock_for(hid):
            c = SSH.get(hid)
            _, out, _ = c["client"].exec_command("bash -lc " + shlex.quote(kill), timeout=15)
            out.read()
    return {"stopped": True}


def browser_install(hid):
    """User-space Chromium via Playwright — no sudo. Slow (hundreds of MB), so
    the HTTP request stays open while it runs; the UI shows a spinner."""
    st = browser_probe(hid)
    if not st.get("node"):
        return {"error": "node not found on the host (checked PATH and ~/.nvm) — install node first."}
    node_dir = posixpath.dirname(st["node"])
    cmd = f"export PATH={shlex.quote(node_dir)}:\"$PATH\" && npx --yes playwright install chromium 2>&1 | tail -5"
    if hid == "local":
        p = subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, timeout=900)
        out, rc = p.stdout.strip(), p.returncode
    else:
        with SSH.lock_for(hid):
            c = SSH.get(hid)
            _, o, _ = c["client"].exec_command("bash -lc " + shlex.quote(cmd), timeout=900)
            o.channel.settimeout(900)
            out = o.read().decode("utf-8", "replace").strip()
            rc = o.channel.recv_exit_status()
    if rc != 0:
        return {"error": f"Install failed (exit {rc}): {out[-500:]}"}
    fresh = browser_probe(hid)
    if not fresh.get("binary"):
        return {"error": "Install reported success but no Chromium binary was found afterwards: " + out[-300:]}
    return {"installed": True, "binary": fresh["binary"]}


def browser_install_xvfb(hid):
    """Install Xvfb (a system package, needs sudo) so a display-less Linux host
    can run a real HEADED browser instead of the Google-blocked headless one."""
    st = browser_probe(hid)
    if not st.get("pkg_mgr"):
        return {"error": "No supported package manager (apt/dnf/apk/pacman/zypper) found — "
                         "install the Xvfb package manually, then reopen this panel."}
    if not st.get("passwordless_sudo"):
        return {"error": "Installing Xvfb needs sudo, which isn't available non-interactively here. "
                         "Run this on the host yourself: " + xvfb_install_cmd(st["pkg_mgr"])}
    cmd = xvfb_install_cmd(st["pkg_mgr"]) + " 2>&1 | tail -5"
    if hid == "local":
        p = subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, timeout=300)
        out, rc = p.stdout.strip(), p.returncode
    else:
        with SSH.lock_for(hid):
            c = SSH.get(hid)
            _, o, _ = c["client"].exec_command("bash -lc " + shlex.quote(cmd), timeout=300)
            o.channel.settimeout(300)
            out = o.read().decode("utf-8", "replace").strip()
            rc = o.channel.recv_exit_status()
    if rc != 0:
        return {"error": f"Xvfb install failed (exit {rc}): {out[-400:]}"}
    if not browser_probe(hid).get("xvfb"):
        return {"error": "Install finished but Xvfb still isn't on PATH: " + out[-300:]}
    return {"installed": True}


# Auto-start the watched browser for agent runs: if a host's MCP config points
# Playwright at our managed CDP port, the browser must be up BEFORE claude
# boots, or the agent's browser tools attach to nothing.
MCP_CDP_CACHE = {}   # hid -> {"at": ts, "cdp": bool}; invalidated by mcp/save


def host_mcp_wants_cdp(hid):
    now = time.time()
    c = MCP_CDP_CACHE.get(hid)
    if c and now - c["at"] < 300:
        return c["cdp"]
    try:
        if hid == "local":
            cfg = json.loads((Path.home() / ".claude.json").read_text()).get("mcpServers", {})
        else:
            out = remote_run_python(hid,
                "import json,os\n"
                "try: d=json.load(open(os.path.expanduser('~/.claude.json')))\n"
                "except Exception: d={}\n"
                "print(json.dumps(d.get('mcpServers',{})))\n")
            cfg = json.loads(out.strip().splitlines()[-1])
    except Exception:
        cfg = {}
    wants = False
    for srv in cfg.values():
        if not isinstance(srv, dict):
            continue
        joined = " ".join(str(a) for a in (srv.get("args") or []))
        m = re.search(r"--cdp-endpoint[= ]\S*?(?:127\.0\.0\.1|localhost):(\d+)", joined)
        if m and int(m.group(1)) == BROWSER_PORT:
            wants = True
            break
    MCP_CDP_CACHE[hid] = {"at": now, "cdp": wants}
    return wants


def ensure_mcp_browser(hid):
    """Called before each claude run. No-op unless the host's MCP config uses
    our CDP port; ~50ms when the browser is already up (one /json/version over
    the existing tunnel); launches it when it isn't. Never blocks the chat —
    any failure just means the agent's browser tools report their own error."""
    try:
        if not host_mcp_wants_cdp(hid):
            return
        try:
            v = cdp_http(hid, "/json/version")
            if v and v.get("Browser"):
                return
        except Exception:
            pass
        browser_start(hid)
    except Exception:
        pass


# Cached CDP connections keyed by (hid, page_id) — one per TAB, not per host.
# A WS handshake per frame/keystroke would be far too slow, but a single
# per-host conn was worse: frame-polling and input share it, and the view
# switching tabs would close the socket mid-operation (back/forward silently
# died). Per-tab conns are stable — following a new tab just uses that tab's
# own conn. Each carries a lock (interleaved call()s would steal replies).
BROWSER_INPUT = {}   # (hid, page_id) -> {"ws","cdp","lock"}
BROWSER_INPUT_LOCK = threading.Lock()


def browser_conn(hid, page_id, ws_path):
    key = (hid, page_id)
    with BROWSER_INPUT_LOCK:
        conn = BROWSER_INPUT.get(key)
    if conn:
        return conn
    ws = WSConn(browser_sock(hid, timeout=30), ws_path)
    conn = {"ws": ws, "cdp": CDP(ws), "lock": threading.Lock()}
    with BROWSER_INPUT_LOCK:
        BROWSER_INPUT[key] = conn
    return conn


def browser_conn_drop(hid, page_id=None):
    """Drop one tab's conn, or (page_id=None) every conn for the host."""
    with BROWSER_INPUT_LOCK:
        if page_id is None:
            keys = [k for k in BROWSER_INPUT if k[0] == hid]
        else:
            keys = [(hid, page_id)] if (hid, page_id) in BROWSER_INPUT else []
        dropped = [BROWSER_INPUT.pop(k) for k in keys]
    for conn in dropped:
        try:
            conn["ws"].close()
        except Exception:
            pass


def _followed_conn(hid):
    """(conn, url) for the tab the view currently follows, connecting if needed."""
    pid, path, url = browser_front_page(hid)
    try:
        return browser_conn(hid, pid, path), url
    except Exception:
        browser_conn_drop(hid, pid)   # stale (tab closed/reloaded) — reconnect once
        pid, path, url = browser_front_page(hid)
        return browser_conn(hid, pid, path), url


def browser_frame(hid):
    """One JPEG of the followed page plus its URL. The UI polls this a few times
    a second — captureScreenshot works in headed AND headless mode, unlike
    screencast, and plain <img> polling works in every browser, unlike MJPEG
    (Chromium dropped multipart/x-mixed-replace years ago). Follows the agent
    because browser_front_page picks the active tab each call."""
    conn, url = _followed_conn(hid)
    try:
        with conn["lock"]:
            shot = conn["cdp"].call("Page.captureScreenshot", {"format": "jpeg", "quality": 60})
        return base64.b64decode(shot["data"]), url
    except Exception:
        browser_conn_drop(hid)
        conn, url = _followed_conn(hid)
        with conn["lock"]:
            shot = conn["cdp"].call("Page.captureScreenshot", {"format": "jpeg", "quality": 60})
        return base64.b64decode(shot["data"]), url

VK = {"Enter": 13, "Backspace": 8, "Tab": 9, "Escape": 27, "ArrowLeft": 37, "ArrowUp": 38,
      "ArrowRight": 39, "ArrowDown": 40, "Delete": 46, "Home": 36, "End": 35,
      "PageUp": 33, "PageDown": 34}


def browser_input(hid, events):
    # Pin BEFORE dispatching so a concurrent frame poll can't switch the followed
    # tab out from under this operation while it runs.
    if any(e.get("type") in ("navigate", "back", "forward", "reload") for e in events):
        st = TAB_FOLLOW.get(hid)
        if st:
            st["pin"] = time.time() + 8
    try:
        conn, _ = _followed_conn(hid)
        with conn["lock"]:
            _dispatch_browser_events(conn["cdp"], events)
        return {"ok": True}
    except Exception as e:
        browser_conn_drop(hid)   # stale connection — next call reconnects
        return {"error": f"input failed: {e}"}


def _cdp_mods(ev):
    """CDP modifier bitmask: 1=Alt 2=Ctrl 4=Meta 8=Shift."""
    return ((1 if ev.get("alt") else 0) | (2 if ev.get("ctrl") else 0)
            | (4 if ev.get("meta") else 0) | (8 if ev.get("shift") else 0))


def _dispatch_browser_events(cdp, events):
    for ev in events:
        t = ev.get("type")
        x, y = int(ev.get("x", 0)), int(ev.get("y", 0))
        mods = _cdp_mods(ev)
        btn = ev.get("button", "left")
        if t == "click":
            for mtype in ("mousePressed", "mouseReleased"):
                cdp.call("Input.dispatchMouseEvent",
                         {"type": mtype, "x": x, "y": y, "button": btn, "buttons": 1,
                          "clickCount": int(ev.get("clicks", 1)), "modifiers": mods})
        elif t == "move":     # hover / drag move (buttons: 1 while dragging)
            cdp.call("Input.dispatchMouseEvent",
                     {"type": "mouseMoved", "x": x, "y": y,
                      "buttons": int(ev.get("buttons", 0)), "modifiers": mods})
        elif t == "down":
            cdp.call("Input.dispatchMouseEvent",
                     {"type": "mousePressed", "x": x, "y": y, "button": btn, "buttons": 1,
                      "clickCount": 1, "modifiers": mods})
        elif t == "up":
            cdp.call("Input.dispatchMouseEvent",
                     {"type": "mouseReleased", "x": x, "y": y, "button": btn, "buttons": 0,
                      "clickCount": 1, "modifiers": mods})
        elif t == "wheel":
            cdp.call("Input.dispatchMouseEvent",
                     {"type": "mouseWheel", "x": x, "y": y, "modifiers": mods,
                      "deltaX": int(ev.get("dx", 0)), "deltaY": int(ev.get("dy", 0))})
        elif t == "text":
            cdp.call("Input.insertText", {"text": str(ev.get("text", ""))[:200]})
        elif t == "key":
            key = ev.get("key", "")
            vk = VK.get(key)
            # Printable char with a modifier (e.g. Ctrl+A) still needs a key event
            # with the virtual code; without a modifier the browser gets it via
            # insertText (sent separately by the client), so skip bare chars here.
            if not vk and (len(key) != 1 or not (ev.get("ctrl") or ev.get("meta") or ev.get("alt"))):
                continue
            code = vk or ord(key.upper()[0])
            base = {"windowsVirtualKeyCode": code, "key": key, "modifiers": mods}
            cdp.call("Input.dispatchKeyEvent", {"type": "rawKeyDown", **base})
            if key == "Enter" and not mods:
                cdp.call("Input.dispatchKeyEvent", {"type": "char", "text": "\r"})
            cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", **base})
        elif t == "navigate":
            url = _safe_nav_url(ev.get("url", ""))
            if url:
                cdp.call("Page.navigate", {"url": url})
        elif t in ("back", "forward"):
            h = cdp.call("Page.getNavigationHistory")
            idx = h["currentIndex"] + (1 if t == "forward" else -1)
            if 0 <= idx < len(h.get("entries", [])):
                cdp.call("Page.navigateToHistoryEntry", {"entryId": h["entries"][idx]["id"]})
        elif t == "reload":
            cdp.call("Page.reload", {})


def dispatch_input_fast(cdp, events):
    """Fire-and-forget pointer/keyboard dispatch for the live view. Uses
    cdp.send (no round-trip wait) so a slow SSH link can't turn each event into
    a blocking ~100ms round-trip; the caller drains replies afterward. A click
    sends a mouseMoved to the point first (Playwright's forClick move) so
    hover-gated elements react. Only pointer/keyboard here — nav goes via POST."""
    def mouse(mtype, x, y, **kw):
        cdp.send("Input.dispatchMouseEvent", {"type": mtype, "x": x, "y": y, **kw})
    for ev in events:
        t = ev.get("type")
        x, y = int(ev.get("x", 0)), int(ev.get("y", 0))
        mods = _cdp_mods(ev)
        btn = ev.get("button", "left")
        bmask = 1 if btn == "left" else (2 if btn == "right" else 4)
        if t == "down":
            mouse("mouseMoved", x, y, buttons=0, modifiers=mods)          # position/hover first
            mouse("mousePressed", x, y, button=btn, buttons=bmask, clickCount=1, modifiers=mods)
        elif t == "up":
            mouse("mouseReleased", x, y, button=btn, buttons=0, clickCount=1, modifiers=mods)
        elif t == "click":
            mouse("mouseMoved", x, y, buttons=0, modifiers=mods)
            mouse("mousePressed", x, y, button=btn, buttons=bmask, clickCount=int(ev.get("clicks", 1)), modifiers=mods)
            mouse("mouseReleased", x, y, button=btn, buttons=0, clickCount=int(ev.get("clicks", 1)), modifiers=mods)
        elif t == "move":
            mouse("mouseMoved", x, y, buttons=int(ev.get("buttons", 0)), modifiers=mods)
        elif t == "wheel":
            mouse("mouseWheel", x, y, deltaX=int(ev.get("dx", 0)), deltaY=int(ev.get("dy", 0)), modifiers=mods)
        elif t == "text":
            cdp.send("Input.insertText", {"text": str(ev.get("text", ""))[:200]})
        elif t == "key":
            key = ev.get("key", "")
            vk = VK.get(key)
            if not vk and (len(key) != 1 or not (ev.get("ctrl") or ev.get("meta") or ev.get("alt"))):
                continue
            code = vk or ord(key.upper()[0])
            base = {"windowsVirtualKeyCode": code, "key": key, "modifiers": mods}
            cdp.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", **base})
            if key == "Enter" and not mods:
                cdp.send("Input.dispatchKeyEvent", {"type": "char", "text": "\r"})
            cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", **base})
        elif t == "navigate":
            url = str(ev.get("url", "")).strip()
            if url and not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", url):
                url = "https://" + url
            if url:
                cdp.send("Page.navigate", {"url": url})
        elif t == "reload":
            cdp.send("Page.reload", {})


# ===== Live terminal (PTY over a WebSocket) =====
#
# A real interactive shell per host, streamed to xterm.js in the browser.
# Local uses pty.fork()+shell (same primitive as the login flow); remote uses
# paramiko invoke_shell() over the pooled SSH connection. The transport is a
# WebSocket the plain HTTP server upgrades in-place — server→client frames are
# raw PTY output (binary), client→server frames are JSON control (input/resize).

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"   # RFC6455 handshake magic


class WSServer:
    """Server side of a WebSocket, driving one HTTP handler's raw socket after
    a successful Upgrade. Client frames are masked (we unmask); ours aren't."""

    def __init__(self, sock):
        self.sock = sock
        self.buf = b""
        self.send_lock = threading.Lock()
        self.closed = False

    @classmethod
    def upgrade(cls, handler):
        key = handler.headers.get("Sec-WebSocket-Key")
        if not key or handler.headers.get("Upgrade", "").lower() != "websocket":
            handler.send_json({"error": "expected a WebSocket upgrade"}, status=400)
            return None
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        handler.send_response(101, "Switching Protocols")
        handler.send_header("Upgrade", "websocket")
        handler.send_header("Connection", "Upgrade")
        handler.send_header("Sec-WebSocket-Accept", accept)
        handler.end_headers()
        try:
            handler.wfile.flush()
        except Exception:
            pass
        return cls(handler.connection)

    def _recv_into(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise OSError("websocket closed")
        self.buf += chunk

    def _take(self, n):
        while len(self.buf) < n:
            self._recv_into()
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        """Return (opcode, data) for the next data/close frame; handles ping."""
        while True:
            b1, b2 = self._take(2)
            _fin, opcode = b1 & 0x80, b1 & 0x0F
            masked, ln = b2 & 0x80, b2 & 0x7F
            if ln == 126:
                ln = struct.unpack("!H", self._take(2))[0]
            elif ln == 127:
                ln = struct.unpack("!Q", self._take(8))[0]
            mask = self._take(4) if masked else b"\x00\x00\x00\x00"
            payload = self._take(ln)
            if masked:
                payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
            if opcode == 0x9:                       # ping -> pong
                self._send(0xA, payload)
                continue
            if opcode == 0x8:                       # close
                return 0x8, payload
            if opcode in (0x0, 0x1, 0x2):
                return opcode, payload

    def _send(self, opcode, data):
        if isinstance(data, str):
            data = data.encode()
        ln = len(data)
        if ln < 126:
            hdr = struct.pack("!BB", 0x80 | opcode, ln)
        elif ln < 65536:
            hdr = struct.pack("!BBH", 0x80 | opcode, 126, ln)
        else:
            hdr = struct.pack("!BBQ", 0x80 | opcode, 127, ln)
        with self.send_lock:
            if self.closed:
                return
            self.sock.sendall(hdr + data)

    def send_bytes(self, data):
        self._send(0x2, data)

    def send_text(self, data):
        self._send(0x1, data)

    def close(self):
        with self.send_lock:
            if self.closed:
                return
            self.closed = True
        try:
            self.sock.sendall(struct.pack("!BB", 0x88, 0))   # close frame
        except Exception:
            pass


class TerminalSession:
    """A PTY-backed shell, local or remote, with a uniform read/write/resize."""

    def __init__(self, hid, cols=80, rows=24):
        self.hid = hid
        self.remote = hid != "local"
        cols, rows = max(2, int(cols)), max(1, int(rows))
        if self.remote:
            with SSH.lock_for(hid):
                c = SSH.get(hid)
                self.chan = c["client"].invoke_shell(term="xterm-256color", width=cols, height=rows)
            self.chan.settimeout(None)
        else:
            self.pid, self.fd = pty.fork()
            if self.pid == 0:
                os.environ["TERM"] = "xterm-256color"
                try:  # per-host env vars (e.g. GH_TOKEN) — set in the child, never echoed
                    from viewer.hostenv import host_env
                    os.environ.update(host_env("local"))
                except Exception:
                    pass
                shell = os.environ.get("SHELL") or "/bin/bash"
                try:
                    os.execvp(shell, [shell, "-l"])
                except Exception:
                    os.execvp("/bin/sh", ["/bin/sh"])
            self.resize(cols, rows)

    def read(self):
        """Blocking read of terminal output; b'' on EOF."""
        try:
            if self.remote:
                return self.chan.recv(65536)
            return os.read(self.fd, 65536)
        except OSError:
            return b""

    def write(self, data):
        if isinstance(data, str):
            data = data.encode("utf-8", "replace")
        try:
            if self.remote:
                self.chan.send(data)
            else:
                os.write(self.fd, data)
        except OSError:
            pass

    def resize(self, cols, rows):
        cols, rows = max(2, int(cols)), max(1, int(rows))
        try:
            if self.remote:
                self.chan.resize_pty(width=cols, height=rows)
            else:
                fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            pass

    def close(self):
        try:
            if self.remote:
                self.chan.close()
            else:
                os.close(self.fd)
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
        except OSError:
            pass


# ---- Persistent, reattachable terminals --------------------------------------
# A PTY that outlives any single WebSocket. A reader thread always drains it into
# a ring buffer (so it never blocks when no browser is attached), and a client
# that (re)connects replays recent output and keeps the SAME running process:
# a browser refresh, a new tab, or a second device all reattach to the same
# session, so an interactive `copilot` mid-task stays alive. Keyed by `key`
# (defaults to the host) — one persistent terminal per key.
TERM_SESSIONS = {}          # key -> PersistentTerminal
TERM_REGISTRY_LOCK = threading.Lock()
TERM_BUFFER_MAX = 512 * 1024


class PersistentTerminal:
    def __init__(self, key, hid, cols, rows):
        self.key = key
        self.term = TerminalSession(hid, cols, rows)
        self.buffer = bytearray()
        self.clients = set()
        self.lock = threading.Lock()
        self.alive = True
        self.created = time.time()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        """Always drain the PTY into the ring buffer + fan out to live clients."""
        while True:
            data = self.term.read()
            if not data:
                break
            with self.lock:
                self.buffer += data
                if len(self.buffer) > TERM_BUFFER_MAX:
                    del self.buffer[:len(self.buffer) - TERM_BUFFER_MAX]
                clients = list(self.clients)
            for ws in clients:
                try:
                    ws.send_bytes(data)
                except Exception:
                    pass
        # Shell exited (EOF) -> drop from the registry and close any clients.
        self.alive = False
        with TERM_REGISTRY_LOCK:
            if TERM_SESSIONS.get(self.key) is self:
                TERM_SESSIONS.pop(self.key, None)
        with self.lock:
            clients, self.clients = list(self.clients), set()
        for ws in clients:
            try:
                ws.close()
            except Exception:
                pass

    def attach(self, ws):
        # Replay the backlog and register the client atomically, so no output
        # slips in between the snapshot and the client going live (out-of-order).
        with self.lock:
            if self.buffer:
                try:
                    ws.send_bytes(bytes(self.buffer))
                except Exception:
                    pass
            self.clients.add(ws)

    def detach(self, ws):
        with self.lock:
            self.clients.discard(ws)

    def write(self, data):
        self.term.write(data)

    def resize(self, cols, rows):
        self.term.resize(cols, rows)

    def close(self):
        self.alive = False
        with TERM_REGISTRY_LOCK:
            if TERM_SESSIONS.get(self.key) is self:
                TERM_SESSIONS.pop(self.key, None)
        self.term.close()


def serve_terminal_ws(handler, hid, cols, rows, key="", init=""):
    ws = WSServer.upgrade(handler)
    if not ws:
        return
    key = key or ("host:" + (hid or "local"))
    with TERM_REGISTRY_LOCK:
        pt = TERM_SESSIONS.get(key)
        fresh = pt is None or not pt.alive
        if fresh:
            try:
                pt = PersistentTerminal(key, hid, cols, rows)
            except Exception as e:
                try:
                    ws.send_bytes(f"\r\n\x1b[31mCould not open a shell: {e}\x1b[0m\r\n".encode())
                except Exception:
                    pass
                ws.close()
                return
            TERM_SESSIONS[key] = pt
    pt.resize(cols, rows)
    pt.attach(ws)
    if fresh and init:
        pt.write(init if init.endswith("\n") else init + "\n")
    elif not fresh:
        pt.resize(cols, rows)   # nudge a reattaching TUI (e.g. copilot) to repaint

    try:
        while True:
            op, payload = ws.recv()
            if op == 0x8:
                break
            try:
                msg = json.loads(payload.decode("utf-8", "replace"))
            except Exception:
                continue
            t = msg.get("t")
            if t == "i":
                pt.write(msg.get("d", ""))
            elif t == "r":
                pt.resize(msg.get("cols", 80), msg.get("rows", 24))
            elif t == "k":          # explicit reset/kill from the UI
                pt.close()
                break
    except Exception:
        pass
    finally:
        pt.detach(ws)               # keep the PTY alive across disconnects
        ws.close()


# ===== Browser live view over a WebSocket (push frames + low-latency input) =====
#
# Replaces the frame-polling GET/POST pair. Headed browsers push ~24fps via CDP
# Page.startScreencast; headless ones (screencast delivers ~1 frame) fall back
# to captureScreenshot polling. Input (click/move/drag/wheel/key) rides the same
# socket. Tab-follow is re-checked ~1/s so the view tracks the agent's tab.

def serve_browser_ws(handler, hid):
    ws = WSServer.upgrade(handler)
    if not ws:
        return
    stop = threading.Event()

    def send_url(url):
        try:
            ws.send_text(json.dumps({"url": url}))
        except Exception:
            pass

    # One hybrid pump: relay CDP screencast frames when the browser actually
    # emits them (headed → smooth), and poll captureScreenshot when it doesn't
    # (headless, or a headed browser with no compositor like a session-less Mac —
    # screencast accepts the command but produces nothing). Rate-capped and
    # coalesced to the LATEST frame so a fast producer can't lag a slow link.
    MIN_GAP = 1.0 / 20         # rate cap (send at most ~20fps; coalesce faster ones)
    POLL_STALE = 2.5           # screencast silent this long → ONE screenshot poll

    # Tab-follow runs in its OWN thread: browser_front_page does a /json/list
    # round-trip (~1.5s over SSH); running it inline would stall the frame loop
    # and cap the whole stream at <1fps. Here it just publishes the followed tab
    # + sends the url/heartbeat; the frame pump reads it without blocking.
    follow = {"pid": None, "path": None, "url": None, "gen": 0}

    def follower():
        last_url = None
        fail = 0
        while not stop.is_set():
            try:
                pid, path, url = browser_front_page(hid)
                fail = 0
            except Exception:
                fail += 1
                if fail > 6:              # browser unreachable ~ many s → end session
                    stop.set(); break
                stop.wait(0.5); continue
            if pid != follow["pid"]:
                follow.update(pid=pid, path=path, gen=follow["gen"] + 1)
            follow["url"] = url
            if url != last_url:
                last_url = url; send_url(url)
            else:
                try: ws.send_text('{"ping":1}')      # heartbeat on static pages
                except Exception: stop.set(); break
            stop.wait(1.2)

    def pump():
        sc = sccdp = None
        cur_gen = -1
        pending, last_send, last_sc = None, 0.0, time.time()
        try:
            while not stop.is_set():
                if follow["pid"] is None:            # wait for the first tab lookup
                    stop.wait(0.1); continue
                if follow["gen"] != cur_gen:         # (re)attach screencast to the followed tab
                    cur_gen = follow["gen"]; path = follow["path"]
                    if sc:
                        try: sc.close()
                        except Exception: pass
                    try:
                        sc = WSConn(browser_sock(hid, timeout=20), path)
                        sccdp = CDP(sc)
                        sccdp.call("Page.enable")
                        shot = sccdp.call("Page.captureScreenshot", {"format": "jpeg", "quality": 50})
                        try: ws.send_bytes(base64.b64decode(shot["data"]))
                        except Exception: break
                        sccdp.call("Page.startScreencast",
                                   {"format": "jpeg", "quality": 50, "maxWidth": 1280,
                                    "maxHeight": 800, "everyNthFrame": 1})
                    except Exception:
                        sc = sccdp = None
                    last_send = last_sc = time.time()
                if sccdp is not None:
                    sc.s.settimeout(0.7)
                    try:
                        msg = sccdp.next_message()
                        if msg.get("method") == "Page.screencastFrame":
                            p = msg["params"]
                            try: sccdp.send("Page.screencastFrameAck", {"sessionId": p["sessionId"]})
                            except Exception: pass
                            pending = p["data"]; last_sc = time.time()
                    except (socket.timeout, OSError):
                        pass
                    except Exception:
                        # Reconnect, but back off first so a persistently-failing
                        # tab (e.g. crashed renderer) can't spin this thread tight
                        # and pin a CPU.
                        cur_gen = -1
                        stop.wait(0.5)
                        continue
                else:
                    stop.wait(0.2)
                now = time.time()
                if pending is not None and now - last_send >= MIN_GAP:
                    try: ws.send_bytes(base64.b64decode(pending))
                    except Exception: break
                    pending = None; last_send = now
                elif pending is None and now - last_sc > POLL_STALE:
                    try:                              # screencast dead — one slow screenshot
                        frame, _ = browser_frame(hid)
                        ws.send_bytes(frame); last_sc = last_send = time.time()
                    except Exception:
                        pass
        finally:
            if sc:
                try: sc.close()
                except Exception: pass

    threading.Thread(target=follower, daemon=True).start()
    threading.Thread(target=pump, daemon=True).start()

    # Input is dispatched on its OWN thread, decoupled from the WS receive loop.
    # The receive loop only enqueues (fast) and COALESCES consecutive moves, so a
    # flood of hover-moves can never back up ahead of a click/keystroke. The
    # dispatcher fires events (no round-trip wait) to the followed tab and drains
    # replies. This is what makes input feel realtime over SSH.
    inq = []
    inq_lock = threading.Lock()
    inq_evt = threading.Event()

    def enqueue(evs):
        with inq_lock:
            for ev in evs:
                if ev.get("type") == "move" and inq and inq[-1].get("type") == "move":
                    inq[-1] = ev                       # coalesce: only the latest hover matters
                else:
                    inq.append(ev)
            if len(inq) > 300:
                del inq[:len(inq) - 300]               # safety cap
        inq_evt.set()

    def dispatcher():
        while not stop.is_set():
            inq_evt.wait(0.2)
            inq_evt.clear()
            pid, path = follow.get("pid"), follow.get("path")
            if not pid:
                continue                               # tab not resolved yet — KEEP events queued
            with inq_lock:
                batch, inq[:] = list(inq), []
            if not batch:
                continue
            try:
                conn = browser_conn(hid, pid, path)    # cached per-tab, no /json/list
                with conn["lock"]:
                    dispatch_input_fast(conn["cdp"], batch)
                    conn["ws"].drain()                 # discard fire-and-forget replies
            except Exception:
                browser_conn_drop(hid, pid)

    threading.Thread(target=dispatcher, daemon=True).start()

    try:
        while True:
            op, payload = ws.recv()
            if op == 0x8:
                break
            if op != 0x1:
                continue
            try:
                ev = json.loads(payload.decode("utf-8", "replace"))
            except Exception:
                continue
            enqueue(ev if isinstance(ev, list) else [ev])
    except Exception:
        pass
    finally:
        stop.set()
        inq_evt.set()
        ws.close()
