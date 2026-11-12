"""Tool permissions, live questions and plan decisions raised by running agents."""
import json
import re
import secrets
import threading
import time
from pathlib import Path

from orchestrator import db, orglogic
from orchestrator import live as live_events  # `live` is a local name in several functions
from orchestrator.config import CHAT_JOBS, CHAT_LOCK, CLAUDE_DIR, PERM_TIMEOUT, QUESTION_TIMEOUT
from orchestrator.runtime.titles import push_label


def _await_question_answer(session_id, tinput, tool_use_id):
    """Block a driven claude's AskUserQuestion until the user answers (or timeout),
    returning the CLI-consumable permission decision. Also persists a durable
    pending_questions row so the app can render the card and it survives restart.

    On TIMEOUT this method does NOT clear the durable row: the question stays
    open (the card, the next heartbeat) and is answered later by resuming the
    session — a skipped question resurfaces instead of being silently dropped.
    An ANSWERED question is consumed exactly once, by the accept path
    (decisions.accept_answer), before this wait even releases.
    """
    from orchestrator import questions
    q_list = questions.questions_from_input(tinput)
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job:
            return {"behavior": "deny", "message": "Session ended"}
        pid = secrets.token_hex(8)
        ev = threading.Event()
        job.setdefault("pending_approvals", []).append(
            {"id": pid, "tool_name": "AskUserQuestion", "input": tinput,
             "tool_use_id": tool_use_id, "event": ev, "decision": None,
             "answer": None, "question": True, "created": time.time(),
             "run_id": job.get("run_id") or "",
             "revision": 0})
        host = job.get("host", "local")
        run_id = job.get("run_id") or ""
    # Durable row: the app renders the card from this; survives app-close/restart.
    # record returns the row's revision; the live waiter keeps it so the exact
    # identity travels with the wait.
    revision = 0
    try:
        revision = questions.record(session_id,
                                    {"tool_use_id": tool_use_id, "questions": q_list},
                                    host, run_id) or 0
    except Exception:
        pass
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        pend = job.get("pending_approvals", []) if job else []
        entry = next((e for e in pend if e["id"] == pid), None)
        if entry:
            entry["revision"] = revision
    decided = ev.wait(timeout=QUESTION_TIMEOUT)
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        pend = job.get("pending_approvals", []) if job else []
        entry = next((e for e in pend if e["id"] == pid), None)
        if entry:
            pend.remove(entry)
    answer = (entry.get("answer") if entry else None) or ""
    # No clear here, on either path: an answer consumed the exact row at accept
    # time (decisions.accept_answer); a timeout leaves the row open so the
    # question resurfaces. (questions.clear is session-delete-only now.)
    if not decided or not answer:
        # No answer in time: hand back the CLI's own "unanswered" so it can proceed.
        return {"behavior": "deny", "message": "The user did not answer the questions."}
    return {"behavior": "deny", "message": answer}


def _plan_text(session_id, tinput, live_text="", started=0):
    """The plan to show in the approval card.

    Older CLIs put the markdown straight in ExitPlanMode's `plan` argument. Newer
    ones build the plan in a *plan file* and call ExitPlanMode with `{}`, which
    would leave the card blank.

    Order matters. `live_text` is the assistant text captured from the run's own
    stream and is the only ordering-safe source: the transcript file is written
    asynchronously, so reading it back here can return the PREVIOUS turn's text.
    The file scan stays as the fallback for a plan that arrives without live
    text. Best-effort throughout; "" is still a valid answer."""
    if isinstance(tinput, dict):
        for key in ("plan", "plan_md", "content"):
            v = tinput.get(key)
            if isinstance(v, str) and v.strip():
                return v
    if isinstance(live_text, str) and live_text.strip():
        return live_text.strip()
    try:
        matches = list(CLAUDE_DIR.glob(f"*/{session_id}.jsonl"))
        if not matches:
            return ""
        plan_file, last_text = "", ""
        with open(matches[0], errors="replace") as f:
            for line in f:
                if '"plan' not in line and '"text"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                pf = (obj.get("attachment") or {}).get("planFilePath")
                if pf:
                    plan_file = pf
                content = (obj.get("message") or {}).get("content")
                if obj.get("type") == "assistant" and isinstance(content, list):
                    txt = "\n".join(b.get("text", "") for b in content
                                    if isinstance(b, dict) and b.get("type") == "text").strip()
                    if txt:
                        last_text = txt
        if plan_file:
            # Only if it belongs to THIS call: a plan file left over from an
            # earlier run is exactly the staleness live_text exists to avoid.
            try:
                p = Path(plan_file)
                if p.stat().st_mtime >= started:
                    body = p.read_text(errors="replace").strip()
                    if body:
                        return body
            except OSError:
                pass
        return last_text
    except Exception:
        return ""


def _await_plan_decision(session_id, tinput, tool_use_id):
    """Block a driven claude's ExitPlanMode until the user approves or denies with
    feedback. Persists a durable pending_plans row so the app renders the plan card
    and it survives restart. approve -> allow; deny -> deny+feedback (agent revises)."""
    from orchestrator import questions
    with CHAT_LOCK:
        _j = CHAT_JOBS.get(session_id) or {}
        live = _j.get("last_assistant_text", "")
        started = _j.get("started", 0)
    plan_md = _plan_text(session_id, tinput, live, started)
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job:
            return {"behavior": "deny", "message": "Session ended"}
        pid = secrets.token_hex(8)
        ev = threading.Event()
        job.setdefault("pending_approvals", []).append(
            {"id": pid, "tool_name": "ExitPlanMode", "input": tinput,
             "tool_use_id": tool_use_id, "event": ev, "decision": None,
             "feedback": None, "plan": True, "created": time.time()})
        host = job.get("host", "local")
    try:
        questions.record_plan(session_id, {"tool_use_id": tool_use_id, "plan": plan_md}, host)
    except Exception:
        pass
    decided = ev.wait(timeout=QUESTION_TIMEOUT)
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        pend = job.get("pending_approvals", []) if job else []
        entry = next((e for e in pend if e["id"] == pid), None)
        if entry:
            pend.remove(entry)
    decision = entry.get("decision") if entry else None
    feedback = (entry.get("feedback") if entry else None) or ""
    # No clear here, on either path: an answered plan consumed the row at accept
    # time (decisions.decide_plan); a timeout leaves the row open so the plan
    # resurfaces for a later decision. (clear_plan is session-delete-only now.)
    if not decided:
        return {"behavior": "deny", "message": "No response (timed out) — plan not approved."}
    if decision == "approve":
        return {"behavior": "allow"}
    return {"behavior": "deny",
            "message": feedback or "The user did not approve the plan. Revise and re-present it."}


def register_permission(session_id, token, tool_name, tinput, tool_use_id):
    """Called by permission_mcp.py when a driven claude asks whether a tool may
    run. Registers a pending approval and BLOCKS until the user decides in the UI
    (or PERM_TIMEOUT -> deny). Returns {'behavior': 'allow'|'deny', ...}."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        authed = bool(job and job.get("perm_token") and job.get("perm_token") == token)
    if not authed:
        # No live job (e.g. server restarted) — validate against the persisted
        # token so a durable AskUserQuestion/ExitPlanMode can still be answered.
        try:
            row = db.session_token_get(session_id)
            authed = bool(row and row.get("perm_token") and row["perm_token"] == token)
        except Exception:
            authed = False
    if not authed:
        return {"behavior": "deny", "message": "Unknown or unauthorized session"}
    # AskUserQuestion routes through the permission tool (the CLI's own design:
    # checkPermissions returns behavior:"ask"). We BLOCK here until the user picks
    # an answer, then return {behavior:"deny", message:<answer>} — the shape the CLI
    # consumes as the tool result (verified against the installed CLI, all modes).
    # A durable pending_questions row is also written so the app renders the card
    # and it survives app-close / server restart.
    if tool_name == "AskUserQuestion":
        return _await_question_answer(session_id, tinput, tool_use_id)
    # ExitPlanMode is the CLI's plan-approval gate (also routed through the perm
    # tool, all modes). Block until the user approves or denies-with-feedback:
    #   approve -> {behavior:"allow"}  (clean: the agent starts executing)
    #   deny    -> {behavior:"deny", message:<feedback>}  (agent revises + re-plans)
    if tool_name == "ExitPlanMode":
        return _await_plan_decision(session_id, tinput, tool_use_id)
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job:
            return {"behavior": "deny", "message": "Session ended"}
        # The owner granted this session bypass. In plan mode the CLI still routes
        # tools here, but the grant holds: only the plan itself is a decision.
        if job.get("mode") in ("bypass", "bypassPermissions"):
            return {"behavior": "allow"}
        pid = secrets.token_hex(8)
        ev = threading.Event()
        job.setdefault("pending_approvals", []).append(
            {"id": pid, "tool_name": tool_name, "input": tinput,
             "tool_use_id": tool_use_id, "event": ev, "decision": None,
             "created": time.time()})
        cwd = job.get("cwd", "")
        host = job.get("host", "local")
    live_events.publish("tool_approvals", pid, "INSERT")
    # Mirror into the owner's inbox (and the owner's one push for this ask,
    # sent by deliver_decision): the live registry above stays the one
    # source of truth (it disappears on restart — so does this row's open
    # state); the inbox row carries the cold-reader context and a reply
    # path. Exception-safe: never fail the permission request on delivery.
    try:
        from orchestrator import inbox
        inbox.deliver_decision(session_id, "approval", pid,
                               inbox.format_approval(push_label(session_id, cwd),
                                                     tool_name,
                                                     _perm_push_body(tool_name, tinput, host)))
    except Exception:
        pass
    decided = ev.wait(timeout=PERM_TIMEOUT)
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        pend = job.get("pending_approvals", []) if job else []
        entry = next((e for e in pend if e["id"] == pid), None)
        if entry:
            pend.remove(entry)
    # The registry is memory, not a table: tell live clients it changed.
    live_events.publish("tool_approvals", pid, "DELETE")
    decision = entry["decision"] if entry else None
    if not decided or decision != "allow":
        return {"behavior": "deny",
                "message": "Denied" if decision == "deny" else "No response (timed out)"}
    return {"behavior": "allow"}


def decide_permission(session_id, pid, decision):
    """UI sets the user's Allow/Deny for a pending tool approval."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        entry = next((e for e in job.get("pending_approvals", [])
                      if e["id"] == pid), None) if job else None
        if not entry:
            return False
        entry["decision"] = "allow" if decision == "allow" else "deny"
        entry["event"].set()
        return True


def answer_live_question(session_id, answer):
    """UI answers a live (blocked) AskUserQuestion for a session: set the answer on
    the waiting entry and release its Event so the blocked permission call returns
    the pick to the CLI, continuing the SAME turn. Returns True if a live question
    was waiting, False otherwise (caller falls back to resume).

    First-writer-wins in memory too: a question already answered (by another
    device/surface) is not answerable a second time. The durable row is the
    real guard (decisions.accept_answer consumes it first); this stops a
    duplicate from reaching the CLI even if a caller skips the gate."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job:
            return False
        entry = next((e for e in job.get("pending_approvals", []) if e.get("question")), None)
        if not entry:
            return False
        if entry.get("answer") is not None:
            return False
        entry["answer"] = answer
        entry["event"].set()
        return True


def decide_plan(session_id, decision, feedback=""):
    """UI approves or denies a live (blocked) ExitPlanMode. approve -> the agent
    starts executing; deny -> the agent revises using `feedback`. Returns True if a
    live plan decision was waiting, else False. First-writer-wins: a plan already
    decided is not decidable again (the durable row is the real guard —
    decisions.decide_plan consumes it first)."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job:
            return False
        entry = next((e for e in job.get("pending_approvals", []) if e.get("plan")), None)
        if not entry:
            return False
        if entry.get("decision") is not None:
            return False
        entry["decision"] = "approve" if decision == "approve" else "deny"
        entry["feedback"] = feedback or ""
        entry["event"].set()
        return True


def pending_approvals_public(session_id):
    """Pending Allow/Deny approvals for the UI: id + tool + input (drops the
    internal Event). AskUserQuestion and ExitPlanMode entries are EXCLUDED — they
    surface as their own cards (pending_question / pending_plan), not raw
    Allow/Deny approvals."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job:
            return []
        return [{"id": e["id"], "tool_name": e["tool_name"], "input": e["input"]}
                for e in job.get("pending_approvals", [])
                if not e.get("question") and not e.get("plan")]


def pending_approvals_all_public():
    """Live Allow/Deny tool approvals across ALL sessions — the raw rows for the
    cross-session decision queue (card #60). Same exclusion as the per-session
    view: AskUserQuestion and ExitPlanMode entries are NOT plain approvals, they
    are their own durable question/plan rows. Each row carries a secret-safe
    preview (the same one the permission push uses), never the raw input."""
    out = []
    with CHAT_LOCK:
        for sid, job in CHAT_JOBS.items():
            host = job.get("host", "local")
            for e in job.get("pending_approvals", []):
                if e.get("question") or e.get("plan"):
                    continue
                out.append({"session": sid, "host": host, "id": e["id"],
                            "tool_name": e["tool_name"],
                            "tool_use_id": e.get("tool_use_id") or "",
                            "preview": _perm_preview(e["tool_name"], e["input"]),
                            "created": float(e.get("created") or time.time())})
    return out


def effective_permission_mode(session_id, requested):
    """The permission mode a run of `session_id` actually starts with.

    The session's STORED mode (set by the owner via the session-mode route — the
    way a trusted agent runs its loop without a Bash approval per command)
    OVERRIDES the per-request mode: a loop run requests "acceptEdits", a chat
    requests whatever the composer picked, but the owner's stored call wins at
    this single point, so both run kinds behave the same. Best-effort: an
    unknown/stale value or a DB hiccup leaves `requested` untouched, so a
    storage failure can never change a run's security posture on its own.
    """
    if not session_id:
        return requested
    try:
        stored = (db.session_meta_get(session_id) or {}).get("permission_mode")
        if stored in orglogic.PERMISSION_MODES:
            return stored
    except Exception:
        pass
    return requested


def _redact_secrets(text):
    """Redact obvious credential material before it reaches a LOCK-SCREEN
    notification (APNs bodies are shown to anyone who can read the screen):
    Bearer tokens and token/key/password/api-key assignments. The command's
    shape stays readable; only the value goes."""
    return re.sub(
        r"(?i)((?:bearer|token|secret|api[_-]?key|access[_-]?key|password|passwd|pwd)\s*[=:]?\s+)\S+",
        r"\1***",
        text,
    )


def _perm_preview(tool_name, tinput):
    """A bounded, secret-safe one-liner for what a gated tool call would do.
    The CLI sends the tool input as a dict or a JSON string (both shapes
    seen in the wild), so parse leniently; a string-shaped input used to
    crash this function and silently kill the whole push.

    Only identity-shaped fields are previewed (command / file path / url /
    name / pattern / query / question) — never the tool's payload fields
    (content, message, data), which may hold the work itself. Everything is
    redacted and capped before it leaves the server."""
    if isinstance(tinput, str):
        try:
            tinput = json.loads(tinput)
        except Exception:
            tinput = {}
    if not isinstance(tinput, dict):
        tinput = {}
    if tool_name == "Bash":
        raw = str(tinput.get("command") or "")
    else:
        raw = ""
        for key in ("file_path", "path", "url", "name", "pattern", "query",
                    "question", "header"):
            v = tinput.get(key)
            if v is None or v == "":
                continue
            if key in ("question", "header"):
                raw = str(v)
            else:
                raw = f"{key}={v}"
            break
    return _redact_secrets(re.sub(r"\s+", " ", raw).strip())


def _perm_push_body(tool_name, tinput, host):
    """The push body for a gated tool call: WHAT is being asked. The old body
    was 'Approve Bash? The agent needs your permission to continue.' — no way
    for the owner to judge from the notification alone. Now it carries a
    bounded, secret-safe preview of the command (or the tool's identity
    fields), and the host when the run is remote (a local machine's label is
    noise). The preview is capped and redacted (see _perm_preview)."""
    body = f"Approve {tool_name}?"
    try:
        preview = _perm_preview(tool_name, tinput)
    except Exception:
        preview = ""
    if preview:
        body += f" — {preview[:79]}…" if len(preview) > 80 else f" — {preview}"
    if host and host != "local":
        body += f" (on {host})"
    return body
