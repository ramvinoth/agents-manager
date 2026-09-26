"""viewer.routes.chat — ChatMixin route + business methods."""
import json
import os
from pathlib import Path
from viewer.config import (
    CHAT_JOBS, CHAT_LOCK,
)
from viewer.adapters import resolve_agent_session
from viewer.engine import (
    _pi_session_uuid, codex_session_meta, copilot_session_meta, decide_permission, enqueue_chat, extract_cwd, interrupt_chat, pending_approvals_public, pi_session_cwd, pi_session_provider_model, register_permission, start_claude_run, start_codex_run, start_copilot_run, start_pi_run, steer_chat,
)
from viewer.remote import (
    remote_codex_meta, remote_extract_cwd, remote_resolve,
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

        # Queued messages belong to the active launch configuration, even if the
        # saved selection changed while that process was running.
        if body.get("queue"):
            if (CHAT_JOBS.get(session_id) or {}).get("agent") == "custom":
                self.send_json({"error": "Queueing is not supported for plain custom chat"}, status=409)
                return
            pos = enqueue_chat(session_id, message)
            if pos is not None:
                self.send_json({"queued": pos, "session": session_id})
                return
        from viewer.turn import start_turn
        failure = start_turn(session_id, message, mode, cwd, model, host)
        if failure:
            status, error = failure
            self.send_json({"error": error}, status=status)
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
        from viewer import questions
        pending_q = questions.get_open(sid) if sid else None
        pending_plan = questions.get_open_plan(sid) if sid else None
        job = CHAT_JOBS.get(sid)
        if not job:
            # No live run, but a durable pending question/plan may still await input
            # (the run ended; they outlive it).
            self.send_json({"running": False, "idle": True,
                            "pending_question": pending_q, "pending_plan": pending_plan})
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
                "pending_approvals": pending_approvals_public(sid),
                "pending_question": pending_q,
                "pending_plan": pending_plan,
            })

    def _p_chat_permission(self, req):
        """Internal (called by permission_mcp.py, authed by a per-run token):
        a driven claude is asking whether a tool may run. Blocks until the user
        decides in the UI, then returns the {behavior} decision."""
        body = self.read_body() or {}
        self.send_json(register_permission(
            body.get("session", ""), body.get("token", ""),
            body.get("tool_name", ""), body.get("input", {}),
            body.get("tool_use_id", "")))

    def _p_chat_permission_decide(self, req):
        """UI submits the user's Allow/Deny for a pending tool approval."""
        body = self.read_body() or {}
        ok = decide_permission(body.get("session", ""), body.get("id", ""),
                               body.get("decision", ""))
        self.send_json({"ok": ok})

    def _p_chat_question_answer(self, req):
        """UI answers an AskUserQuestion. Body: {session, picks:[label,...]}.
        The decision goes through decisions.accept_answer: the exact row is
        consumed first-writer-wins (a racing second tap gets 409, never a
        double resume), then — only if the consume won — a live blocked waiter
        is unblocked (same turn continues) or, failing that, the session is
        RESUMED on its original host with the composed answer as a fresh turn
        (run ended / server restarted). A question nobody answered in time was
        never cleared, so a late tap lands here and resumes — it resurfaces."""
        from viewer import decisions, questions
        body = self.read_body() or {}
        rel = body.get("session", "")
        picks = body.get("picks") or []
        sid = rel.rsplit("/", 1)[-1].replace(".jsonl", "") if rel else ""
        pending = questions.get_open(sid) if sid else None
        if not pending:
            self.send_json({"error": "No question is awaiting an answer"}, status=409)
            return
        host = pending.get("host") or "local"
        message = questions.answer_message(pending["questions"], picks)
        accepted, delivered = decisions.accept_answer(
            sid, pending["tool_use_id"], message, host,
            pending.get("run_id") or "", pending.get("revision") or 0)
        if delivered:
            self.send_json({"answered": True, "session": sid})
            return
        if not accepted:
            # A racing answer (another device, a double tap) committed first.
            self.send_json({"error": "This question was already answered"}, status=409)
            return
        # The block is gone (timeout / restart); resume as a fresh turn.
        self._resume_with_reply(rel, sid, host, message, body)

    def _resume_with_reply(self, rel, sid, host, message, body):
        """A durable question/plan was decided after its live waiter ended (timeout
        or server restart): the run that asked is gone, so the decision reaches the
        session as a fresh resumed turn on its original host."""
        if host != "local":
            try:
                r = remote_resolve(host, sid)
                cwd = remote_extract_cwd(host, r["path"]) if r.get("path") else "~"
            except Exception:
                cwd = "~"
        else:
            full = self.resolve_session_quiet(rel) or None
            cwd = extract_cwd(full) if full else str(Path.home())
            if not cwd or not os.path.isdir(cwd):
                cwd = str(Path.home())
        mode = body.get("mode", "acceptEdits")
        model = body.get("model", "")
        if not start_claude_run(sid, ["--resume", sid], message, mode, cwd, model, host):
            self.send_json({"error": "A run is already in progress for this session"}, status=409)
            return
        self.send_json({"resumed": True, "session": sid})

    def _p_chat_plan_decide(self, req):
        """UI approves or denies an ExitPlanMode. Body: {session,
        decision:"approve"|"deny", feedback?}. Fast path: the run is blocked waiting —
        approve lets it execute, deny returns `feedback` so it revises, same turn.
        Same durable-first shape as the question answer (decisions.decide_plan):
        the exact row is consumed first-writer-wins, then the live waiter is
        unblocked or — waiter gone (timeout / server restart) — the session is
        RESUMED with the decision in words, so a late decision on a timed-out
        plan lands instead of 409ing forever."""
        from viewer import decisions, questions
        body = self.read_body() or {}
        rel = body.get("session", "")
        sid = rel.rsplit("/", 1)[-1].replace(".jsonl", "") if rel else ""
        pending = questions.get_open_plan(sid) if sid else None
        if not pending:
            self.send_json({"error": "No plan is awaiting a decision"}, status=409)
            return
        decision = "approve" if body.get("decision") == "approve" else "deny"
        feedback = body.get("feedback", "")
        accepted, delivered = decisions.decide_plan(
            sid, pending["tool_use_id"], decision, feedback)
        if delivered:
            self.send_json({"decided": True, "session": sid})
            return
        if not accepted:
            self.send_json({"error": "This plan was already decided"}, status=409)
            return
        self._resume_with_reply(rel, sid, pending.get("host") or "local",
                                questions.plan_decision_message(decision, feedback), body)

