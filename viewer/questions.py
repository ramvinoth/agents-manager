"""viewer.questions — AskUserQuestion / ExitPlanMode lifecycle (persist / answer).

A driven `claude -p` run has no interactive UI, so when it calls AskUserQuestion the
viewer's permission tool answers on the user's behalf: it BLOCKS the live turn, writes
a durable row here (viewer.db.pending_questions) so the app can render a card that
survives an app close or a server restart, and feeds back the user's pick as the tool
result — the same turn continues. If nobody answers before the block times out, the
turn ends and the durable row STAYS open: the question resurfaces (the card, the
next heartbeat) and is answered later by resuming the session (routes/chat.py
`_p_chat_question_answer`) — a skipped question is never silently dropped. Answers
are consumed first-writer-wins at the moment of acceptance (viewer.decisions),
before any delivery, so two surfaces racing on the same question cannot both win.
Works in every permission mode, local and remote. The engine drives this; see
engine.py `_await_question_answer`.

This module is host-agnostic: `questions_from_input` is a pure parser, and the DB
wrappers carry no HTTP or threading knowledge.

Recording a question also COUNTS it (`ask_owner` in `audit_log`). That count is all
that survives of the `ask_owner` tool this design cut: escalation stays native, but
§12.3's "interruptions fall as autonomy is earned" is only checkable if someone
counts. See ORCHESTRATOR_MCP.md §8.
"""
import json

from viewer import db


def questions_from_input(tinput):
    """Pull the `questions` list out of an AskUserQuestion tool input, tolerating a
    JSON-string input (the CLI sends either shape). Returns [] if malformed — the
    caller then has no card to render, which is better than raising inside a
    permission callback that a live turn is blocked on. Pure: no I/O."""
    if isinstance(tinput, str):
        try:
            tinput = json.loads(tinput)
        except (json.JSONDecodeError, TypeError):
            return []
    if isinstance(tinput, dict):
        qs = tinput.get("questions")
        return qs if isinstance(qs, list) else []
    return []


def answer_message(questions, picks, note=""):
    """Compose the message fed back to the resumed session. `picks` is a list of
    selected option labels, positionally aligned with `questions`; `note` is the
    owner's free text — the follow-up when none of the offered options fits, or
    a condition attached to a pick ("A, but only after the tests pass"). Either
    alone is a complete answer. Server-side and authoritative.
    """
    parts = []
    for i, q in enumerate(questions):
        chosen = picks[i] if i < len(picks) else ""
        if not chosen:
            continue
        header = (q.get("header") or q.get("question") or "").strip()
        parts.append(f'{header}: {chosen}' if header else chosen)
    note = (note or "").strip()
    if not parts and not note:
        return "My answer to your question — (no selection)"
    if not parts:
        return ("My answer to your question — none of the offered options; instead: "
                f"{note}")
    body = "\n".join(parts)
    return f"My answer to your question — {body}" + (f"\nAdditional note: {note}" if note else "")


# ---- thin DB wrappers (single source of truth = viewer.db) ----------------------

def record(session_id, pending, host="local", run_id=""):
    """Persist the open question, then count it as an interruption.

    Returns the row's new revision (db.pending_question_set) — the caller stores
    it on its live waiter so a later cleanup can match the exact request.

    The audit row is what remains of the cut `ask_owner` tool: escalation itself is
    native (Claude's AskUserQuestion), but "interruptions fall as autonomy is earned"
    is only a checkable claim if questions are counted. Counting HERE — the one place
    a question becomes durable — means the number does not depend on an agent choosing
    our verb over Claude's, and a future caller cannot forget to count.

    Only the shape of the question is audited, never its text: audit_log is readable
    by anyone who can call /api/org/audit, and a question body can quote the work.
    Ordered persist-then-audit, and the audit is best-effort, so a bookkeeping failure
    can never lose a question the user is waiting to answer.
    """
    revision = db.pending_question_set(session_id, pending["tool_use_id"],
                                       pending["questions"], host, run_id)
    try:
        db.audit_append(f"session:{session_id}", "ask_owner",
                        {"session": session_id, "host": host,
                         "questions": len(pending["questions"] or [])}, "asked")
    except Exception:
        pass
    # A question became durable for the owner: the sessions that own OPEN cards
    # are the ones that can surface it to the owner (the source is the one
    # waiting). Harman-origin wake, so it obeys the mode + the master switch.
    try:
        from viewer.orchestrator import loop_mode, automation_enabled
        if automation_enabled() and loop_mode() in ("harman", "both"):
            from viewer import board_wake
            qs = pending.get("questions") or []
            summary = "; ".join((q.get("question") or q.get("header") or "")
                                for q in qs[:3]).replace("\n", " ")
            if summary:
                board_wake.wake_on_open_question(session_id, summary)
    except Exception:
        pass
    return revision


def get_open(session_id):
    return db.pending_question_get_open(session_id)


def get_open_all():
    """Every open question across all sessions, oldest first (the decision
    queue's question half)."""
    return db.pending_question_open_all()


def clear_exact(session_id, tool_use_id, host="local", run_id="", revision=0):
    """Consume only the exact request identified (tool + host + run + revision).
    The answer path itself is owned by decisions.accept_answer (consume-then-
    deliver, first-writer-wins); this is the identity primitive for any other
    exact consumer."""
    return db.pending_question_clear_exact(session_id, tool_use_id, host, run_id, revision)


def clear(session_id):
    """Session-wide drop — for session DELETE only. Never the answer path: the
    row is keyed by session and replaced on re-ask, so a session-wide delete
    from a stale waiter would erase a NEWER request. See db.pending_question_clear_exact."""
    db.pending_question_delete(session_id)


# ---- plans (ExitPlanMode) — thin DB wrappers -----------------------------------

def record_plan(session_id, pending, host="local"):
    db.pending_plan_set(session_id, pending["tool_use_id"], pending["plan"], host)
    # Same cross-session surfacing as record(): an open plan is an open request
    # on the owner, and the open-card sessions are the ones that can surface it.
    try:
        from viewer.orchestrator import loop_mode, automation_enabled
        if automation_enabled() and loop_mode() in ("harman", "both"):
            from viewer import board_wake
            plan = (pending.get("plan") or "").replace("\n", " ")
            if plan:
                board_wake.wake_on_open_question(session_id,
                                                f"plan awaiting approval: {plan[:260]}")
    except Exception:
        pass


def get_open_plan(session_id):
    return db.pending_plan_get_open(session_id)


def get_open_plan_all():
    """Every open plan across all sessions, oldest first (the decision
    queue's plan half)."""
    return db.pending_plan_open_all()


def plan_decision_message(decision, feedback=""):
    """The turn fed to a session whose plan was decided AFTER its live waiter was
    gone (timeout / restart): the CLI never saw an approve/deny, so the resumed
    run must be told the outcome in words. Pure."""
    if decision == "approve":
        return "Your plan is approved — proceed with the implementation."
    body = f" Feedback: {feedback.strip()}" if feedback and feedback.strip() else ""
    return f"Your plan was not approved. Revise it and present it again.{body}"


def clear_plan(session_id):
    db.pending_plan_delete(session_id)
