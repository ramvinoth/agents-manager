#!/usr/bin/env python3
"""
Agents - Server
Serves the frontend and provides API access to session JSONL files.
Accessible over Tailscale.

APIs:
  GET  /api/sessions                      - list sessions
  GET  /api/default                       - default session path
  GET  /api/session/<path>                - full raw file (legacy)
  GET  /api/session/<path>?tail=N         - last N lines + byte offsets
  GET  /api/session/<path>?before=B&lines=N - N lines ending at byte offset B
  GET  /api/session/<path>?from=B         - new complete lines after offset B (poll)
  POST /api/chat {path, message, mode}    - send a message via `claude -p --resume`
  GET  /api/chat/status?id=<session_id>   - status of the chat run
"""

import concurrent.futures
import http.cookies
import http.server
import json
import os
import re
import socket
import subprocess
import threading
from urllib.parse import urlparse, parse_qs

from viewer import db
from viewer.config import (
    CLAUDE_DIR, DEFAULT_SESSION, PORT, UI_DIR, VIEWER_NO_AUTH, claude_bin,
)
from viewer.engine import (
    loop_scheduler, run_loop_iteration,
)


class _Req:
    """Parsed request context handed to every route handler.

    Bundles the parsed URL, decoded query, and the selected host so route
    handlers share one signature — (self, req) — and never re-parse.
    """
    __slots__ = ("parsed", "path", "raw_query", "query", "host")

    def __init__(self, parsed):
        self.parsed = parsed
        self.path = parsed.path
        self.raw_query = parsed.query
        self.query = parse_qs(parsed.query)
        self.host = (self.query.get("host") or ["local"])[0]
from viewer.routes.sessions import SessionsMixin
from viewer.routes.chat import ChatMixin
from viewer.routes.capabilities import CapabilitiesMixin
from viewer.routes.fs import FsMixin
from viewer.routes.panels import PanelsMixin
from viewer.routes.auth import AuthMixin
from viewer.routes.git import GitMixin


class SessionViewerHandler(
    SessionsMixin, ChatMixin, CapabilitiesMixin, FsMixin,
    PanelsMixin, AuthMixin, GitMixin, http.server.SimpleHTTPRequestHandler,
):


    # ---- access control: a logged-in session (viewer.db) gates every /api call
    # and WebSocket. These few auth endpoints are reachable logged-out so you can
    # sign up / sign in; the drag-drop viewer is fully client-side (no /api). ----
    PUBLIC_API = {"/api/auth/me", "/api/auth/signin", "/api/auth/signup", "/api/auth/state"}

    def _cookie(self, name):
        raw = self.headers.get("Cookie")
        if not raw:
            return ""
        try:
            m = http.cookies.SimpleCookie(raw).get(name)
            return m.value if m else ""
        except Exception:
            return ""

    def current_user(self):
        """The logged-in user for this request ({id, username}) or None."""
        if VIEWER_NO_AUTH:
            return {"id": 0, "username": "local"}
        return db.user_for_session(self._cookie(db.SESSION_COOKIE))

    def _gated(self, req):
        """True if this request must be blocked (an /api call, not public, no session)."""
        return (req.path.startswith("/api/")
                and req.path not in self.PUBLIC_API
                and not self.current_user())

    def set_session_cookie(self, token):
        """Emit a Set-Cookie on the response (token=None clears it, for logout)."""
        self._session_cookie = "" if token is None else token

    def do_GET(self):
        req = _Req(urlparse(self.path))
        if self._gated(req):
            self.send_error(401, "Unauthorized")
            return
        name = self.GET_ROUTES.get(req.path)
        if name:
            getattr(self, name)(req)
            return
        for prefix, pname in self.GET_PREFIX:
            if req.path.startswith(prefix):
                getattr(self, pname)(req)
                return
        super().do_GET()

    def do_POST(self):
        req = _Req(urlparse(self.path))
        if self._gated(req):
            self.send_error(401, "Unauthorized")
            return
        name = self.POST_ROUTES.get(req.path)
        if name:
            getattr(self, name)(req)
            return
        for prefix, pname in self.POST_PREFIX:
            if req.path.startswith(prefix):
                getattr(self, pname)(req)
                return
        self.send_error(404, "Not found")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(UI_DIR), **kwargs)

    def end_headers(self):
        # Never let the browser serve a stale index.html/js/css after a rebuild —
        # must-revalidate so a normal refresh always gets the latest.
        p = getattr(self, "path", "") or ""
        if p == "/" or p.split("?")[0].endswith((".js", ".html", ".css")):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        tok = getattr(self, "_session_cookie", None)
        if tok is not None:
            self._session_cookie = None
            attrs = "HttpOnly; SameSite=Strict; Path=/"
            self.send_header("Set-Cookie", f"{db.SESSION_COOKIE}={tok}; {attrs}; "
                             + (f"Max-Age={db.SESSION_TTL}" if tok else "Max-Age=0"))
        super().end_headers()

    # ===== Front Controller =====
    # do_GET/do_POST are thin dispatchers over the GET_ROUTES/POST_ROUTES
    # tables defined at the bottom of this class. Exact path matches win;
    # then the *_PREFIX lists are tried in order; then GET falls through to
    # static files and POST returns 404. Every handler takes (self, req).

    def read_body(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return None

    @staticmethod
    def sid_from_path(rel):
        """Session id from a rel path — works for local and remote (no file needed)."""
        if not rel:
            return None
        m = re.search(r"([0-9a-fA-F-]{8,40})\.jsonl$", rel)
        return m.group(1) if m else None

    def send_host_result(self, result, not_found="Not found"):
        """Send a Host method's return value. None → 404; a dict carrying an
        int "status" key → that status (key stripped); otherwise 200."""
        if result is None:
            self.send_json({"error": not_found}, status=404)
            return
        status = 200
        if isinstance(result, dict) and isinstance(result.get("status"), int):
            result = dict(result)
            status = result.pop("status")
        self.send_json(result, status=status)

    def send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        if args and "404" in str(args[0]):
            super().log_message(format, *args)



    GET_ROUTES = {
        "/api/hosts": "_g_hosts",
        "/api/env": "_g_env",
        "/api/env/value": "_g_env_value",
        "/api/debug/stacks": "_g_debug_stacks",
        "/api/sessions": "_g_sessions",
        "/api/chat/status": "_g_chat_status",
        "/api/auth/status": "_g_auth_status",
        "/api/auth/me": "_g_auth_me",
        "/api/auth/state": "_g_auth_state",
        "/api/prefs": "_g_prefs",
        "/api/auth/login/poll": "_g_auth_login_poll",
        "/api/commands": "_g_commands",
        "/api/loops": "_g_loops",
        "/api/agents": "_g_agents",
        "/api/agents/login/poll": "_g_agent_login_poll",
        "/api/fs": "_g_fs",
        "/api/fs/download": "_g_fs_download",
        "/api/fs/download-zip": "_g_fs_download_zip",
        "/api/terminal/ws": "_g_terminal_ws",
        "/api/copilot-interactive": "_g_copilot_interactive",
        "/api/browser/ws": "_g_browser_ws",
        "/api/browser/status": "_g_browser_status",
        "/api/browser/tabs": "_g_browser_tabs",
        "/api/browser/frame": "_g_browser_frame",
        "/api/capabilities": "_g_capabilities",
        "/api/session-summary": "_g_session_summary",
        "/api/session-analysis": "_g_session_analysis",
        "/api/skill": "_g_skill",
        "/api/session-meta": "_g_session_meta",
        "/api/projects": "_g_projects",
        "/api/resolve": "_g_resolve",
        "/api/default": "_g_default",
        "/api/git/repos": "_g_git_repos",
        "/api/git/status": "_g_git_status",
        "/api/git/clone/status": "_g_git_clone_status",
    }
    GET_PREFIX = [
        ("/api/session/", "_g_session_file"),
    ]
    POST_ROUTES = {
        "/api/chat": "_p_chat",
        "/api/agents/install": "_p_agents_install",
        "/api/agents/login/start": "_p_agent_login_start",
        "/api/agents/login/submit": "_p_agent_login_submit",
        "/api/agents/login/cancel": "_p_agent_login_cancel",
        "/api/agents/mcp/browser": "_p_agents_mcp_browser",
        "/api/new-session": "_p_new_session",
        "/api/git/clone": "_p_git_clone",
        "/api/hosts/test": "_p_hosts_test",
        "/api/hosts/save": "_p_hosts_save",
        "/api/hosts/delete": "_p_hosts_delete",
        "/api/env/set": "_p_env_set",
        "/api/env/unset": "_p_env_unset",
        "/api/fs/mkdir": "_p_fs_mkdir",
        "/api/fs/delete": "_p_fs_delete",
        "/api/fs/upload": "_p_fs_upload",
        "/api/fs/rename": "_p_fs_rename",
        "/api/fs/compress": "_p_fs_compress",
        "/api/auth/signup": "_p_auth_signup",
        "/api/auth/signin": "_p_auth_signin",
        "/api/auth/signout": "_p_auth_signout",
        "/api/prefs": "_p_prefs",
        "/api/auth/login/start": "_p_auth_login_start",
        "/api/auth/login/code": "_p_auth_login_code",
        "/api/auth/login/cancel": "_p_auth_login_cancel",
        "/api/chat/steer": "_p_chat_steer",
        "/api/chat/interrupt": "_p_chat_interrupt",
        "/api/chat/queue/remove": "_p_chat_queue_remove",
        "/api/skill/save": "_p_skill_save",
        "/api/skill/delete": "_p_skill_delete",
        "/api/mcp/save": "_p_mcp_save",
        "/api/mcp/delete": "_p_mcp_delete",
        "/api/session/fork": "_p_session_fork",
        "/api/session/restore": "_p_session_restore",
        "/api/session/delete": "_p_session_delete",
        "/api/session/rename": "_p_session_rename",
        "/api/loops": "_p_loops",
        "/api/loops/delete": "_p_loops_delete",
        "/api/session-meta": "_p_session_meta",
    }
    POST_PREFIX = [
        ("/api/browser/", "_p_browser"),
    ]


class PooledHTTPServer(http.server.ThreadingHTTPServer):
    """Threaded HTTP server with a BOUNDED worker pool + fast-503 backpressure,
    so a burst of requests can't spawn unbounded threads (the plain
    ThreadingHTTPServer is one-thread-per-request with no ceiling).

    Long-lived WebSocket streams (browser/terminal) would each hold a pooled
    worker for the whole connection, so they're peeked off the request line and
    run on their own dedicated daemon thread, off the pool. Every other request
    is short (the handler speaks HTTP/1.0, so no keep-alive holds a worker) and
    goes through the pool; when all slots are busy the server replies 503 rather
    than queueing unboundedly."""

    daemon_threads = True
    WS_PATHS = (b"/api/terminal/ws", b"/api/browser/ws")
    PEEK_TIMEOUT = 5       # cap the WS-detection peek so a silent client can't pin a worker
    REQUEST_TIMEOUT = 30   # cap a whole HTTP request read for the same reason (WS opts out)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        n = max(64, (os.cpu_count() or 4) * 16)
        self.worker_cap = n
        self._pool = concurrent.futures.ThreadPoolExecutor(max_workers=n, thread_name_prefix="req")
        self._slots = threading.Semaphore(n)

    def process_request(self, request, client_address):
        # NEVER block the accept loop: hand every connection to the pool at once
        # (fast 503 when saturated). The WS peek + off-pool hand-off happen inside
        # the worker, so a slow/silent client can't wedge the whole server.
        if not self._slots.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\n"
                                b"Content-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            self._pool.submit(self._serve, request, client_address)
        except RuntimeError:  # pool shutting down
            self._slots.release()
            self.shutdown_request(request)

    def _is_ws(self, request):
        """Peek the request target (non-consuming, time-bounded) and match it to a
        WS path EXACTLY — a bounded recv here runs on a worker, not the accept loop."""
        try:
            request.settimeout(self.PEEK_TIMEOUT)
            line = request.recv(320, socket.MSG_PEEK).split(b"\r\n", 1)[0]
        except OSError:
            return False
        finally:
            try:
                request.settimeout(None)
            except OSError:
                pass
        parts = line.split(b" ")
        target = parts[1].split(b"?", 1)[0] if len(parts) > 1 else b""
        return target in self.WS_PATHS

    def _serve(self, request, client_address):
        # Long-lived WebSockets move to a dedicated thread and free the pool slot
        # immediately, so they never occupy a bounded worker for the connection.
        if self._is_ws(request):
            threading.Thread(target=self._finish, args=(request, client_address), daemon=True).start()
            self._slots.release()
            return
        # Regular HTTP: bound the request read. The peek left the socket blocking
        # with no timeout, so without this a silent/slow client's readline() in
        # finish_request would block forever and pin this worker (and its pool
        # slot) — worker_cap such connections would exhaust the pool. BaseHTTP's
        # handle_one_request catches the resulting socket.timeout and closes.
        try:
            request.settimeout(self.REQUEST_TIMEOUT)
        except OSError:
            pass
        try:
            self._finish(request, client_address)
        finally:
            self._slots.release()

    def _finish(self, request, client_address):
        try:
            self.finish_request(request, client_address)
        except Exception:
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(request)

    def server_close(self):
        super().server_close()
        self._pool.shutdown(wait=False)


def main():
    tailscale_ip = "N/A"
    try:
        result = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=5)
        tailscale_ip = result.stdout.strip()
    except Exception:
        pass

    try:
        db.init_db()
    except Exception as e:
        print(f"  ⚠ database not ready ({e}) — sign-in will fail until Postgres/DATABASE_URL is set up")

    if not (UI_DIR / "index.html").exists():
        print(f"  ⚠ web UI not built ({UI_DIR}) — run: cd web && npm install && npm run build")

    threading.Thread(target=loop_scheduler, args=(run_loop_iteration,), daemon=True).start()
    server = PooledHTTPServer(("0.0.0.0", PORT), SessionViewerHandler)

    print("Agents")
    print(f"  Local:     http://localhost:{PORT}/")
    print(f"  Tailscale: http://{tailscale_ip}:{PORT}/")
    print(f"  Network:   http://0.0.0.0:{PORT}/")
    if VIEWER_NO_AUTH:
        print("  ⚠ AUTH DISABLED (VIEWER_NO_AUTH) — the API exposes a shell + FS; front it with your own auth")
    else:
        print("  Sign in at the URL above (first visit creates your account).")
    print("")
    print(f"  Default session: {DEFAULT_SESSION}")
    print(f"  Sessions dir:    {CLAUDE_DIR}")
    print(f"  Claude binary:   {claude_bin()}")
    print("")
    print("Press Ctrl+C to stop")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.server_close()
        db.close_pool()


if __name__ == "__main__":
    main()
