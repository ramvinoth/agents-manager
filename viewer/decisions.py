"""viewer.decisions — the owner's answer/decision entry point.

One place owns "the human decided a pending question or plan", and the order
is fixed: DURABLE FIRST, then deliver.

  1. Consume the exact row (first-writer-wins). Two racing surfaces — another
     device, a double tap, a stale card — race this single DELETE; exactly one
     wins. The loser gets False, never a second resume of the same session.
  2. Deliver to the live waiter (if one is blocked in-process): the blocked
     turn continues in place. Delivery only happens for a decision that won
     the consume, so a lost race can never unblock a turn with a phantom answer.

Because the consume commits before delivery, a decision is durable the moment
it is made: it cannot be lost to a crash or a timeout, and it cannot be
double-counted. On timeout the row is never touched (engine keeps it), so a
skipped question or plan resurfaces — the next card, the next heartbeat — and
this same gate answers it later via the resume path.
"""
from viewer import db


def accept_answer(session_id, tool_use_id, answer, host="local", run_id="", revision=0):
    """Accept the owner's answer to a session's open question.

    (1) Consume the exact row — tool + host + run + revision. A session-only
    delete would be wrong: the row is keyed by session and replaced on re-ask,
    so a stale cleanup could erase a newer request. (2) If the consume won and
    there is a live waiter, unblock it with the answer.

    Returns (accepted, delivered):
      accepted  — this call won the consume (the answer is durable)
      delivered — a live blocked turn was unblocked in place (same turn
                  continues); else the caller resumes the session
    """
    try:
        accepted = db.decision_answer_accept(session_id, tool_use_id, host, run_id, revision)
    except Exception:
        accepted = False
    delivered = False
    if accepted and answer:
        try:
            from viewer import engine
            delivered = bool(engine.answer_live_question(session_id, answer))
        except Exception:
            delivered = False
    return accepted, delivered


def decide_plan(session_id, tool_use_id, decision, feedback=""):
    """Accept the owner's approve/deny of a session's open plan. Same
    durable-first shape as accept_answer; the plan row's identity is
    (session, tool) — no run/revision columns on pending_plans, and a stale
    tap naming an older tool simply matches nothing and loses.

    Returns (accepted, delivered).
    """
    try:
        accepted = db.pending_plan_resolve(session_id, tool_use_id)
    except Exception:
        accepted = False
    delivered = False
    if accepted:
        try:
            from viewer import engine
            delivered = bool(engine.decide_plan(session_id, decision, feedback))
        except Exception:
            delivered = False
    return accepted, delivered
