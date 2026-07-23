"""viewer.routes.auth — AuthMixin route + business methods."""
import json
import os
import subprocess
import threading
import time
import uuid as uuid_mod
from collections import deque
from pathlib import Path
from viewer import db, hostenv
from viewer.config import (
    HOSTS, HOSTS_FILE, HOSTS_LOCK,
)
from viewer.agents import ENABLED_AGENTS, agent_public, get_agent, install_command, is_installed_local, local_agents_status
from viewer.engine import (
    save_json_file,
)
from viewer.login import (
    CODEX_LOGIN, COPILOT_LOGIN, LOGIN, REMOTE_CODEX_LOGIN, _codex_logged_in, _copilot_logged_in, auth_status,
)
from viewer.remote import (
    SSH, remote_agents_status, remote_codex_logged_in, remote_install_agent, save_browser_mcp_all, test_host_config,
)


# --- Per-IP sign-in throttle -------------------------------------------------
# Lenient by design: a real user logs in once; only a hammering script trips it.
# Keyed on the raw socket peer IP, NOT X-Forwarded-For (a client can spoof that
# to mint unlimited buckets and dodge the limit). Sliding 60s window.
_LOGIN_WINDOW = 60   # seconds
_LOGIN_MAX = 20      # attempts per window per IP
_login_hits = {}     # ip -> deque[timestamps]
_login_lock = threading.Lock()


def _login_over_limit(ip):
    """Record a sign-in attempt from `ip`; return True if it should be rejected
    (more than _LOGIN_MAX attempts in the last _LOGIN_WINDOW seconds)."""
    now = time.time()
    cutoff = now - _LOGIN_WINDOW
    with _login_lock:
        # Cheap safeguard so a flood of distinct IPs can't grow the map unbounded.
        if len(_login_hits) > 4096:
            for k in [k for k, v in _login_hits.items() if not v or v[-1] < cutoff]:
                del _login_hits[k]
        dq = _login_hits.get(ip)
        if dq is None:
            dq = _login_hits[ip] = deque()
        while dq and dq[0] < cutoff:
            dq.popleft()
        if len(dq) >= _LOGIN_MAX:
            return True   # don't record — let the window drain so the IP recovers
        dq.append(now)
        return False


class AuthMixin:
    def _p_agents_mcp_browser(self, req):
        """Register the browser (playwright) MCP into every installed agent's config."""
        body = self.read_body() or {}
        config = body.get("config")
        if not isinstance(config, dict) or not config.get("command"):
            self.send_json({"error": "Missing MCP config"}, status=400)
            return
        if body.get("host", "local") != "local":
            self.send_json({"error": "Only supported on this machine for now"}, status=501)
            return
        try:
            self.send_json(save_browser_mcp_all(config, body.get("name") or "playwright"))
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    def _p_hosts_test(self, req):
        body = self.read_body() or {}
        ok, msg = test_host_config(body)
        self.send_json({"ok": ok, "message": msg})

    def _p_agents_install(self, req):
        """Install an agent CLI into $HOME/.local (no sudo). Synchronous; the
        frontend shows a spinner while npm runs, then re-detects."""
        body = self.read_body() or {}
        agent_id = body.get("agent", "")
        host = body.get("host", "local")
        a = get_agent(agent_id)
        if a["id"] != agent_id or agent_id == "claude":
            self.send_json({"error": "Unknown or non-installable agent"}, status=400)
            return
        if host != "local":
            try:
                self.send_json(remote_install_agent(host, a))
            except Exception as e:
                self.send_json({"error": f"SSH: {e}"}, status=502)
            return
        try:
            home = str(Path.home())
            env = dict(os.environ)
            env["PATH"] = f"{home}/.local/bin:/usr/local/bin:/usr/bin:" + env.get("PATH", "")
            proc = subprocess.run(install_command(a, home), shell=True, capture_output=True,
                                  text=True, timeout=400, env=env)
            out = ((proc.stdout or "") + (proc.stderr or ""))[-6000:]
            self.send_json({"ok": proc.returncode == 0, "returncode": proc.returncode,
                            "output": out, "installed": is_installed_local(a)})
        except subprocess.TimeoutExpired:
            self.send_json({"error": "Install timed out", "output": ""}, status=504)
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    def _g_auth_status(self, req):
        self.send_json(auth_status())

    # ----- User accounts (viewer.db): sign up / in / out + prefs -----
    def _g_auth_me(self, req):
        self.send_json({"user": self.current_user()})

    def _g_auth_state(self, req):
        """Drives the landing: first run (no users) shows signup, else signin."""
        self.send_json({"signupOpen": db.user_count() == 0, "user": self.current_user()})

    def _p_auth_signup(self, req):
        if db.user_count() > 0:
            self.send_json({"error": "Signup is closed on this instance"}, status=403)
            return
        body = self.read_body() or {}
        try:
            user = db.create_user(body.get("username", ""), body.get("password", ""))
        except ValueError as e:
            self.send_json({"error": str(e)}, status=400)
            return
        self.set_session_cookie(db.create_session(user["id"]))
        self.send_json({"user": user})

    def _p_auth_signin(self, req):
        ip = self.client_address[0] if self.client_address else "?"
        if _login_over_limit(ip):
            self.send_json({"error": "Too many sign-in attempts — wait a minute and try again."},
                           status=429)
            return
        body = self.read_body() or {}
        user = db.verify_user(body.get("username", ""), body.get("password", ""))
        if not user:
            self.send_json({"error": "Wrong username or password"}, status=401)
            return
        self.set_session_cookie(db.create_session(user["id"]))
        self.send_json({"user": user})

    def _p_auth_signout(self, req):
        db.delete_session(self._cookie(db.SESSION_COOKIE))
        self.set_session_cookie(None)  # clear the cookie
        self.send_json({"ok": True})

    def _g_prefs(self, req):
        u = self.current_user()
        self.send_json(db.get_prefs(u["id"]) if u and u.get("id") else {})

    def _p_prefs(self, req):
        u = self.current_user()
        if u and u.get("id"):
            db.set_prefs(u["id"], self.read_body() or {})
        self.send_json({"ok": True})

    def _p_agent_login_submit(self, req):
        body = self.read_body() or {}
        host = body.get("host", "local")
        if body.get("agent") != "codex":
            self.send_json({"error": "unsupported"}, status=400)
            return
        cb = (body.get("callback") or "").strip()
        if not cb:
            self.send_json({"error": "Paste the callback URL from the browser"}, status=400)
            return
        if host == "local":
            ok = CODEX_LOGIN.submit(cb)
            self.send_json({"ok": ok, "loggedIn": _codex_logged_in()})
        else:
            ok = REMOTE_CODEX_LOGIN.submit(cb)
            self.send_json({"ok": ok, "loggedIn": remote_codex_logged_in(host)})

    def _p_agent_login_cancel(self, req):
        body = self.read_body() or {}
        if body.get("agent") == "copilot":
            COPILOT_LOGIN.cancel()
        elif body.get("host", "local") == "local":
            CODEX_LOGIN.cancel()
        else:
            REMOTE_CODEX_LOGIN.cancel()
        self.send_json({"cancelled": True})

    def _g_hosts(self, req):
        # auth + keyFile (a path, not a secret) let the edit modal prefill; the
        # password/passphrase are never sent to the client. Snapshot under the
        # lock so a concurrent save/delete can't 500 the iteration.
        with HOSTS_LOCK:
            items = list(HOSTS.items())
        self.send_json([{"id": hid, "label": c.get("label", hid), "host": c["host"],
                         "user": c["user"], "port": c.get("port", 22),
                         "auth": "key" if c.get("keyFile") else "password",
                         "keyFile": c.get("keyFile", "")}
                        for hid, c in items])

    def _p_auth_login_start(self, req):
        LOGIN.start()
        self.send_json(LOGIN.poll())

    def _p_auth_login_cancel(self, req):
        LOGIN.cancel()
        self.send_json({"cancelled": True})

    def _g_agent_login_poll(self, req):
        agent = (req.query.get("agent") or [""])[0]
        if agent == "copilot":
            self.send_json(COPILOT_LOGIN.poll())
            return
        if agent != "codex":
            self.send_json({"stage": "idle"})
            return
        self.send_json(CODEX_LOGIN.poll() if req.host == "local" else REMOTE_CODEX_LOGIN.poll())

    def _p_hosts_save(self, req):
        body = self.read_body() or {}
        for f in ("label", "host", "user"):
            if not (body.get(f) or "").strip():
                self.send_json({"error": f"{f} is required"}, status=400)
                return
        hid = body.get("id") or uuid_mod.uuid4().hex[:12]
        prev = HOSTS.get(hid, {})
        editing = bool(body.get("id"))
        method = body.get("authMethod") or ("key" if body.get("keyFile") else "password")
        # Store exactly ONE auth method (password | key | agent-default). A blank
        # secret on an edit keeps the saved one (the modal says "leave blank").
        entry = {"label": body["label"].strip(), "host": body["host"].strip(),
                 "user": body["user"].strip(), "port": int(body.get("port") or 22),
                 "claudeHome": (body.get("claudeHome") or prev.get("claudeHome") or ".claude").strip(),
                 "password": "", "keyFile": "", "keyPassphrase": ""}
        if method == "key":
            entry["keyFile"] = (body.get("keyFile") or "").strip()
            kp = body.get("keyPassphrase", "")
            entry["keyPassphrase"] = kp or (prev.get("keyPassphrase", "") if editing else "")
        else:
            pw = body.get("password", "")
            entry["password"] = pw or (prev.get("password", "") if editing else "")
        with HOSTS_LOCK:
            HOSTS[hid] = entry
            save_json_file(HOSTS_FILE, HOSTS)
        try:
            os.chmod(HOSTS_FILE, 0o600)
        except OSError:
            pass
        self.send_json({"saved": hid})

    def _p_auth_login_code(self, req):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            code = (body.get("code") or "").strip()
        except Exception:
            code = ""
        if not code:
            self.send_json({"error": "Empty code"}, status=400)
            return
        ok = LOGIN.submit_code(code)
        self.send_json({"submitted": ok} if ok else {"error": "No login in progress"},
                       status=200 if ok else 409)

    def _p_agent_login_start(self, req):
        body = self.read_body() or {}
        host = body.get("host", "local")
        agent = body.get("agent")
        if agent == "copilot":
            COPILOT_LOGIN.start(host)
            self.send_json(COPILOT_LOGIN.poll())
            return
        if agent != "codex":
            self.send_json({"error": "In-app login isn't available for this agent yet"}, status=400)
            return
        if host == "local":
            CODEX_LOGIN.start()
            self.send_json(CODEX_LOGIN.poll())
        else:
            REMOTE_CODEX_LOGIN.start(host)
            self.send_json(REMOTE_CODEX_LOGIN.poll())

    def _g_agents(self, req):
        if req.host != "local":
            try:
                self.send_json({"agents": remote_agents_status(req.host)})
            except Exception as e:
                self.send_json({"agents": [agent_public(a, False) for a in ENABLED_AGENTS], "warning": f"SSH: {e}"})
            return
        ags = local_agents_status()
        for a in ags:
            if a["id"] == "claude":
                a["loggedIn"] = bool(auth_status().get("loggedIn"))
            elif a["id"] == "codex":
                a["loggedIn"] = _codex_logged_in()
            elif a["id"] == "copilot":
                a["loggedIn"] = _copilot_logged_in()
            else:
                a["loggedIn"] = True  # pi authenticates via models.json, not a checkable flag
        self.send_json({"agents": ags})

    def _p_hosts_delete(self, req):
        body = self.read_body() or {}
        hid = body.get("id")
        SSH.close(hid)
        with HOSTS_LOCK:
            removed = HOSTS.pop(hid, None) is not None
            if removed:
                save_json_file(HOSTS_FILE, HOSTS)
        hostenv.unset_host(hid)   # drop this host's env vars too
        self.send_json({"deleted": True})

    # ----- Per-host environment variables (viewer/hostenv.py) -----
    # Secrets: the list returns KEYS only; values come from the reveal endpoint.
    def _g_env(self, req):
        self.send_json({"host": req.host, "keys": hostenv.list_keys(req.host)})

    def _g_env_value(self, req):
        key = (req.query.get("key") or [""])[0]
        val = hostenv.get_value(req.host, key)
        if val is None:
            self.send_json({"error": "No such variable"}, status=404)
            return
        self.send_json({"key": key, "value": val})

    def _p_env_set(self, req):
        body = self.read_body() or {}
        hid = body.get("host") or "local"
        if not body.get("value"):
            self.send_json({"error": "Value can't be empty"}, status=400)
            return
        try:
            hostenv.set_var(hid, body.get("key"), body["value"])
        except ValueError as e:
            self.send_json({"error": str(e)}, status=400)
            return
        self.send_json({"saved": True, "keys": hostenv.list_keys(hid)})

    def _p_env_unset(self, req):
        body = self.read_body() or {}
        hid = body.get("host") or "local"
        hostenv.unset_var(hid, (body.get("key") or "").strip())
        self.send_json({"unset": True, "keys": hostenv.list_keys(hid)})

    def _g_auth_login_poll(self, req):
        self.send_json(LOGIN.poll())

