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
import logging

import http.cookies
import http.server
import json
import os
import re
import socket
import sys
import threading
from urllib.parse import urlparse, parse_qs

from viewer import db, orglogic
from viewer.remote import tailnet_ipv4
from viewer.config import (
    CLAUDE_DIR, DEFAULT_SESSION, PORT, UI_DIR, VIEWER_NO_AUTH, VIEWER_PREFLIGHT, claude_bin,
)
from viewer.engine import (
    loop_scheduler, run_loop_iteration, run_settings_paths_in_use,
    run_settings_sweep_orphans, validate_session_credential,
)


class _Req:
    """Parsed request context handed to every route handler.

    Bundles the parsed URL, decoded query, the selected host, and the resolved
    caller so route handlers share one signature — (self, req) — and never
    re-parse or re-authenticate.
    """
    __slots__ = ("parsed", "path", "raw_query", "query", "host", "principal")

    def __init__(self, parsed):
        self.parsed = parsed
        self.path = parsed.path
        self.raw_query = parsed.query
        self.query = parse_qs(parsed.query)
        self.host = (self.query.get("host") or ["local"])[0]
        self.principal = None   # set once by _resolve_principal(); see Principal
from viewer.routes.sessions import SessionsMixin
from viewer.routes.chat import ChatMixin
from viewer.routes.capabilities import CapabilitiesMixin
from viewer.routes.fs import FsMixin
from viewer.routes.panels import PanelsMixin
from viewer.routes.auth import AuthMixin
from viewer.routes.git import GitMixin
from viewer.routes.push import PushMixin
from viewer.routes.voice import VoiceMixin
from viewer.routes.providers import ProvidersMixin
from viewer.routes.orchestrator import OrchestratorMixin
from viewer.routes.drives import DrivesMixin


class SessionViewerHandler(
    SessionsMixin, ChatMixin, CapabilitiesMixin, FsMixin,
    PanelsMixin, AuthMixin, GitMixin, PushMixin, VoiceMixin, ProvidersMixin,
    OrchestratorMixin, DrivesMixin,
    http.server.SimpleHTTPRequestHandler,
):


    # ---- access control: every /api call and WebSocket resolves ONE principal
    # before any handler runs. Two credential kinds, one resolution point:
    #   - cookie / Bearer            → the logged-in human   (kind "app")
    #   - X-Viewer-Session + -Token  → an agent's MCP subprocess (kind "mcp")
    # Authority is min(human ceiling, session level) — orglogic.effective_level.
    #
    # PUBLIC_API is ONLY for endpoints that must work with no credential at all:
    # signing up/in, and a device dropping its own push token on logout (which
    # must succeed even though the session is already gone). Everything else
    # authenticates. A handler must never re-derive the caller — read
    # req.principal.
    PUBLIC_API = {"/api/auth/me", "/api/auth/signin", "/api/auth/signup", "/api/auth/state",
                  "/api/push/unregister"}

    def _cookie(self, name):
        raw = self.headers.get("Cookie")
        if not raw:
            return ""
        try:
            m = http.cookies.SimpleCookie(raw).get(name)
            return m.value if m else ""
        except Exception:
            return ""

    def _auth_token(self):
        """Session token for this request: the `viewer_session` cookie (web UI)
        or an `Authorization: Bearer <token>` header (non-browser clients like the
        mobile app, which have no cookie jar). Cookie wins when both are present."""
        tok = self._cookie(db.SESSION_COOKIE)
        if tok:
            return tok
        auth = self.headers.get("Authorization", "")
        if auth[:7].lower() == "bearer ":
            return auth[7:].strip()
        return ""

    def current_user(self):
        """The logged-in user for this request ({id, username, role}) or None."""
        if VIEWER_NO_AUTH:
            return {"id": 0, "username": "local", "role": "owner"}
        return db.user_for_session(self._auth_token())

    def _mcp_credential(self):
        """(session_id, token) for an agent's MCP subprocess, from headers only.

        Headers — not the JSON body — because the principal is resolved at the
        gate, before any handler reads the (read-once) request stream. X-Kanban-*
        is the pre-rename spelling, still accepted so a subprocess started before
        an upgrade keeps working until its run ends.
        """
        sid = (self.headers.get("X-Viewer-Session")
               or self.headers.get("X-Kanban-Session") or "")
        tok = (self.headers.get("X-Viewer-Token")
               or self.headers.get("X-Kanban-Token") or "")
        return sid, tok

    def _resolve_principal(self, req):
        """Resolve the ONE caller for this request and attach it to req.

        Returns the principal, or None when no valid credential was presented.
        A principal is:
          {kind, actor, human_role, session_level, level, user, session}
        where `level` is the effective authority — min(human ceiling, session
        level) — and is the only value a handler should gate on.

        `actor` names the caller the way the owner sees it everywhere else:
        `user:<name>` for a human at the UI, `employee:<name>` for a session
        linked to an employee, and `session:<label-or-short-id>` for a session
        with no employee link — never a fabricated identity ("employee:?").
        The label is the per-run snapshot from the engine (the same name as
        the chat list and pushes); without one (e.g. a run outliving a
        restart) the short id stands in.
        """
        user = self.current_user()
        if user:
            # A human at the UI. No agent session is acting, so the session level
            # does not constrain: authority is the role's ceiling.
            req.principal = {
                "kind": "app", "actor": f"user:{user['username']}",
                "human_role": user.get("role", "viewer"), "session_level": "",
                "level": orglogic.effective_level(user.get("role", "viewer"), ""),
                "user": user, "session": "",
            }
            return req.principal
        sid, tok = self._mcp_credential()
        info = validate_session_credential(sid, tok)
        if info:
            emp = info.get("employee") or {}
            level = info.get("level", "ic")
            # An agent spawned by the loop has no logged-in human. Its ceiling is
            # the install owner's role — never an implicit escalation, and on a
            # fresh install with no owner it resolves to no authority at all.
            human_role = db.owner_role()
            if emp:
                actor = f"employee:{emp.get('name') or emp.get('id') or '?'}"
            else:
                # No employee link: name it for what it is — the session — with
                # the label its live run started with, else the short id.
                actor = f"session:{info.get('label') or str(sid)[:8]}"
            req.principal = {
                "kind": "mcp", "actor": actor,
                "human_role": human_role, "session_level": level,
                "level": orglogic.effective_level(human_role, level),
                "user": None, "session": sid,
            }
            return req.principal
        return None

    def _gated(self, req):
        """True if this request must be blocked. Resolves the principal as a side
        effect, so authentication happens exactly once per request."""
        if not req.path.startswith("/api/") or req.path in self.PUBLIC_API:
            return False
        return self._resolve_principal(req) is None

    def set_session_cookie(self, token):
        """Emit a Set-Cookie on the response (token=None clears it, for logout)."""
        self._session_cookie = "" if token is None else token

    def do_OPTIONS(self):
        """CORS preflight.

        JSON responses already carry `Access-Control-Allow-Origin: *`, but a
        cross-origin POST that sets Authorization/Content-Type triggers a
        preflight first — and without this the base handler answered 501, so the
        browser blocked the real request. This is what lets the React Native Web
        build of mobile-app/ (served by the Expo dev server on another port) talk
        to the API during development.

        Deliberately no Access-Control-Allow-Credentials: cookies stay
        same-origin, so this does not widen the cookie-authenticated surface.
        """
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

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
            # Clamp: read_body only serves small JSON handlers (uploads read raw
            # elsewhere). Reject negative and cap at 32 MiB so a huge/negative
            # Content-Length can't allocate unboundedly or block on read(-1).
            if length < 0 or length > 32 * 1024 * 1024:
                return None
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
        "/api/decisions/open": "_g_decisions_open",
        "/api/auth/status": "_g_auth_status",
        "/api/auth/me": "_g_auth_me",
        "/api/auth/state": "_g_auth_state",
        "/api/prefs": "_g_prefs",
        "/api/auth/login/poll": "_g_auth_login_poll",
        "/api/commands": "_g_commands",
        "/api/loops": "_g_loops",
        "/api/agent-templates": "_g_agent_templates",
        "/api/agents": "_g_agents",
        "/api/agents/login/poll": "_g_agent_login_poll",
        "/api/fs": "_g_fs",
        "/api/fs/download": "_g_fs_download",
        "/api/fs/download-zip": "_g_fs_download_zip",
        "/api/drives": "_g_drives",
        "/api/drive/oauth/status": "_g_drive_oauth_status",
        "/api/terminal/ws": "_g_terminal_ws",
        "/api/copilot-interactive": "_g_copilot_interactive",
        "/api/browser/ws": "_g_browser_ws",
        "/api/voice/ws": "_g_voice_ws",
        "/api/voice/nemotron/status": "_g_voice_nemotron_status",
        "/api/call/engine": "_g_call_engine",
        "/api/voice/nemotron/ws": "_g_voice_nemotron_ws",
        "/api/browser/status": "_g_browser_status",
        "/api/browser/tabs": "_g_browser_tabs",
        "/api/browser/frame": "_g_browser_frame",
        "/api/capabilities": "_g_capabilities",
        "/api/session-summary": "_g_session_summary",
        "/api/session-detail": "_g_session_detail",
        "/api/session-analysis": "_g_session_analysis",
        "/api/session-backups": "_g_session_backups",
        "/api/skill": "_g_skill",
        "/api/session-meta": "_g_session_meta",
        "/api/projects": "_g_projects",
        "/api/resolve": "_g_resolve",
        "/api/default": "_g_default",
        "/api/git/repos": "_g_git_repos",
        "/api/git/status": "_g_git_status",
        "/api/git/clone/status": "_g_git_clone_status",
        "/api/voice/tts/stream": "_g_voice_tts_stream",
        "/api/providers": "_g_providers",
        "/api/providers/default": "_g_providers_default",
        "/api/providers/models": "_g_providers_models",
        "/api/ai/defaults": "_g_ai_defaults",
        "/api/session/ai": "_g_session_ai",
        "/api/org/employees": "_g_org_employees",
        "/api/org/projects": "_g_org_projects",
        "/api/org/board": "_g_org_board",
        "/api/org/card": "_g_org_card",
        "/api/org/card_comments": "_g_org_card_comments",
        "/api/org/card_deps": "_g_org_card_deps",
        "/api/org/cards": "_g_org_cards",
        "/api/org/notes": "_g_org_notes",
        "/api/org/note": "_g_org_note",
        "/api/org/approvals": "_g_org_approvals",
        "/api/org/audit": "_g_org_audit",
        "/api/org/harman": "_g_org_harman",
        "/api/org/loop-control": "_g_org_loop_control",
        "/api/org/system-preamble": "_g_org_system_preamble",
        "/api/org/skills": "_g_org_skills",
        "/api/org/docs": "_g_org_docs",
        "/api/org/docs/read": "_g_org_docs_read",
    }
    GET_PREFIX = [
        ("/api/session/", "_g_session_file"),
    ]
    POST_ROUTES = {
        "/api/chat": "_p_chat",
        "/api/push/register": "_p_push_register",
        "/api/push/unregister": "_p_push_unregister",
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
        "/api/drives": "_p_drives_create",
        "/api/drives/delete": "_p_drives_delete",
        "/api/drive/oauth/start": "_p_drive_oauth_start",
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
        "/api/chat/permission": "_p_chat_permission",
        "/api/chat/permission/decide": "_p_chat_permission_decide",
        "/api/chat/question/answer": "_p_chat_question_answer",
        "/api/chat/plan/decide": "_p_chat_plan_decide",
        "/api/call/turn": "_p_call_turn",
        "/api/skill/save": "_p_skill_save",
        "/api/skill/delete": "_p_skill_delete",
        "/api/mcp/save": "_p_mcp_save",
        "/api/mcp/delete": "_p_mcp_delete",
        "/api/session/fork": "_p_session_fork",
        "/api/session/restore": "_p_session_restore",
        "/api/session/backup-restore": "_p_session_backup_restore",
        "/api/session/delete": "_p_session_delete",
        "/api/session/rename": "_p_session_rename",
        "/api/session/seen": "_p_session_seen",
        "/api/session/mode": "_p_session_mode",
        "/api/loops": "_p_loops",
        "/api/loops/edit": "_p_loops_edit",
        "/api/loops/delete": "_p_loops_delete",
        "/api/agent-templates": "_p_agent_templates",
        "/api/agent-templates/delete": "_p_agent_templates_delete",
        "/api/session-meta": "_p_session_meta",
        "/api/providers": "_p_providers",
        "/api/providers/models": "_p_providers_models",
        "/api/ai/defaults": "_p_ai_defaults",
        "/api/session/ai": "_p_session_ai",
        "/api/providers/delete": "_p_providers_delete",
        "/api/org/employees": "_p_org_employees",
        "/api/org/employees/update": "_p_org_employees_update",
        "/api/org/projects": "_p_org_projects",
        "/api/org/project-for-cwd": "_p_org_project_for_cwd",
        "/api/org/columns": "_p_org_columns",
        "/api/org/columns/update": "_p_org_columns_update",
        "/api/org/columns/delete": "_p_org_columns_delete",
        "/api/org/cards": "_p_org_cards",
        "/api/org/cards/move": "_p_org_cards_move",
        "/api/org/cards/assign": "_p_org_cards_assign",
        "/api/org/cards/update": "_p_org_cards_update",
        "/api/org/cards/done": "_p_org_cards_done",
        "/api/org/cards/delete": "_p_org_cards_delete",
        "/api/org/card_comment": "_p_org_card_comment",
        "/api/org/notes": "_p_org_notes",
        "/api/org/notes/update": "_p_org_notes_update",
        "/api/org/notes/delete": "_p_org_notes_delete",
        "/api/org/card_dep_add": "_p_org_card_dep_add",
        "/api/org/card_dep_remove": "_p_org_card_dep_remove",
        "/api/org/approvals/resolve": "_p_org_approvals_resolve",
        "/api/org/harman": "_p_org_harman",
        "/api/org/loop-control": "_p_org_loop_control",
        "/api/org/system-preamble": "_p_org_system_preamble",
        "/api/org/loops": "_p_org_loops",
        "/api/org/loops/update": "_p_org_loops_update",
        "/api/org/loops/delete": "_p_org_loops_delete",
        "/api/org/skills/propose": "_p_org_skills_propose",
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
    WS_PATHS = (b"/api/terminal/ws", b"/api/browser/ws", b"/api/voice/ws",
                b"/api/voice/nemotron/ws")
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

    # A client hanging up mid-response (the app cancelling a transcript poll,
    # a tab closing) surfaces as one of these while the handler writes. It is
    # the client's choice, not a server fault; the stdlib default prints a full
    # 20-line traceback for each, and those bury the real errors in the log.
    CLIENT_GONE = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, self.CLIENT_GONE):
            print(f"client {client_address[0]} disconnected mid-response ({type(exc).__name__})",
                  file=sys.stderr)
            return
        super().handle_error(request, client_address)

    def server_close(self):
        super().server_close()
        self._pool.shutdown(wait=False)


def main():
    # Under launchd stdout is a file, so Python block-buffers it: the boot
    # banner and every print() diagnostic sit in an 8 KiB buffer until it fills
    # or the process exits cleanly. `launchctl kickstart -k` SIGKILLs, so the
    # buffer is simply lost — the log showed three banners for weeks of
    # restarts. stderr (logging, tracebacks) is already line-buffered.
    sys.stdout.reconfigure(line_buffering=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    try:
        db.init_db()
    except Exception as e:
        print(f"  ⚠ database not ready ({e}) — sign-in will fail until Postgres/DATABASE_URL is set up")

    if not (UI_DIR / "index.html").exists():
        print(f"  ⚠ web UI not built ({UI_DIR}) — run: cd web && npm install && npm run build")

    # Nothing is running yet at boot: loop runs from the previous process died with
    # it, so their still-'running' history rows are closed as errors and the
    # --settings files those runs held (provider credentials) are removed before
    # the scheduler can open new ones. A preflight boot shares this Postgres and
    # $TMPDIR with a live server whose runs ARE running — it must not touch either,
    # nor start a second scheduler.
    if VIEWER_PREFLIGHT:
        print("  ⚠ PREFLIGHT (VIEWER_PREFLIGHT) — boot reconciliation and scheduler skipped")
    else:
        try:
            abandoned = db.job_runs_abandon_running()
            if abandoned:
                print(f"  ⚠ closed {abandoned} loop run(s) left 'running' by the previous server process")
        except Exception as e:
            print(f"  ⚠ job_runs reconciliation failed: {e}")
        try:
            swept = run_settings_sweep_orphans(run_settings_paths_in_use())
            if swept:
                print(f"  ⚠ removed {len(swept)} orphaned run settings file(s) left by the previous server process")
        except Exception as e:
            print(f"  ⚠ run settings sweep failed: {e}")
        threading.Thread(target=loop_scheduler, args=(run_loop_iteration,), daemon=True).start()
    server = PooledHTTPServer((os.environ.get("VIEWER_HOST","0.0.0.0"), PORT), SessionViewerHandler)

    print("Agents")
    print(f"  Local:     http://localhost:{PORT}/")
    tailscale_ip = tailnet_ipv4()
    print("  Tailscale: " + (f"http://{tailscale_ip}:{PORT}/" if tailscale_ip else "N/A (no tailnet address found)"))
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
