"""viewer.routes.chat — ChatMixin route + business methods."""
import json
import os
from pathlib import Path
from viewer.config import (
    CHAT_JOBS, CHAT_LOCK,
)
from viewer.adapters import resolve_agent_session
from viewer.engine import (
    _pi_session_uuid, codex_session_meta, copilot_session_meta, enqueue_chat, extract_cwd, interrupt_chat, pi_session_cwd, pi_session_provider_model, start_claude_run, start_codex_run, start_copilot_run, start_pi_run, steer_chat,
)
from viewer.remote import (
    remote_codex_meta, remote_extract_cwd,
)


class ChatMixin:
    def _p_chat_steer(self, req):
        body = self.read_body() or {}
        sid = self.sid_from_path(body.get("path", ""))
        text = (body.get("message") or "").strip()
        if not sid or not text:
            self.send_json({"error": "Session and message required"}, status=400)
            return
        outcome = steer_chat(sid, text)
        if outcome is None:
            self.send_json({"error": "No active run to steer — send it normally"}, status=409)
        else:
            self.send_json({"outcome": outcome})

    def _p_chat_queue_remove(self, req):
        body = self.read_body() or {}
        sid = self.sid_from_path(body.get("path", ""))
        idx = body.get("index")
        if not sid or not isinstance(idx, int):
            self.send_json({"error": "Session and index required"}, status=400)
            return
        with CHAT_LOCK:
            job = CHAT_JOBS.get(sid)
            removed = None
            if job and 0 <= idx < len(job.get("queue", [])):
                removed = job["queue"].pop(idx)
        self.send_json({"removed": removed})

    def _p_chat_interrupt(self, req):
        body = self.read_body() or {}
        sid = self.sid_from_path(body.get("path", ""))
        if not sid:
            self.send_json({"error": "Session not found"}, status=404)
            return
        if interrupt_chat(sid):
            self.send_json({"interrupted": True})
        else:
            self.send_json({"error": "No active run"}, status=409)

    def handle_chat(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self.send_json({"error": "Invalid JSON body"}, status=400)
            return

        rel_path = body.get("path", "")
        message = (body.get("message") or "").strip()
        mode = body.get("mode", "acceptEdits")
        model = body.get("model", "")
        host = body.get("host", "local")
        agent = body.get("agent", "claude")
        if not message:
            self.send_json({"error": "Empty message"}, status=400)
            return

        # Non-Claude agents drive through their own launcher. Pi is one-shot
        # (`pi -p --session`), local-only for now; other agents are view-only.
        if agent != "claude":
            if agent == "pi" and host == "local":
                full_path = resolve_agent_session("pi", rel_path)
                if full_path is None:
                    self.send_json({"error": "Session not found"}, status=404)
                    return
                if body.get("queue"):
                    self.send_json({"error": "Queueing isn't supported for this agent"}, status=409)
                    return
                session_id = full_path.stem
                cwd = pi_session_cwd(full_path)
                provider, pimodel = pi_session_provider_model(full_path)
                if not start_pi_run(session_id, _pi_session_uuid(session_id), message, cwd, provider, pimodel):
                    self.send_json({"error": "A message is already being processed for this session"}, status=409)
                    return
                self.send_json({"started": True, "session": session_id})
                return
            if agent == "codex":
                if body.get("queue"):
                    self.send_json({"error": "Queueing isn't supported for this agent"}, status=409)
                    return
                if host == "local":
                    full_path = resolve_agent_session("codex", rel_path)
                    if full_path is None:
                        self.send_json({"error": "Session not found"}, status=404)
                        return
                    session_id = full_path.stem
                    codex_id, cwd = codex_session_meta(full_path)
                else:
                    session_id = rel_path.rsplit("/", 1)[-1].replace(".jsonl", "")
                    try:
                        codex_id, cwd = remote_codex_meta(host, rel_path)
                    except Exception as e:
                        self.send_json({"error": f"SSH: {e}"}, status=502)
                        return
                if not codex_id:
                    self.send_json({"error": "Could not resolve the Codex session id"}, status=400)
                    return
                if not start_codex_run(session_id, codex_id, message, cwd, model, host):
                    self.send_json({"error": "A message is already being processed for this session"}, status=409)
                    return
                self.send_json({"started": True, "session": session_id})
                return
            if agent == "copilot":
                if body.get("queue"):
                    self.send_json({"error": "Queueing isn't supported for this agent"}, status=409)
                    return
                if host == "local":
                    full_path = resolve_agent_session("copilot", rel_path)
                    if full_path is None:
                        self.send_json({"error": "Session not found"}, status=404)
                        return
                    session_id, cwd = copilot_session_meta(full_path)
                else:
                    session_id = rel_path.split("/")[0]
                    cwd = "~"
                if not session_id:
                    self.send_json({"error": "Could not resolve the Copilot session id"}, status=400)
                    return
                if not start_copilot_run(session_id, message, cwd, host, model, mode):
                    self.send_json({"error": "A message is already being processed for this session"}, status=409)
                    return
                self.send_json({"started": True, "session": session_id})
                return
            self.send_json({"error": f"Driving {agent} isn't supported here yet"}, status=501)
            return

        if host != "local":
            session_id = rel_path.rsplit("/", 1)[-1].replace(".jsonl", "")
            try:
                cwd = remote_extract_cwd(host, rel_path) or "~"
            except Exception as e:
                self.send_json({"error": f"SSH: {e}"}, status=502)
                return
        else:
            full_path = self.resolve_session_quiet(rel_path)
            if full_path is None:
                self.send_json({"error": "Session not found"}, status=404)
                return
            session_id = full_path.stem
            cwd = extract_cwd(full_path)
            if not os.path.isdir(cwd):
                cwd = str(Path.home())

        # While a run is active: queue (next turn) instead of rejecting.
        if body.get("queue"):
            pos = enqueue_chat(session_id, message)
            if pos is not None:
                self.send_json({"queued": pos, "session": session_id})
                return
        if not start_claude_run(session_id, ["--resume", session_id], message, mode, cwd, model, host):
            self.send_json({"error": "A message is already being processed for this session"}, status=409)
            return
        self.send_json({"started": True, "session": session_id})

    def _p_chat(self, req):
        self.handle_chat()

    def _g_copilot_interactive(self, req):
        """Return the shell command that resumes a Copilot session interactively."""
        rel = (req.query.get("session") or [""])[0]
        from viewer.copilot import copilot_interactive_cmd
        try:
            cmd = copilot_interactive_cmd(req.host, rel)
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)
            return
        if not cmd:
            self.send_json({"error": "Could not resolve session"}, status=404)
            return
        self.send_json({"cmd": cmd})

    def _g_chat_status(self, req):
        sid = (req.query.get("id") or [""])[0]
        job = CHAT_JOBS.get(sid)
        if not job:
            self.send_json({"running": False, "idle": True})
        else:
            self.send_json({
                "running": job["running"],
                "returncode": job["returncode"],
                "stderr": job["stderr"],
                "started": job["started"],
                "queue": [q[:200] for q in job.get("queue", [])],
                "turns": job.get("turns", 0),
                "steered": job.get("steered", 0),
                "interrupted": job.get("interrupted", False),
            })

