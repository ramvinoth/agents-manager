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


def open_decisions(question_rows, plan_rows, approval_rows, labels, now):
    """Shape the three decision sources into ONE queue — the kanban decision
    list (card #60).

    Pure: no db, no clock, no network. The route gathers the raw rows (the
    durable question/plan tables + the live approval registry) and passes them
    in, so the shaping is unit-testable without a database.

    Ordering is oldest-first: wait time is the only order that exists before a
    human ranks anything (manual priority is a later phase — its semantics for
    a durable row are Ram's call, not this module's). Each item is a pointer +
    summary, not a decision surface: deciding an item uses the EXISTING
    per-session routes (/api/chat/question/answer, /api/chat/plan/decide,
    /api/chat/permission/decide), so the board never becomes a second approval
    system.
    """
    labels = labels or {}

    def label(sid):
        return labels.get(sid, "")

    items = []
    for r in question_rows or []:
        sid = r.get("session_id", "")
        qs = r.get("questions")
        qs = qs if isinstance(qs, list) else []
        first = qs[0] if qs and isinstance(qs[0], dict) else {}
        text = str(first.get("question") or first.get("header") or "")
        items.append({
            "kind": "question",
            "session": sid,
            "host": r.get("host") or "local",
            "label": label(sid),
            "waiting_s": int(max(0, now - float(r.get("created_at") or now))),
            "summary": text[:120],
            "question_count": len(qs),
            "tool_use_id": r.get("tool_use_id") or "",
            "run_id": r.get("run_id") or "",
            "revision": int(r.get("revision") or 0),
        })
    for r in plan_rows or []:
        sid = r.get("session_id", "")
        items.append({
            "kind": "plan",
            "session": sid,
            "host": r.get("host") or "local",
            "label": label(sid),
            "waiting_s": int(max(0, now - float(r.get("created_at") or now))),
            "summary": str(r.get("plan") or "")[:120],
            "tool_use_id": r.get("tool_use_id") or "",
        })
    for r in approval_rows or []:
        sid = r.get("session", "")
        items.append({
            "kind": "approval",
            "session": sid,
            "host": r.get("host") or "local",
            "label": label(sid),
            "waiting_s": int(max(0, now - float(r.get("created") or now))),
            "summary": str(r.get("preview") or r.get("tool_name") or "")[:120],
            "tool_name": r.get("tool_name") or "",
            "id": r.get("id") or "",
        })
    items.sort(key=lambda i: i["waiting_s"], reverse=True)
    return {"count": len(items), "decisions": items}


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
