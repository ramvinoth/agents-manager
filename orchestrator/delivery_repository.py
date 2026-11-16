"""Durable repository for Harman's internal delivery schedule ledger.

The board card remains the work item.  This repository owns only the delivery
facts linked to that card: a versioned schedule, append-only explanations and
durable reminder rows.  It deliberately does not send push notifications or
start sessions; the scheduler may act only after this repository has committed
one logical delivery row.
"""
from __future__ import annotations

import json
import math
from typing import Any, Mapping

from orchestrator import delivery_policy as policy
from orchestrator.shared import postgres


_MUTABLE_FIELDS = frozenset({
    "starts_at", "due_at", "timezone", "all_day", "estimated_duration_sec",
    "priority", "status", "owner_session_id", "owner_commitment", "external_link",
    "archived_reason",
})


def _row(row):
    return dict(row) if row else None


def _json(value: Any) -> str:
    """Use explicit JSON encoding, never interpolate planning data into SQL."""
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def schedule_get(schedule_id: int):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM delivery_schedules WHERE id = %s", (schedule_id,))
        return _row(cur.fetchone())


def schedule_for_card(card_id: int):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM delivery_schedules WHERE card_id = %s", (card_id,))
        return _row(cur.fetchone())


def schedule_list(project_id: int | None = None, *, include_terminal: bool = False):
    clauses, params = [], []
    if project_id is not None:
        clauses.append("project_id = %s")
        params.append(project_id)
    if not include_terminal:
        clauses.append("status NOT IN ('completed', 'cancelled', 'archived')")
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    with postgres.cursor() as cur:
        cur.execute(f"SELECT * FROM delivery_schedules{where} "
                    "ORDER BY due_at NULLS LAST, id", params)
        return [dict(row) for row in cur.fetchall()]


def schedules_due_for_reminders(*, now: float, limit: int = 20):
    """Return bounded, current schedule facts eligible for pure reminder policy.

    This is intentionally a scheduler read model, not an alternate delivery
    authority. Reminder creation locks and rereads the schedule before it commits
    the revision-keyed row.
    """
    if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
        raise ValueError("limit must be a positive integer")
    with postgres.cursor() as cur:
        # Do not let the oldest already-materialized schedules monopolize this
        # bounded scan forever.  A schedule is a candidate only while its current
        # revision is missing one of the policy's due-boundary deliveries.  The
        # two NOT EXISTS clauses deliberately preserve recovery from a crash
        # between the owner and agent inserts: an existing owner row does not
        # hide its still-missing agent wake.
        cur.execute(
            "SELECT * FROM delivery_schedules s "
            "WHERE s.status NOT IN ('completed', 'cancelled', 'archived') "
            "AND s.due_at IS NOT NULL AND s.due_at <= %s "
            "AND ("
            " NOT EXISTS (SELECT 1 FROM delivery_reminder_deliveries r "
            "             WHERE r.schedule_id = s.id AND r.schedule_revision = s.revision "
            "             AND r.reminder_kind = 'due' AND r.recipient_kind = 'owner_push' "
            "             AND r.recipient_id = '') "
            " OR (COALESCE(BTRIM(s.owner_session_id), '') <> '' "
            "     AND NOT EXISTS (SELECT 1 FROM delivery_reminder_deliveries r "
            "                     WHERE r.schedule_id = s.id AND r.schedule_revision = s.revision "
            "                     AND r.reminder_kind = 'due' AND r.recipient_kind = 'agent_wake' "
            "                     AND r.recipient_id = BTRIM(s.owner_session_id)))"
            ") ORDER BY s.due_at, s.id LIMIT %s",
            (now, limit),
        )
        return [dict(row) for row in cur.fetchall()]


def _append_event(cur, schedule: Mapping[str, Any], event_type: str, actor: str, *,
                  reason: str = "", before: Mapping[str, Any] | None = None,
                  after: Mapping[str, Any] | None = None, correlation_id: str = "",
                  metadata: Mapping[str, Any] | None = None):
    cur.execute(
        "INSERT INTO delivery_schedule_events("
        "schedule_id,card_id,event_type,actor,occurred_at,revision,reason,"
        "before_state,after_state,correlation_id,metadata) "
        "VALUES(%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s::jsonb)",
        (schedule["id"], schedule["card_id"], event_type, actor or "", postgres.now(),
         schedule["revision"], reason or "", _json(before or {}), _json(after or {}),
         correlation_id or "", _json(metadata or {})),
    )


def schedule_create(card_id: int, fields: Mapping[str, Any], *, actor: str,
                    actor_kind: str = "owner", reason: str = ""):
    """Create the one schedule for a card and record its creation atomically."""
    values = {key: fields[key] for key in _MUTABLE_FIELDS if key in fields}
    err = policy.validate_mutation(None, values, actor_kind=actor_kind, reason=reason)
    if err:
        return {"error": err}
    now = postgres.now()
    with postgres.cursor() as cur:
        # Locking the card serializes schedule creation with a confirmed delete
        # and derives project ownership from the canonical board record.
        cur.execute("SELECT id, project_id FROM cards WHERE id = %s FOR UPDATE", (card_id,))
        card = cur.fetchone()
        if not card:
            return {"error": "card not found"}
        cur.execute("SELECT id FROM delivery_schedules WHERE card_id = %s FOR UPDATE", (card_id,))
        if cur.fetchone():
            return {"error": "card already has a delivery schedule"}
        payload = {
            "card_id": card_id,
            "project_id": card["project_id"],
            "owner_session_id": values.get("owner_session_id"),
            "status": values.get("status", "planned"),
            "priority": values.get("priority", "normal"),
            "starts_at": values.get("starts_at"),
            "due_at": values.get("due_at"),
            "timezone": values.get("timezone", "UTC"),
            "all_day": values.get("all_day", False),
            "estimated_duration_sec": values.get("estimated_duration_sec"),
            "owner_commitment": values.get("owner_commitment", False),
            "external_link": _json(values.get("external_link", {})),
            "archived_reason": values.get("archived_reason", ""),
            "created_by": actor or "",
            "now": now,
        }
        cur.execute(
            "INSERT INTO delivery_schedules("
            "card_id,project_id,owner_session_id,status,priority,starts_at,due_at,timezone,"
            "all_day,estimated_duration_sec,owner_commitment,external_link,created_by,created_at,"
            "updated_at,completed_at,cancelled_at,archived_reason) VALUES("
            "%(card_id)s,%(project_id)s,%(owner_session_id)s,%(status)s,%(priority)s,"
            "%(starts_at)s,%(due_at)s,%(timezone)s,%(all_day)s,%(estimated_duration_sec)s,"
            "%(owner_commitment)s,%(external_link)s::jsonb,%(created_by)s,%(now)s,%(now)s,"
            "CASE WHEN %(status)s = 'completed' THEN %(now)s END,"
            "CASE WHEN %(status)s = 'cancelled' THEN %(now)s END,%(archived_reason)s) RETURNING *",
            payload,
        )
        schedule = dict(cur.fetchone())
        _append_event(cur, schedule, "created", actor, reason=reason, after=schedule)
        return schedule


def schedule_update(schedule_id: int, expected_revision: int, changes: Mapping[str, Any], *,
                    actor: str, actor_kind: str = "owner", reason: str = "",
                    event_type: str = "updated", correlation_id: str = ""):
    """Compare-and-swap a schedule and append the matching immutable event.

    ``expected_revision`` is required even for an owner: calendar/timeline drag
    gestures must not overwrite an intervening edit.  A stale request becomes a
    conflict response that the client can refresh, never last-write-wins.
    """
    fields = {key: changes[key] for key in _MUTABLE_FIELDS if key in changes}
    if not fields:
        return {"error": "no delivery fields to update"}
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM delivery_schedules WHERE id = %s FOR UPDATE", (schedule_id,))
        current = _row(cur.fetchone())
        if not current:
            return {"error": "schedule not found"}
        if current["revision"] != expected_revision:
            return {"conflict": True, "schedule": current}
        err = policy.validate_mutation(current, fields, actor_kind=actor_kind, reason=reason)
        if err:
            return {"error": err}
        now = postgres.now()
        next_status = fields.get("status", current["status"])
        fields["revision"] = current["revision"] + 1
        fields["updated_at"] = now
        if next_status == "completed" and current["status"] != "completed":
            fields["completed_at"] = now
        if next_status == "cancelled" and current["status"] != "cancelled":
            fields["cancelled_at"] = now
        sets = ", ".join(f"{key} = %({key})s" for key in fields)
        params = dict(fields, id=schedule_id)
        if "external_link" in params:
            params["external_link"] = _json(params["external_link"])
            sets = sets.replace("external_link = %(external_link)s", "external_link = %(external_link)s::jsonb")
        cur.execute(f"UPDATE delivery_schedules SET {sets} WHERE id = %(id)s RETURNING *", params)
        updated = dict(cur.fetchone())
        _append_event(cur, updated, event_type, actor, reason=reason, before=current,
                      after=updated, correlation_id=correlation_id)
        # Pending reminders from older versions can never represent the truth
        # after a schedule mutation. This durable suppression prevents an old
        # scheduler claim from becoming a late push or wake after rescheduling.
        cur.execute(
            "UPDATE delivery_reminder_deliveries SET status = 'cancelled', updated_at = %s "
            "WHERE schedule_id = %s AND schedule_revision < %s "
            "AND status IN ('pending', 'claimed')",
            (now, schedule_id, updated["revision"]),
        )
        return updated


def schedule_cancel(schedule_id: int, expected_revision: int, *, actor: str,
                    actor_kind: str = "owner", reason: str = ""):
    """Cancel planned work through a named, auditable lifecycle operation."""
    if not str(reason).strip():
        return {"error": "delivery cancellation requires a reason"}
    return schedule_update(
        schedule_id, expected_revision, {"status": "cancelled"}, actor=actor,
        actor_kind=actor_kind, reason=reason, event_type="cancelled")


def schedule_archive(schedule_id: int, expected_revision: int, *, actor: str,
                     actor_kind: str = "owner", reason: str = ""):
    """Archive terminal delivery history without deleting it."""
    if not str(reason).strip():
        return {"error": "delivery archive requires a reason"}
    return schedule_update(
        schedule_id, expected_revision, {"status": "archived"}, actor=actor,
        actor_kind=actor_kind, reason=reason, event_type="archived")


def schedule_recover(schedule_id: int, expected_revision: int, changes: Mapping[str, Any], *,
                     actor: str, actor_kind: str = "owner", reason: str = ""):
    """Create an explicit new plan from completed/cancelled delivery history.

    This is deliberately not ``schedule_update``: normal state transitions do
    not permit terminal work to become active. A recovery keeps the old plan in
    immutable history while recording exactly why and when new work resumes.
    """
    fields = {key: changes[key] for key in _MUTABLE_FIELDS if key in changes}
    if len(fields) != len(changes):
        return {"error": "recovery contains unknown delivery fields"}
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM delivery_schedules WHERE id = %s FOR UPDATE", (schedule_id,))
        current = _row(cur.fetchone())
        if not current:
            return {"error": "schedule not found"}
        if current["revision"] != expected_revision:
            return {"conflict": True, "schedule": current}
        err = policy.validate_recovery(current, fields, actor_kind=actor_kind, reason=reason)
        if err:
            return {"error": err}
        now = postgres.now()
        fields["status"] = fields.get("status", "planned")
        fields["revision"] = current["revision"] + 1
        fields["updated_at"] = now
        fields["completed_at"] = None
        fields["cancelled_at"] = None
        sets = ", ".join(f"{key} = %({key})s" for key in fields)
        params = dict(fields, id=schedule_id)
        if "external_link" in params:
            params["external_link"] = _json(params["external_link"])
            sets = sets.replace("external_link = %(external_link)s", "external_link = %(external_link)s::jsonb")
        cur.execute(f"UPDATE delivery_schedules SET {sets} WHERE id = %(id)s RETURNING *", params)
        recovered = dict(cur.fetchone())
        _append_event(cur, recovered, "recovered", actor, reason=reason,
                      before=current, after=recovered)
        return recovered


def schedule_complete_for_card_locked(cur, card_id: int, *, actor: str, reason: str = ""):
    """Complete a linked schedule using the caller's existing transaction.

    ``board.repository.card_complete`` calls this after its card update so the
    board's Done fact, schedule event, and reminder cancellation commit or roll
    back together.  The standalone wrapper below exists for non-board callers.
    """
    cur.execute("SELECT * FROM delivery_schedules WHERE card_id = %s FOR UPDATE", (card_id,))
    current = _row(cur.fetchone())
    if not current or policy.is_terminal(current["status"]):
        return current
    now = postgres.now()
    cur.execute(
        "UPDATE delivery_schedules SET status = 'completed', revision = revision + 1, "
        "updated_at = %s, completed_at = %s WHERE id = %s RETURNING *",
        (now, now, current["id"]),
    )
    updated = dict(cur.fetchone())
    _append_event(cur, updated, "completed", actor, reason=reason,
                  before=current, after=updated,
                  metadata={"source": "card_done"})
    cur.execute(
        "UPDATE delivery_reminder_deliveries SET status = 'cancelled', updated_at = %s "
        "WHERE schedule_id = %s AND status IN ('pending', 'claimed')",
        (now, updated["id"]),
    )
    return updated


def schedule_complete_for_card(card_id: int, *, actor: str, reason: str = ""):
    """Complete a linked schedule in its own transaction when no card writes."""
    with postgres.cursor() as cur:
        return schedule_complete_for_card_locked(cur, card_id, actor=actor, reason=reason)


def schedule_propose(schedule_id: int, changes: Mapping[str, Any], *, actor: str, reason: str,
                     correlation_id: str = "", expected_revision: int | None = None):
    """Append an agent proposal for an owner commitment without changing truth.

    A proposal is immutable discussion evidence, not an alternate mutable
    schedule.  The owner reviews the proposed fields in the card's schedule
    history and, if they agree, submits a normal compare-and-swap update against
    the then-current revision.  That prevents an old proposal from silently
    overwriting later owner planning.
    """
    fields = {key: changes[key] for key in _MUTABLE_FIELDS if key in changes}
    if len(fields) != len(changes):
        return {"error": "proposal contains unknown delivery fields"}
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM delivery_schedules WHERE id = %s FOR UPDATE", (schedule_id,))
        current = _row(cur.fetchone())
        if not current:
            return {"error": "schedule not found"}
        if expected_revision is not None and current["revision"] != expected_revision:
            return {"conflict": True, "schedule": current}
        err = policy.validate_proposal(current, fields, reason=reason)
        if err:
            return {"error": err}
        _append_event(cur, current, "proposed", actor, reason=reason, before=current,
                      after=fields, correlation_id=correlation_id,
                      metadata={"kind": "owner_commitment_change"})
        return {"schedule": current, "proposed_changes": fields, "revision": current["revision"]}


def schedule_events(schedule_id: int):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM delivery_schedule_events WHERE schedule_id = %s ORDER BY id", (schedule_id,))
        return [dict(row) for row in cur.fetchall()]


def _reminder_key(schedule_id: int, revision: int, reminder_kind: str,
                  recipient_kind: str, recipient_id: str) -> str:
    """Stable key for one logical delivery at one schedule revision.

    This is deliberately derived only from durable identity fields.  A retry or
    scheduler restart must find the same row rather than create a second push
    or wake merely because its calculated due time was recomputed.
    """
    return f"delivery:{schedule_id}:{revision}:{reminder_kind}:{recipient_kind}:{recipient_id or '-'}"


def reminders_materialize_due(*, now: float | None = None, limit: int = 20,
                               actor: str = "scheduler"):
    """Idempotently materialize policy-defined reminders for currently due work.

    A schedule can be returned on every five-second pass; ``reminder_create``'s
    revision-keyed unique id makes the resulting logical delivery stable across
    those passes and across restarts.
    """
    stamp = postgres.now() if now is None else now
    created = []
    for schedule in schedules_due_for_reminders(now=stamp, limit=limit):
        for spec in policy.reminder_specs(schedule, now=stamp):
            reminder = reminder_create(schedule["id"], actor=actor, **spec)
            if reminder and not reminder.get("error"):
                created.append(reminder)
    return created


def reminder_create(schedule_id: int, *, reminder_kind: str, recipient_kind: str,
                    recipient_id: str = "", due_at: float, actor: str = "scheduler"):
    """Create one pending reminder for the schedule's current revision.

    Reminder generation is an idempotent durable operation.  It refuses
    terminal schedules, validates the requested due timestamp, and records the
    current schedule revision in the unique key.  The scheduler may safely call
    this repeatedly after a restart without creating duplicate deliveries.
    """
    if not isinstance(reminder_kind, str) or not reminder_kind.strip():
        return {"error": "reminder_kind is required"}
    if not isinstance(recipient_kind, str) or not recipient_kind.strip():
        return {"error": "recipient_kind is required"}
    if isinstance(due_at, bool) or not isinstance(due_at, (int, float)) or not math.isfinite(due_at):
        return {"error": "due_at must be a finite UTC timestamp"}
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM delivery_schedules WHERE id = %s FOR UPDATE", (schedule_id,))
        schedule = _row(cur.fetchone())
        if not schedule:
            return {"error": "schedule not found"}
        if policy.is_terminal(schedule["status"]):
            return {"error": "terminal schedules do not create reminders"}
        revision = schedule["revision"]
        key = _reminder_key(schedule_id, revision, reminder_kind.strip(), recipient_kind.strip(), recipient_id or "")
        now = postgres.now()
        cur.execute(
            "INSERT INTO delivery_reminder_deliveries("
            "schedule_id,schedule_revision,reminder_kind,recipient_kind,recipient_id,due_at,status,"
            "idempotency_key,created_at,updated_at) VALUES(%s,%s,%s,%s,%s,%s,'pending',%s,%s,%s) "
            "ON CONFLICT (idempotency_key) DO NOTHING RETURNING *",
            (schedule_id, revision, reminder_kind.strip(), recipient_kind.strip(), recipient_id or "", due_at,
             key, now, now),
        )
        created = _row(cur.fetchone())
        if created:
            _append_event(cur, schedule, "reminder_created", actor,
                          metadata={"reminder_id": created["id"], "kind": reminder_kind.strip(),
                                    "recipient_kind": recipient_kind.strip()})
            return created
        cur.execute("SELECT * FROM delivery_reminder_deliveries WHERE idempotency_key = %s", (key,))
        return _row(cur.fetchone())


def reminders_claim_due(*, now: float | None = None, lease_seconds: int = 60, limit: int = 20):
    """Atomically lease due, current, nonterminal reminder rows.

    ``FOR UPDATE SKIP LOCKED`` lets concurrent scheduler passes share work.  A
    join to the current schedule blocks rows made stale by reschedule or card
    completion even if an old pending row survived an interrupted process.
    """
    if isinstance(lease_seconds, bool) or not isinstance(lease_seconds, int) or lease_seconds <= 0:
        raise ValueError("lease_seconds must be a positive integer")
    if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
        raise ValueError("limit must be a positive integer")
    stamp = postgres.now() if now is None else now
    with postgres.cursor() as cur:
        cur.execute(
            "WITH due AS ("
            " SELECT r.id FROM delivery_reminder_deliveries r "
            " JOIN delivery_schedules s ON s.id = r.schedule_id "
            " WHERE r.status = 'pending' AND r.due_at <= %s "
            "   AND r.schedule_revision = s.revision "
            "   AND s.status NOT IN ('completed','cancelled','archived') "
            " ORDER BY r.due_at, r.id FOR UPDATE OF r SKIP LOCKED LIMIT %s"
            ") UPDATE delivery_reminder_deliveries r SET status = 'claimed', lease_until = %s, "
            "attempts = attempts + 1, updated_at = %s FROM due WHERE r.id = due.id RETURNING r.*",
            (stamp, limit, stamp + lease_seconds, stamp),
        )
        return [dict(row) for row in cur.fetchall()]


def reminder_recover_expired_claims(*, now: float | None = None) -> int:
    """Return abandoned claims to pending, or suppress them if truth changed."""
    stamp = postgres.now() if now is None else now
    with postgres.cursor() as cur:
        cur.execute(
            "UPDATE delivery_reminder_deliveries r SET status = CASE "
            " WHEN s.status IN ('completed','cancelled','archived') OR r.schedule_revision <> s.revision "
            " THEN 'cancelled' ELSE 'pending' END, lease_until = 0, updated_at = %s "
            "FROM delivery_schedules s WHERE r.schedule_id = s.id "
            "AND r.status = 'claimed' AND r.lease_until <= %s",
            (stamp, stamp),
        )
        return cur.rowcount


def reminder_finish(reminder_id: int, *, outcome: str, error: str = "", now: float | None = None):
    """Complete a lease only if its revision is still current and deliverable."""
    if outcome not in {"delivered", "suppressed", "failed"}:
        return {"error": "unknown reminder outcome"}
    stamp = postgres.now() if now is None else now
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT r.*, s.revision AS current_revision, s.status AS schedule_status "
            "FROM delivery_reminder_deliveries r JOIN delivery_schedules s ON s.id = r.schedule_id "
            "WHERE r.id = %s FOR UPDATE OF r, s",
            (reminder_id,),
        )
        reminder = _row(cur.fetchone())
        if not reminder:
            return {"error": "reminder not found"}
        if reminder["status"] != "claimed":
            return {"error": "reminder is not claimed"}
        valid = reminder["schedule_revision"] == reminder["current_revision"] and not policy.is_terminal(reminder["schedule_status"])
        status = outcome if valid else "cancelled"
        cur.execute(
            "UPDATE delivery_reminder_deliveries SET status = %s, lease_until = 0, last_error = %s, "
            "updated_at = %s, delivered_at = CASE WHEN %s = 'delivered' THEN %s ELSE delivered_at END "
            "WHERE id = %s RETURNING *",
            (status, error or "", stamp, status, stamp, reminder_id),
        )
        return _row(cur.fetchone())
