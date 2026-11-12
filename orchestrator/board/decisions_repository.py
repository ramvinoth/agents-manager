"""Pending questions, pending plans and approvals (the owner's open decisions)."""
import time

from psycopg2.extras import Json

from orchestrator.shared import postgres


# ---- pending questions (async AskUserQuestion) ---------------------------------
# When a driven run ends on an unanswered AskUserQuestion, the question is parked
# here as a durable row instead of blocking a live subprocess. The app renders it
# and, when the user answers, the session is resumed via `claude --resume`. One
# open question per session at a time (PRIMARY KEY on session_id).


def pending_question_set(session_id, tool_use_id, questions, host="local", run_id=""):
    """Record (or replace) the open question for a session, remembering which
    host and which run it came from, and returning the row's new revision.

    The row is keyed by session (one open question per session, replaced on
    re-ask). The revision is the request's version within that row: it bumps
    when the SAME (run, tool) is re-recorded and resets to 1 when a different
    run or a different question replaces it. A cleanup that carries the
    revision can only ever match the exact request it belongs to — see
    pending_question_clear_exact."""
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO pending_questions(session_id, tool_use_id, questions, status, host, run_id, created_at) "
            "VALUES(%s,%s,%s,'open',%s,%s,%s) "
            "ON CONFLICT(session_id) DO UPDATE SET tool_use_id = excluded.tool_use_id, "
            "questions = excluded.questions, status = 'open', host = excluded.host, "
            "run_id = excluded.run_id, created_at = excluded.created_at, "
            "revision = CASE WHEN pending_questions.run_id = excluded.run_id "
            "AND pending_questions.tool_use_id = excluded.tool_use_id "
            "THEN pending_questions.revision + 1 ELSE 1 END "
            "RETURNING revision",
            (session_id, tool_use_id, Json(questions or []), host or "local",
             run_id or "", time.time()),
        )
        row = cur.fetchone()
        return int(row["revision"]) if row else 1


def pending_question_get_open(session_id):
    """The open question for a session, else None. Shape:
    {tool_use_id, questions, host, run_id, revision}."""
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT tool_use_id, questions, host, run_id, revision FROM pending_questions "
            "WHERE session_id = %s AND status = 'open'",
            (session_id,),
        )
        row = cur.fetchone()
    return {"tool_use_id": row["tool_use_id"], "questions": row["questions"],
            "host": row["host"], "run_id": row["run_id"] or "",
            "revision": int(row["revision"] or 1)} if row else None


def pending_question_open_all():
    """Every OPEN question, across all sessions, oldest first — the raw rows
    for the cross-session decision queue (card #60). One row per session (the
    table is keyed by session); shaping lives in decisions.open_decisions."""
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT session_id, tool_use_id, questions, host, run_id, revision, created_at "
            "FROM pending_questions WHERE status = 'open' ORDER BY created_at",
        )
        rows = cur.fetchall()
    return [{"session_id": r["session_id"], "tool_use_id": r["tool_use_id"],
             "questions": r["questions"], "host": r["host"] or "local",
             "run_id": r["run_id"] or "", "revision": int(r["revision"] or 1),
             "created_at": float(r["created_at"] or 0)} for r in rows]


def pending_question_clear_exact(session_id, tool_use_id, host="local", run_id="", revision=0):
    """Delete the session's question row only if it still holds exactly the
    identity of the request being cleaned up (tool + host + run + revision).
    A session-only DELETE is the wrong primitive: the row is keyed by session
    and replaced on re-ask, so a stale cleanup from an old waiter would
    otherwise erase a NEWER request the same session recorded meanwhile.
    Returns True if a row was removed."""
    with postgres.cursor() as cur:
        cur.execute(
            "DELETE FROM pending_questions "
            "WHERE session_id = %s AND tool_use_id = %s AND host = %s "
            "AND run_id = %s AND revision = %s AND status = 'open'",
            (session_id, tool_use_id, host or "local", run_id or "", int(revision or 0)),
        )
        return cur.rowcount > 0


def decision_answer_accept(session_id, tool_use_id, host="local", run_id="", revision=0):
    """First-writer-wins acceptance of an answer for the session's open
    question: consumes the exact row. Returns True if THIS call won the race —
    a concurrent second answer (another device, a double tap) finds the row
    gone and loses instead of double-firing the session. Acceptance is
    committed before any delivery, so the decision is durable at the moment
    it is made."""
    return pending_question_clear_exact(session_id, tool_use_id, host, run_id, revision)


def pending_question_delete(session_id):
    """Drop any pending question for a session (e.g. session deleted)."""
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM pending_questions WHERE session_id = %s", (session_id,))


# ---- pending plans (ExitPlanMode approval) -------------------------------------

def pending_plan_set(session_id, tool_use_id, plan, host="local"):
    """Record (or replace) the open plan awaiting approval for a session."""
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO pending_plans(session_id, tool_use_id, plan, status, host, created_at) "
            "VALUES(%s,%s,%s,'open',%s,%s) "
            "ON CONFLICT(session_id) DO UPDATE SET tool_use_id = excluded.tool_use_id, "
            "plan = excluded.plan, status = 'open', host = excluded.host, "
            "created_at = excluded.created_at",
            (session_id, tool_use_id, plan or "", host or "local", time.time()),
        )


def pending_plan_get_open(session_id):
    """The open plan for a session, else None. Shape: {tool_use_id, plan, host}."""
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT tool_use_id, plan, host FROM pending_plans "
            "WHERE session_id = %s AND status = 'open'",
            (session_id,),
        )
        row = cur.fetchone()
    return {"tool_use_id": row["tool_use_id"], "plan": row["plan"],
            "host": row["host"]} if row else None


def pending_plan_open_all():
    """Every OPEN plan, across all sessions, oldest first — the raw rows for
    the cross-session decision queue (card #60). One row per session."""
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT session_id, tool_use_id, plan, host, created_at "
            "FROM pending_plans WHERE status = 'open' ORDER BY created_at",
        )
        rows = cur.fetchall()
    return [{"session_id": r["session_id"], "tool_use_id": r["tool_use_id"],
             "plan": r["plan"], "host": r["host"] or "local",
             "created_at": float(r["created_at"] or 0)} for r in rows]


def pending_plan_resolve(session_id, tool_use_id):
    """Mark the session's open plan decided. Returns True if one was open and
    matched (guards a double-submit / a second device deciding the same plan).
    Deletes the row — the resumed run is the record, as for questions."""
    with postgres.cursor() as cur:
        cur.execute(
            "DELETE FROM pending_plans WHERE session_id = %s AND tool_use_id = %s AND status = 'open'",
            (session_id, tool_use_id),
        )
        return cur.rowcount > 0


def pending_plan_delete(session_id):
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM pending_plans WHERE session_id = %s", (session_id,))


# Approvals -------------------------------------------------------------------

def approval_open(kind, summary="", detail=None, created_by=""):
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO approvals(kind, summary, detail, status, created_by, created_at) "
            "VALUES(%s,%s,%s,'open',%s,%s) RETURNING *",
            (kind, summary, Json(detail or {}), created_by, postgres.now()),
        )
        return dict(cur.fetchone())


def approval_list_open():
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM approvals WHERE status = 'open' ORDER BY created_at")
        return [dict(r) for r in cur.fetchall()]


def approval_get(approval_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM approvals WHERE id = %s", (approval_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def approval_resolve(approval_id, resolution):
    """Mark an approval resolved ('approved'/'denied'/free text). Only an OPEN
    approval resolves: the row carries an intent that EXECUTES on approval, so
    without this an already-approved row could be re-resolved and the action run
    a second time. Returns None if it was not open."""
    with postgres.cursor() as cur:
        cur.execute(
            "UPDATE approvals SET status = 'resolved', resolution = %s, resolved_at = %s "
            "WHERE id = %s AND status = 'open' RETURNING *",
            (resolution, postgres.now(), approval_id),
        )
        row = cur.fetchone()
    return dict(row) if row else None
