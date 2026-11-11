"""Audit log, learned skills, UI usage events and restart requests."""
from psycopg2.extras import Json

from orchestrator.shared import postgres


# Audit log (append-only) -----------------------------------------------------

def audit_append(actor, action, target=None, outcome=""):
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO audit_log(actor, action, target, outcome, created_at) "
            "VALUES(%s,%s,%s,%s,%s) RETURNING id",
            (actor, action, Json(target or {}), outcome, postgres.now()),
        )
        return cur.fetchone()["id"]


def audit_list(limit=100, actor=None, action=None, *, before_id=None, result=None):
    """Newest recorded IDs; optional display filtering happens before the limit."""
    clauses, params = [], []
    if actor is not None:
        clauses.append("actor = %s"); params.append(actor)
    if action is not None:
        clauses.append("action = %s"); params.append(action)
    if before_id is not None:
        clauses.append("id < %s"); params.append(before_id)
    if result is not None:
        from orchestrator.audit import outcome_filter
        clause, values = outcome_filter(result)
        if clause:
            clauses.append(clause); params.extend(values)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(int(limit))
    with postgres.cursor() as cur:
        cur.execute(f"SELECT * FROM audit_log{where} ORDER BY id DESC LIMIT %s", params)
        return [dict(r) for r in cur.fetchall()]


# Learned skills (provenance ledger; content stays a SKILL.md file) -----------

def skill_learned_record(name, path="", origin_card=None, origin_session=None,
                         status="proposed"):
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO skills_learned(name, path, origin_card, "
            "origin_session, status, created_at) VALUES(%s,%s,%s,%s,%s,%s) RETURNING *",
            (name, path, origin_card, origin_session, status, postgres.now()),
        )
        return dict(cur.fetchone())


def skill_learned_list(status=None):
    clauses, params = [], []
    if status is not None:
        clauses.append("status = %s"); params.append(status)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with postgres.cursor() as cur:
        cur.execute(f"SELECT * FROM skills_learned{where} ORDER BY id DESC", params)
        return [dict(r) for r in cur.fetchall()]


def skill_learned_set_status(skill_id, status):
    with postgres.cursor() as cur:
        cur.execute("UPDATE skills_learned SET status = %s WHERE id = %s RETURNING *",
                    (status, skill_id))
        row = cur.fetchone()
    return dict(row) if row else None


# Product usage (ui_events) ----------------------------------------------------

def ui_events_insert(actor, events):
    """Append a validated batch (orchestrator.usage.clean_events) for one actor.
    One statement per batch; returns the number written."""
    if not events:
        return 0
    rows = [(e["ts"], actor, e["client"], e["surface"], e["element"],
             e["kind"], e["detail"]) for e in events]
    with postgres.cursor() as cur:
        cur.executemany(
            "INSERT INTO ui_events (ts, actor, client, surface, element, kind, detail) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)", rows)
    return len(rows)


def ui_usage_rows(since):
    """Per (client, surface, element, kind) counts over the whole retained
    history, split at `since`: n = events in the window, actors = distinct
    actors in the window, n_before = events before it (what lets the report
    tell a control that went cold from one that was never used)."""
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT client, surface, element, kind, "
            "  count(*) FILTER (WHERE ts >= %s) AS n, "
            "  count(DISTINCT actor) FILTER (WHERE ts >= %s) AS actors, "
            "  count(*) FILTER (WHERE ts < %s) AS n_before, "
            "  max(ts) AS last_ts "
            "FROM ui_events WHERE kind <> 'feedback' "
            "GROUP BY client, surface, element, kind", (since, since, since))
        return [dict(r) for r in cur.fetchall()]


def ui_feedback_list(since, limit=50):
    """Newest feedback notes in the window, with where they were written."""
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT ts, actor, client, surface, detail FROM ui_events "
            "WHERE kind = 'feedback' AND ts >= %s ORDER BY ts DESC LIMIT %s",
            (since, int(limit)))
        return [dict(r) for r in cur.fetchall()]


def ui_events_purge(max_age_days):
    """Drop usage older than the retention window. Returns rows removed."""
    if not max_age_days or max_age_days <= 0:
        return 0
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM ui_events WHERE ts < %s", (postgres.now() - float(max_age_days) * 86400,))
        return cur.rowcount


# Restart requests (orchestrator.maintenance) ---------------------------------------

def restart_request_add(requested_by, session_id, commit_sha, reason):
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO restart_requests(requested_by, session_id, commit_sha, reason, created_at) "
            "VALUES(%s,%s,%s,%s,%s) RETURNING *",
            (requested_by, session_id or "", commit_sha or "", reason, postgres.now()))
        return dict(cur.fetchone())


def restart_requests_by_status(status):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM restart_requests WHERE status = %s ORDER BY id", (status,))
        return [dict(r) for r in cur.fetchall()]


def restart_requests_set_status(ids, status):
    if not ids:
        return
    with postgres.cursor() as cur:
        cur.execute("UPDATE restart_requests SET status = %s, handled_at = %s WHERE id = ANY(%s)",
                    (status, postgres.now(), list(ids)))
