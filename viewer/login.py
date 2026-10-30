"""viewer.login — Claude, Codex, Copilot and MCP-server OAuth login managers and auth status."""
import json
import os
import posixpath
import re
import shlex
import shutil
import threading
import time
from urllib.parse import urlparse
from viewer import ptyproc
from viewer.agents import find_agent_bin
from viewer.config import (
    ANSI_RE, CREDENTIALS_FILE, VIEWER_TOKEN_FILE, claude_bin,
)
from viewer.remote import (
    SSH, remote_codex_bin, remote_codex_logged_in, remote_copilot_bin, remote_copilot_logged_in, remote_run_shell,
)
from viewer.termscreen import Screen


def _redact(text):
    """Strip any OAuth token from text before it's surfaced to the client. The
    error field returns raw CLI buffer tails, which can contain the token."""
    return re.sub(r"sk-ant-oat[0-9A-Za-z_-]+", "<token>", text or "")


def auth_status():
    """Report whether claude is logged in, based on stored credentials."""
    info = {"loggedIn": False, "method": None, "subscriptionType": None}
    try:
        creds = json.loads(CREDENTIALS_FILE.read_text())
        oauth = creds.get("claudeAiOauth") or {}
        if oauth.get("accessToken") or oauth.get("refreshToken"):
            info.update({"loggedIn": True, "method": "oauth",
                         "subscriptionType": oauth.get("subscriptionType")})
            return info
    except Exception:
        pass
    if VIEWER_TOKEN_FILE.exists():
        info.update({"loggedIn": True, "method": "setup-token"})
    elif os.environ.get("ANTHROPIC_API_KEY"):
        info.update({"loggedIn": True, "method": "api-key"})
    return info


def _pty_spawn(argv, cols=2000, cwd=None):
    """Start a sign-in CLI on a fresh 50-row pty, wide (2000 columns by default)
    so the OAuth URL is never hard-wrapped. A CLI that cannot start reads
    "Could not start ..." and exits 127 (viewer.ptyproc's contract), which the
    reader turns into an error stage instead of sitting at "starting"."""
    return ptyproc.spawn(argv, cols, 50, cwd=cwd)


class _SshPty:
    """An SSH channel with a pty, shaped like a viewer.ptyproc process (read,
    write, wait, kill, close), so one reader loop drives a sign-in CLI whether
    it runs on this machine or on a remote host."""

    def __init__(self, chan):
        self.chan = chan

    def read(self, n):
        try:
            return self.chan.recv(n)
        except Exception:
            return b""

    def write(self, data):
        self.chan.sendall(data)

    def wait(self):
        try:
            return self.chan.recv_exit_status()
        except Exception:
            return 0

    def kill(self, group=False):
        self.close()  # closing the channel hangs up the remote pty

    def close(self):
        try:
            self.chan.close()
        except Exception:
            pass


def _missing_cli(name, binpath):
    """A plain, actionable error when a CLI is not installed — checked before
    forking so the owner sees why, not a spinner."""
    if shutil.which(binpath) or os.access(binpath, os.X_OK):
        return ""
    return (f"{name} is not installed on this computer, so sign-in cannot start. "
            f"Install it (or update Harman, which installs it), then try again.")


_TOKEN_RE = re.compile(r"sk-ant-oat[0-9A-Za-z_-]{20,}")
_CLAUDE_URL_RE = re.compile(r"https://claude\.(?:com|ai)/\S*oauth\S+")
NO_TOKEN_ERROR = "Sign-in finished but Harman could not read the token \u2014 try again."


def _drawn_match(screen, pattern, final=False):
    """First match of pattern on the rendered screen that is fully drawn: the
    CLI has moved past it (cursor on another line, or more text after it on the
    same line). A match the cursor is still sitting at the end of may be a
    token or URL cut mid-chunk. `final` (the CLI exited) accepts any match."""
    lines = screen.logical_lines()
    cur = screen.cursor_line()
    for i, line in enumerate(lines):
        for m in pattern.finditer(line):
            if final or i != cur or m.end() < len(line):
                return m.group(0)
    return None


class LoginManager:
    """Drives `claude setup-token` through a pty: exposes the OAuth URL,
    forwards the pasted code, and reports completion. The CLI's output is read
    through a screen model (viewer/termscreen.py), never by deleting escape
    codes — Claude Code draws with cursor moves, and stripping them garbles
    the token it prints."""

    COLS = 2000   # wide, so neither the URL nor the token wraps

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.proc = None
        self.screen = Screen(cols=self.COLS)
        self.url = None
        self.stage = "idle"   # idle | starting | url | done | error
        self.error = ""
        self.started = 0
        self.code_seq = 0     # screen write counter when the last code was submitted
        self.acked_seq = 0    # screen write counter when "press enter" was last answered

    def start(self):
        with self.lock:
            if self.stage in ("starting", "url") and self.proc:
                return  # already in progress; frontend will pick up the URL
            self.cancel_locked()
            self.reset()
            missing = _missing_cli("Claude Code", claude_bin())
            if missing:
                self.stage, self.error = "error", missing
                return
            self.stage = "starting"
            self.started = time.time()
            self.proc = _pty_spawn([claude_bin(), "setup-token"], cols=self.COLS)
            threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()

    def _finish(self, token):
        """Save the captured token and end the flow — done only if it is on disk."""
        if self._save_token(token):
            self.stage = "done"
        else:
            self.stage = "error"
            self.error = "Harman read the token but could not save it \u2014 try again."

    def _reader(self, proc):
        while True:
            chunk = proc.read(4096)
            with self.lock:
                if self.proc is not proc:
                    return  # superseded by a newer attempt
                if chunk:
                    if self.stage in ("done", "error"):
                        continue  # finished; drain until the CLI exits
                    self.screen.feed(chunk)
                    if not self.url:
                        url = _drawn_match(self.screen, _CLAUDE_URL_RE)
                        if url:
                            self.url = url.rstrip(".,)")
                            self.stage = "url"
                    # setup-token prints the long-lived token and then WAITS for a
                    # keypress — success must be detected from output, not exit.
                    tok = _drawn_match(self.screen, _TOKEN_RE)
                    if tok:
                        self._finish(tok)
                        try:
                            proc.write(b"\r")
                        except OSError:
                            pass
                        threading.Timer(3.0, self._kill_if_current, args=(proc,)).start()
                    else:
                        # Auto-acknowledge any "press enter to continue" prompts.
                        recent = self.screen.text(since=self.acked_seq).lower()
                        if "press enter" in recent or "press any key" in recent:
                            self.acked_seq = self.screen.seq
                            try:
                                proc.write(b"\r")
                            except OSError:
                                pass
                    continue
            # EOF: process exited
            code = proc.wait()
            with self.lock:
                if self.proc is not proc:
                    return
                if self.stage not in ("done", "error"):
                    tok = _drawn_match(self.screen, _TOKEN_RE, final=True)
                    if tok:
                        self._finish(tok)
                    else:
                        # A clean exit without a token is still a failed sign-in:
                        # nothing was saved, so the app would say "Not logged in".
                        self.stage = "error"
                        self.error = NO_TOKEN_ERROR if code == 0 else (
                            _redact(self.screen.text()[-500:].strip()) or f"Claude Code exited with code {code}.")
                self.proc = None
                proc.close()
                return

    def _save_token(self, token):
        """Write the token 0600; True once it is on disk."""
        try:
            # Create with 0600 from the start (open+O_CREAT with mode) so there's no
            # world-readable window between write_text and a later chmod.
            fd = os.open(str(VIEWER_TOKEN_FILE), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, token.encode("utf-8"))
            finally:
                os.close(fd)
            VIEWER_TOKEN_FILE.chmod(0o600)  # tighten if it pre-existed at a looser mode
            return True
        except Exception:
            return False

    def _kill_if_current(self, proc):
        with self.lock:
            if self.proc is proc:
                proc.kill()

    def submit_code(self, code):
        with self.lock:
            if not self.proc or self.stage not in ("url", "starting"):
                return False
            proc = self.proc
            try:
                self.code_seq = self.screen.seq
                proc.write(code.encode())
            except OSError:
                return False

        # The CLI's input widget treats text arriving in one chunk as a paste
        # and strips any trailing newline — Enter must arrive as its own
        # keystroke afterwards. Send it twice (the second is a no-op on an
        # empty re-prompt, and helps skip a "press enter" screen).
        def press_enter():
            for delay in (0.3, 1.2):
                time.sleep(delay)
                with self.lock:
                    if self.proc is not proc or self.stage in ("done", "error"):
                        return
                    try:
                        proc.write(b"\r")
                    except OSError:
                        return

        threading.Thread(target=press_enter, daemon=True).start()
        return True

    def cancel_locked(self):
        if self.proc:
            self.proc.kill()
            self.proc.close()
        self.proc = None

    def cancel(self):
        with self.lock:
            self.cancel_locked()
            self.stage = "idle"

    def poll(self):
        with self.lock:
            if self.stage in ("starting", "url") and time.time() - self.started > 600:
                self.cancel_locked()
                self.stage = "error"
                self.error = "Login timed out after 10 minutes"
            # Surface mid-flow errors (e.g. invalid code message) without ending
            # the flow — but only in output produced after the last code submit.
            note = ""
            if self.stage == "url" and self.code_seq:
                recent = self.screen.text(since=self.code_seq).lower()
                if any(p in recent for p in ("invalid", "error", "failed", "expired")):
                    note = "The code was rejected — copy it again and re-paste."
            tail = ""
            if self.stage in ("starting", "url"):
                tail = _redact(self.screen.text()[-600:])
            return {"stage": self.stage, "url": self.url, "error": self.error, "note": note, "tail": tail}


LOGIN = LoginManager()


def codex_bin():
    return find_agent_bin("codex") or "codex"


def _codex_logged_in():
    try:
        p = os.path.expanduser("~/.codex/auth.json")
        return os.path.exists(p) and os.path.getsize(p) > 2
    except Exception:
        return False


def _remote_login_pty(host, binpath):
    """`<cli> login` on a remote host under an SSH pty, as a _SshPty.

    Uses the user's INTERACTIVE login shell (-ilc): a version-managed node
    (nvm/fnm/...) is usually set up in the interactive rc (~/.zshrc), not the
    non-interactive one, and a plain `bash -lc` gets the wrong node."""
    with SSH.lock_for(host):
        chan = SSH.get(host)["client"].get_transport().open_session()
        chan.get_pty()
        shell = "exec " + shlex.quote(binpath) + " login"
        if "/" in binpath:
            shell = 'export PATH=' + shlex.quote(posixpath.dirname(binpath)) + ':"$PATH" && ' + shell
        chan.exec_command("${SHELL:-bash} -ilc " + shlex.quote(shell))
    return _SshPty(chan)


class CodexLoginManager:
    """Drives `codex login` on a pty (local) or an SSH channel's pty (remote) —
    one host at a time. Unlike Claude, codex runs a localhost:1455 callback
    server instead of reading a pasted code: we expose the OAuth URL and FORWARD
    the pasted callback URL to that server — directly here, or by a `curl` run on
    the remote (its :1455 binds the remote's loopback)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.host = "local"
        self.remote = False
        self.proc = None  # a ptyproc process, or _SshPty on a remote host
        self.buffer = ""
        self.url = None
        self.stage = "idle"  # idle | starting | url | done | error
        self.error = ""
        self.started = 0

    def _logged_in(self):
        return remote_codex_logged_in(self.host) if self.remote else _codex_logged_in()

    def start(self, host="local"):
        host = host or "local"
        with self.lock:
            if self.stage in ("starting", "url") and self.proc and self.host == host:
                return
            self.cancel_locked()
            self.reset()
            self.host, self.remote = host, host != "local"
            if self._logged_in():
                # Already signed in — `codex login` would wipe auth.json to begin
                # a fresh flow, so a cancelled re-run logs you out. Don't clobber.
                self.stage = "done"
                return
            self.stage = "starting"
            self.started = time.time()
            try:
                if self.remote:
                    self.proc = _remote_login_pty(host, remote_codex_bin(host))
                else:
                    missing = _missing_cli("Codex", codex_bin())
                    if missing:
                        self.stage, self.error = "error", missing
                        return
                    self.proc = _pty_spawn([codex_bin(), "login"])
            except Exception as e:
                self.stage, self.error = "error", str(e)
                return
            threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()

    def _reader(self, proc):
        while True:
            chunk = proc.read(4096)
            with self.lock:
                if self.proc is not proc:
                    return
                if chunk:
                    self.buffer += ANSI_RE.sub("", chunk.decode("utf-8", "replace"))
                    if not self.url:
                        m = re.search(r"https://auth\.openai\.com/\S*authorize\S+", self.buffer)
                        if m:
                            self.url = m.group(0).rstrip(".,)")
                            self.stage = "url"
                    if self.stage != "done" and self._logged_in():
                        self.stage = "done"
                    continue
            code = proc.wait()
            with self.lock:
                if self.proc is not proc:
                    return
                if self.stage == "done" or self._logged_in() or code == 0:
                    self.stage = "done"
                else:
                    self.stage = "error"
                    self.error = _redact(self.buffer[-500:].strip())
                self.proc = None
                proc.close()
                return

    def submit(self, callback_url):
        """Forward the pasted OAuth callback URL to codex's localhost:1455 server."""
        import urllib.request
        with self.lock:
            if self.stage not in ("url", "starting"):
                return False
            host, remote = self.host, self.remote
        try:
            u = urlparse((callback_url or "").strip())
            path = u.path or "/auth/callback"
            target = "http://localhost:1455" + path + (("?" + u.query) if u.query else "")
            if remote:
                remote_run_shell(host, "curl -s " + shlex.quote(target), timeout=20)
            else:
                urllib.request.urlopen(target, timeout=15).read()
        except Exception:
            pass  # codex may close/redirect the connection — auth.json below is the truth
        for _ in range(24):
            if self._logged_in():
                with self.lock:
                    self.stage = "done"
                return True
            time.sleep(0.5)
        return self._logged_in()

    def cancel_locked(self):
        if self.proc:
            # Kill the whole group (or hang up the SSH pty) so codex's :1455 server dies with it.
            self.proc.kill(group=True)
            self.proc.close()
        self.proc = None

    def cancel(self):
        with self.lock:
            self.cancel_locked()
            self.stage = "idle"

    def poll(self):
        with self.lock:
            if self.stage in ("starting", "url") and time.time() - self.started > 900:
                self.cancel_locked()
                self.stage = "error"
                self.error = "Login timed out"
            done = self._logged_in()
            return {"stage": "done" if done else self.stage, "url": self.url,
                    "error": self.error, "loggedIn": done}


CODEX_LOGIN = CodexLoginManager()


class McpLoginManager:
    """Signs the owner in to one OAuth MCP server (e.g. Microsoft 365) by
    driving `claude mcp login <name> --no-browser` through a pty, so the token
    lands in the same store every Claude Code session on this machine reads.

    The CLI listens on the server's localhost callback port: a browser on this
    Mac completes on its own; a phone's redirect fails to load, so the owner
    pastes that address and it is typed into the CLI's paste prompt. One
    sign-in at a time — it is a person at a keyboard."""

    URL_RE = re.compile(r"Visit this URL to authorize:\s*(https://\S+)")

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.proc = None
        self.buffer = ""
        self.url = None
        self.name = ""
        self.stage = "idle"  # idle | starting | url | done | error
        self.error = ""
        self.started = 0

    def start(self, name, cwd=None, plugin_dir=None, project_server=False):
        """name as `claude mcp list` shows it (plugin:chat:<n> for an extras
        folder, which plugin_dir loads). project_server pre-approves a
        project .mcp.json entry, which the CLI otherwise refuses to sign in."""
        argv = [claude_bin()]
        if plugin_dir:
            argv += ["--plugin-dir", str(plugin_dir)]
        if project_server:
            argv += ["--settings", json.dumps({"enabledMcpjsonServers": [name]})]
        argv += ["mcp", "login", name, "--no-browser"]
        with self.lock:
            if self.stage in ("starting", "url") and self.proc and self.name == name:
                return
            self.cancel_locked()
            self.reset()
            self.name, self.stage, self.started = name, "starting", time.time()
            missing = _missing_cli("Claude Code", argv[0])
            if missing:
                self.stage, self.error = "error", missing
                return
            self.proc = _pty_spawn(argv, cols=4000, cwd=cwd)
            threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()

    def _reader(self, proc):
        while True:
            chunk = proc.read(4096)
            with self.lock:
                if self.proc is not proc:
                    return
                if chunk:
                    self.buffer += ANSI_RE.sub("", chunk.decode("utf-8", "replace"))
                    m = not self.url and self.URL_RE.search(self.buffer)
                    if m:
                        self.url, self.stage = m.group(1), "url"
                    continue
            code = proc.wait()
            with self.lock:
                if self.proc is not proc:
                    return
                if code == 0:
                    self.stage = "done"
                else:
                    self.stage = "error"
                    # Drop the authorize URL and any pasted code: neither belongs on a screen.
                    tail = re.sub(r"https://\S+", "", self.buffer[-500:]).strip()
                    self.error = tail.splitlines()[-1] if tail else "Sign-in failed."
                self.proc = None
                proc.close()
                return

    def submit(self, redirect_url):
        """Type the pasted redirect address into the CLI's paste prompt. Enter
        goes as its own keystroke: a one-chunk write reads as a paste and loses
        its newline (same as LoginManager.submit_code)."""
        u = urlparse((redirect_url or "").strip())
        if u.scheme not in ("http", "https") or "code=" not in u.query:
            return False
        with self.lock:
            if not self.proc or self.stage != "url":
                return False
            proc = self.proc
            try:
                proc.write(redirect_url.strip().encode())
            except OSError:
                return False
        time.sleep(0.3)
        with self.lock:
            if self.proc is proc:
                try:
                    proc.write(b"\r")
                except OSError:
                    pass
        return True

    def cancel_locked(self):
        if self.proc:
            # Kill the group so the CLI's localhost callback listener dies with it.
            self.proc.kill(group=True)
            self.proc.close()
        self.proc = None

    def cancel(self):
        with self.lock:
            self.cancel_locked()
            self.stage = "idle"

    def poll(self):
        with self.lock:
            if self.stage in ("starting", "url") and time.time() - self.started > 900:
                self.cancel_locked()
                self.stage, self.error = "error", "Sign-in timed out after 15 minutes."
            return {"name": self.name, "stage": self.stage, "url": self.url, "error": self.error}


MCP_LOGIN = McpLoginManager()




def copilot_bin():
    return find_agent_bin("copilot") or "copilot"


def _copilot_logged_in():
    """True if Copilot has a stored login on this machine (~/.copilot/config.json
    has loggedInUsers/copilotTokens). That file has // comments, so strip them."""
    try:
        txt = open(os.path.expanduser("~/.copilot/config.json"), errors="replace").read()
        txt = re.sub(r"^\s*//.*$", "", txt, flags=re.M)
        d = json.loads(txt) if txt.strip() else {}
        return bool(d.get("loggedInUsers") or d.get("copilotTokens"))
    except Exception:
        return False


class CopilotLoginManager:
    """Drives `copilot login` (GitHub OAuth **device flow**) on a pty (local) or
    an SSH channel's pty (remote, through _SshPty) — one host at a time. Unlike Codex there's no localhost
    callback and no paste-back: we capture the device URL + user code, the CLI polls
    GitHub itself, and we complete when it reports success. We also auto-answer the
    plaintext-token '(y/N)' prompt (shown when there's no OS keychain, e.g. over SSH)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.host = "local"
        self.remote = False
        self.proc = None  # a ptyproc process, or _SshPty on a remote host
        self.buffer = ""
        self.url = None
        self.code = None
        self.keyed = False
        self.stage = "idle"  # idle | starting | url | done | error
        self.error = ""
        self.started = 0

    def _logged_in(self):
        return remote_copilot_logged_in(self.host) if self.remote else _copilot_logged_in()

    def _write(self, s):
        try:
            if self.proc is not None:
                self.proc.write(s.encode())
        except Exception:
            pass

    def start(self, host="local"):
        with self.lock:
            self.cancel_locked()
            self.reset()
            self.host = host or "local"
            self.remote = self.host != "local"
            if self._logged_in():          # already signed in — nothing to do
                self.stage = "done"
                return
            self.stage = "starting"
            self.started = time.time()
            try:
                if self.remote:
                    self.proc = _remote_login_pty(self.host, remote_copilot_bin(self.host))
                else:
                    missing = _missing_cli("GitHub Copilot CLI", copilot_bin())
                    if missing:
                        self.stage, self.error = "error", missing
                        return
                    self.proc = _pty_spawn([copilot_bin(), "login"])
                threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()
            except Exception as e:
                self.stage = "error"
                self.error = str(e)

    def _absorb(self, text):
        """Parse new output (call under lock)."""
        self.buffer += ANSI_RE.sub("", text)
        if not self.url:
            m = re.search(r"https://github\.com/login/device\S*", self.buffer)
            if m:
                self.url = m.group(0).rstrip(".,)")
        if not self.code:
            m = re.search(r"\b([A-Z0-9]{4}-[A-Z0-9]{4})\b", self.buffer)
            if m:
                self.code = m.group(1)
        if (self.url or self.code) and self.stage == "starting":
            self.stage = "url"
        if not self.keyed and re.search(r"\(y/N\)|plaintext", self.buffer, re.I):
            self.keyed = True
            self._write("y\n")     # store the token when there's no OS keychain
        if (self._logged_in() or "Signed in successfully" in self.buffer) and self.stage != "done":
            self.stage = "done"

    def _reader(self, proc):
        while True:
            chunk = proc.read(4096)
            with self.lock:
                if self.proc is not proc:
                    return
                if chunk:
                    self._absorb(chunk.decode("utf-8", "replace"))
                    continue
            code = proc.wait()
            with self.lock:
                if self.proc is not proc:
                    return
                self.stage = "done" if (self.stage == "done" or self._logged_in() or code == 0) else "error"
                if self.stage == "error":
                    self.error = self.buffer[-400:].strip()
                self.proc = None
                proc.close()
                return

    def cancel_locked(self):
        if self.proc:
            self.proc.kill(group=True)
            self.proc.close()
        self.proc = None

    def cancel(self):
        with self.lock:
            self.cancel_locked()
            self.stage = "idle"

    def poll(self):
        with self.lock:
            if self.stage in ("starting", "url") and time.time() - self.started > 900:
                self.cancel_locked()
                self.stage = "error"
                self.error = "Login timed out"
            done = self._logged_in()
            return {"stage": "done" if done else self.stage, "url": self.url,
                    "code": self.code, "error": self.error, "loggedIn": done}


COPILOT_LOGIN = CopilotLoginManager()
