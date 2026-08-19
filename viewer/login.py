"""viewer.login — Claude & Codex OAuth login managers and auth status."""
import fcntl
import json
import os
import posixpath
import pty
import re
import shlex
import shutil
import signal
import struct
import termios
import threading
import time
from urllib.parse import urlparse
from viewer.config import (
    ANSI_RE, CREDENTIALS_FILE, VIEWER_TOKEN_FILE, claude_bin,
)
from viewer.remote import (
    SSH, remote_codex_bin, remote_codex_logged_in, remote_copilot_bin, remote_copilot_logged_in, remote_run_shell,
)


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


class LoginManager:
    """Drives `claude setup-token` through a pty: exposes the OAuth URL,
    forwards the pasted code, and reports completion."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.pid = None
        self.fd = None
        self.buffer = ""
        self.url = None
        self.stage = "idle"   # idle | starting | url | done | error
        self.error = ""
        self.started = 0
        self.code_pos = 0     # buffer offset of the last submitted code
        self.acked_pos = 0    # buffer offset up to which "press enter" was answered

    def start(self):
        with self.lock:
            if self.stage in ("starting", "url") and self.pid:
                return  # already in progress; frontend will pick up the URL
            self.cancel_locked()
            self.reset()
            self.stage = "starting"
            self.started = time.time()
            pid, fd = pty.fork()
            if pid == 0:
                os.execvp(claude_bin(), [claude_bin(), "setup-token"])
            # Wide terminal so the URL is not hard-wrapped by the pty.
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 2000, 0, 0))
            self.pid, self.fd = pid, fd
            threading.Thread(target=self._reader, args=(pid, fd), daemon=True).start()

    def _reader(self, pid, fd):
        while True:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                chunk = b""
            with self.lock:
                if self.pid != pid:
                    return  # superseded by a newer attempt
                if chunk:
                    self.buffer += ANSI_RE.sub("", chunk.decode("utf-8", "replace"))
                    if not self.url:
                        m = re.search(r"https://claude\.(?:com|ai)/\S*oauth\S+", self.buffer)
                        if m and (m.end() < len(self.buffer) or "state=" in m.group(0)):
                            self.url = m.group(0).rstrip(".,)")
                            self.stage = "url"
                    # setup-token prints the long-lived token and then WAITS for a
                    # keypress — success must be detected from output, not exit.
                    tok = re.search(r"sk-ant-oat[0-9A-Za-z_-]{20,}", self.buffer)
                    if tok and self.stage != "done":
                        self._save_token(tok.group(0))
                        self.stage = "done"
                        try:
                            os.write(fd, b"\r")
                        except OSError:
                            pass
                        threading.Timer(3.0, self._kill_if_current, args=(pid,)).start()
                    elif self.stage != "done":
                        # Auto-acknowledge any "press enter to continue" prompts.
                        recent = self.buffer[self.acked_pos:].lower()
                        if "press enter" in recent or "press any key" in recent:
                            self.acked_pos = len(self.buffer)
                            try:
                                os.write(fd, b"\r")
                            except OSError:
                                pass
                    continue
            # EOF: process exited
            try:
                _, status = os.waitpid(pid, 0)
            except ChildProcessError:
                status = 0
            with self.lock:
                if self.pid != pid:
                    return
                code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status
                token_m = re.search(r"sk-ant-oat[0-9A-Za-z_-]{20,}", self.buffer)
                if token_m:
                    self._save_token(token_m.group(0))
                if self.stage == "done" or code == 0 or token_m:
                    self.stage = "done"
                else:
                    self.stage = "error"
                    self.error = _redact(self.buffer[-500:].strip())
                self.pid = None
                try:
                    os.close(fd)
                except OSError:
                    pass
                self.fd = None
                return

    def _save_token(self, token):
        try:
            # Create with 0600 from the start (open+O_CREAT with mode) so there's no
            # world-readable window between write_text and a later chmod.
            fd = os.open(str(VIEWER_TOKEN_FILE), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, token.encode("utf-8"))
            finally:
                os.close(fd)
            VIEWER_TOKEN_FILE.chmod(0o600)  # tighten if it pre-existed at a looser mode
        except Exception:
            pass

    def _kill_if_current(self, pid):
        with self.lock:
            if self.pid == pid:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def submit_code(self, code):
        with self.lock:
            if not self.fd or self.stage not in ("url", "starting"):
                return False
            fd = self.fd
            try:
                self.code_pos = len(self.buffer)
                os.write(fd, code.encode())
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
                    if self.fd != fd or self.stage == "done":
                        return
                    try:
                        os.write(fd, b"\r")
                    except OSError:
                        return

        threading.Thread(target=press_enter, daemon=True).start()
        return True

    def cancel_locked(self):
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
        self.pid = None
        self.fd = None

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
            if self.stage == "url" and self.code_pos:
                recent = self.buffer[self.code_pos:].lower()
                if any(p in recent for p in ("invalid", "error", "failed", "expired")):
                    note = "The code was rejected — copy it again and re-paste."
            tail = ""
            if self.stage in ("starting", "url"):
                tail = re.sub(r"sk-ant-oat[0-9A-Za-z_-]+", "<token>", self.buffer[-600:])
            return {"stage": self.stage, "url": self.url, "error": self.error, "note": note, "tail": tail}


LOGIN = LoginManager()


def codex_bin():
    return shutil.which("codex") or os.path.expanduser("~/.local/bin/codex")


def _codex_logged_in():
    try:
        p = os.path.expanduser("~/.codex/auth.json")
        return os.path.exists(p) and os.path.getsize(p) > 2
    except Exception:
        return False


class CodexLoginManager:
    """Drives `codex login` through a pty (like the Claude flow, but codex runs
    a localhost:1455 callback server instead of reading a pasted code): exposes
    the OAuth URL, and FORWARDS the pasted callback URL to codex's local server
    to complete sign-in. Local only for now."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.pid = None
        self.fd = None
        self.buffer = ""
        self.url = None
        self.stage = "idle"  # idle | starting | url | done | error
        self.error = ""
        self.started = 0

    def start(self):
        with self.lock:
            if self.stage in ("starting", "url") and self.pid:
                return
            if _codex_logged_in():
                # Already signed in — `codex login` would wipe auth.json to begin
                # a fresh flow, so a cancelled re-run logs you out. Don't clobber.
                self.reset()
                self.stage = "done"
                return
            self.cancel_locked()
            self.reset()
            self.stage = "starting"
            self.started = time.time()
            pid, fd = pty.fork()
            if pid == 0:
                os.execvp(codex_bin(), [codex_bin(), "login"])
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 2000, 0, 0))
            self.pid, self.fd = pid, fd
            threading.Thread(target=self._reader, args=(pid, fd), daemon=True).start()

    def _reader(self, pid, fd):
        while True:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                chunk = b""
            with self.lock:
                if self.pid != pid:
                    return
                if chunk:
                    self.buffer += ANSI_RE.sub("", chunk.decode("utf-8", "replace"))
                    if not self.url:
                        m = re.search(r"https://auth\.openai\.com/\S*authorize\S+", self.buffer)
                        if m:
                            self.url = m.group(0).rstrip(".,)")
                            self.stage = "url"
                    if _codex_logged_in() and self.stage != "done":
                        self.stage = "done"
                    continue
            try:
                _, status = os.waitpid(pid, 0)
            except ChildProcessError:
                status = 0
            with self.lock:
                if self.pid != pid:
                    return
                code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status
                if self.stage == "done" or _codex_logged_in() or code == 0:
                    self.stage = "done"
                else:
                    self.stage = "error"
                    self.error = _redact(self.buffer[-500:].strip())
                self.pid = None
                try:
                    os.close(fd)
                except OSError:
                    pass
                self.fd = None
                return

    def submit(self, callback_url):
        """Forward the pasted OAuth callback URL to codex's localhost:1455 server."""
        import urllib.request
        with self.lock:
            if self.stage not in ("url", "starting"):
                return False
        try:
            u = urlparse((callback_url or "").strip())
            path = u.path or "/auth/callback"
            target = "http://localhost:1455" + path + (("?" + u.query) if u.query else "")
            try:
                urllib.request.urlopen(target, timeout=15).read()
            except Exception:
                pass  # codex may close/redirect the connection — that's fine
        except Exception:
            return False
        for _ in range(24):
            if _codex_logged_in():
                with self.lock:
                    self.stage = "done"
                return True
            time.sleep(0.5)
        return _codex_logged_in()

    def cancel_locked(self):
        if self.pid:
            # pty.fork makes the child a session leader — kill the whole group so
            # codex's localhost:1455 callback server dies with it.
            try:
                os.killpg(os.getpgid(self.pid), signal.SIGKILL)
            except Exception:
                try:
                    os.kill(self.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
        self.pid = None
        self.fd = None

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
            return {"stage": "done" if _codex_logged_in() else self.stage, "url": self.url,
                    "error": self.error, "loggedIn": _codex_logged_in()}


CODEX_LOGIN = CodexLoginManager()


class RemoteCodexLoginManager:
    """`codex login` on a REMOTE host over SSH. Same OAuth-URL + paste-callback
    UX as the local flow, but: the process runs on the remote via an SSH pty
    (its localhost:1455 callback server binds the remote's loopback), and the
    pasted callback is forwarded by a `curl` executed ON the remote. One host at
    a time (a single sign-in in flight is all the UI drives)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.host = None
        self.chan = None
        self.buffer = ""
        self.url = None
        self.stage = "idle"  # idle | starting | url | done | error
        self.error = ""
        self.started = 0

    def _logged_in(self):
        return remote_codex_logged_in(self.host) if self.host else False

    def start(self, host):
        with self.lock:
            if remote_codex_logged_in(host):
                # Already signed in on the remote — don't run `codex login` (it
                # wipes auth.json to begin fresh; a cancelled re-run logs you out).
                self.reset()
                self.host = host
                self.stage = "done"
                return
            self.cancel_locked()
            self.reset()
            self.host = host
            self.stage = "starting"
            self.started = time.time()
            try:
                binpath = remote_codex_bin(host)
                with SSH.lock_for(host):
                    chan = SSH.get(host)["client"].get_transport().open_session()
                    chan.get_pty()
                    shell = "exec " + shlex.quote(binpath) + " login"
                    if "/" in binpath:
                        shell = 'export PATH=' + shlex.quote(posixpath.dirname(binpath)) + ':"$PATH" && ' + shell
                    chan.exec_command("bash -lc " + shlex.quote(shell))
                self.chan = chan
            except Exception as e:
                self.stage = "error"
                self.error = str(e)
                return
            threading.Thread(target=self._reader, args=(chan,), daemon=True).start()

    def _reader(self, chan):
        while True:
            try:
                chunk = chan.recv(4096)
            except Exception:
                chunk = b""
            with self.lock:
                if self.chan is not chan:
                    return
                if chunk:
                    self.buffer += ANSI_RE.sub("", chunk.decode("utf-8", "replace"))
                    if not self.url:
                        m = re.search(r"https://auth\.openai\.com/\S*authorize\S+", self.buffer)
                        if m:
                            self.url = m.group(0).rstrip(".,)")
                            self.stage = "url"
                    if self._logged_in() and self.stage != "done":
                        self.stage = "done"
                    continue
            # EOF: the codex process exited.
            with self.lock:
                if self.chan is not chan:
                    return
                try:
                    code = chan.recv_exit_status()
                except Exception:
                    code = 0
                if self.stage == "done" or self._logged_in() or code == 0:
                    self.stage = "done"
                else:
                    self.stage = "error"
                    self.error = _redact(self.buffer[-500:].strip())
                self.chan = None
                return

    def submit(self, callback_url):
        """Forward the pasted callback to the remote's localhost:1455 via SSH curl."""
        with self.lock:
            if self.stage not in ("url", "starting") or not self.host:
                return False
            host = self.host
        try:
            u = urlparse((callback_url or "").strip())
            path = u.path or "/auth/callback"
            target = "http://localhost:1455" + path + (("?" + u.query) if u.query else "")
            remote_run_shell(host, "curl -s " + shlex.quote(target), timeout=20)
        except Exception:
            pass  # codex may close/redirect — the auth.json check below is the truth
        for _ in range(24):
            if remote_codex_logged_in(host):
                with self.lock:
                    self.stage = "done"
                return True
            time.sleep(0.5)
        return remote_codex_logged_in(host)

    def cancel_locked(self):
        if self.chan is not None:
            try:
                self.chan.close()  # closes the SSH channel → SIGHUP kills codex + its :1455 server
            except Exception:
                pass
        self.chan = None

    def cancel(self):
        with self.lock:
            self.cancel_locked()
            self.stage = "idle"

    def poll(self):
        with self.lock:
            li = self._logged_in()
            if self.stage in ("starting", "url") and time.time() - self.started > 900:
                self.cancel_locked()
                self.stage = "error"
                self.error = "Login timed out"
            return {"stage": "done" if li else self.stage, "url": self.url,
                    "error": self.error, "loggedIn": li}


REMOTE_CODEX_LOGIN = RemoteCodexLoginManager()


def copilot_bin():
    return shutil.which("copilot") or os.path.expanduser("~/.local/bin/copilot")


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
    """Drives `copilot login` (GitHub OAuth **device flow**) via a pty (local) or
    an SSH channel (remote) — one host at a time. Unlike Codex there's no localhost
    callback and no paste-back: we capture the device URL + user code, the CLI polls
    GitHub itself, and we complete when it reports success. We also auto-answer the
    plaintext-token '(y/N)' prompt (shown when there's no OS keychain, e.g. over SSH).
    Remote runs under a login shell so it gets the right node (a non-login shell may
    have an unsupported node)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.host = "local"
        self.remote = False
        self.pid = None
        self.fd = None
        self.chan = None
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
            if self.remote and self.chan is not None:
                self.chan.sendall(s.encode())
            elif self.fd is not None:
                os.write(self.fd, s.encode())
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
                    binpath = remote_copilot_bin(self.host)
                    with SSH.lock_for(self.host):
                        chan = SSH.get(self.host)["client"].get_transport().open_session()
                        chan.get_pty()
                        shell = "exec " + shlex.quote(binpath) + " login"
                        if "/" in binpath:
                            shell = 'export PATH=' + shlex.quote(posixpath.dirname(binpath)) + ':"$PATH" && ' + shell
                        # Use the user's INTERACTIVE login shell (-ilc): a version-managed
                        # node (nvm/fnm/…) is usually set up in the interactive rc (~/.zshrc),
                        # not the non-interactive one — a plain `bash -lc` gets the wrong node
                        # and Copilot fails with "no platform package found".
                        chan.exec_command("${SHELL:-bash} -ilc " + shlex.quote(shell))
                    self.chan = chan
                    threading.Thread(target=self._reader_remote, args=(chan,), daemon=True).start()
                else:
                    pid, fd = pty.fork()
                    if pid == 0:
                        os.execvp(copilot_bin(), [copilot_bin(), "login"])
                    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 2000, 0, 0))
                    self.pid, self.fd = pid, fd
                    threading.Thread(target=self._reader_local, args=(pid, fd), daemon=True).start()
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

    def _reader_local(self, pid, fd):
        while True:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                chunk = b""
            with self.lock:
                if self.pid != pid:
                    return
                if chunk:
                    self._absorb(chunk.decode("utf-8", "replace"))
                    continue
            try:
                _, status = os.waitpid(pid, 0)
            except ChildProcessError:
                status = 0
            with self.lock:
                if self.pid != pid:
                    return
                code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status
                self.stage = "done" if (self.stage == "done" or self._logged_in() or code == 0) else "error"
                if self.stage == "error":
                    self.error = self.buffer[-400:].strip()
                self.pid = None
                try:
                    os.close(fd)
                except OSError:
                    pass
                self.fd = None
                return

    def _reader_remote(self, chan):
        while True:
            try:
                chunk = chan.recv(4096)
            except Exception:
                chunk = b""
            with self.lock:
                if self.chan is not chan:
                    return
                if chunk:
                    self._absorb(chunk.decode("utf-8", "replace"))
                    continue
            with self.lock:
                if self.chan is not chan:
                    return
                try:
                    code = chan.recv_exit_status()
                except Exception:
                    code = 0
                self.stage = "done" if (self.stage == "done" or self._logged_in() or code == 0) else "error"
                if self.stage == "error":
                    self.error = self.buffer[-400:].strip()
                self.chan = None
                return

    def cancel_locked(self):
        if self.pid:
            try:
                os.killpg(os.getpgid(self.pid), signal.SIGKILL)
            except Exception:
                try:
                    os.kill(self.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
        if self.chan is not None:
            try:
                self.chan.close()
            except Exception:
                pass
        self.pid = self.fd = self.chan = None

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
