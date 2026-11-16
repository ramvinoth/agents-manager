"""Pure policy for Harman's internal delivery schedules.

This module deliberately knows nothing about Postgres, APNs, loops or HTTP.  The
repository owns durable compare-and-swap writes; routes and MCP turn civil-time
input into canonical timestamps; this module says which schedule facts are valid
and who may change them.  Keeping those decisions here prevents a calendar view,
a scheduler tick and an agent action from quietly inventing different rules.
"""
from __future__ import annotations

import math
from typing import Any, Mapping
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

STATUSES = frozenset({"planned", "active", "blocked", "at_risk", "completed", "cancelled", "archived"})
TERMINAL_STATUSES = frozenset({"completed", "cancelled", "archived"})
PRIORITIES = frozenset({"critical", "high", "normal", "low"})

# A state is intentionally not inferred from a Kanban column. The board remains
# the work ledger; the delivery record explains timing and recovery.
_TRANSITIONS = {
    "planned": frozenset({"active", "blocked", "at_risk", "completed", "cancelled", "archived"}),
    "active": frozenset({"planned", "blocked", "at_risk", "completed", "cancelled", "archived"}),
    "blocked": frozenset({"planned", "active", "at_risk", "completed", "cancelled", "archived"}),
    "at_risk": frozenset({"planned", "active", "blocked", "completed", "cancelled", "archived"}),
    "completed": frozenset({"archived"}),
    "cancelled": frozenset({"archived"}),
    "archived": frozenset(),
}

_TIME_FIELDS = frozenset({"starts_at", "due_at", "timezone", "all_day"})

# Runtime reminder policy is intentionally small for the first dispatch slice:
# one owner attention item and, when a schedule names a session, one agent wake
# at the due boundary.  Lead-time and escalation cadences are product policy,
# not scheduler heuristics, and must be added here with their own durable key.
REMINDER_DUE = "due"
RECIPIENT_OWNER_PUSH = "owner_push"
RECIPIENT_AGENT_WAKE = "agent_wake"
RUNTIME_RECIPIENT_KINDS = frozenset({RECIPIENT_OWNER_PUSH, RECIPIENT_AGENT_WAKE})

# Dispatch is advisory: delivery means APNs accepted an owner notification or the
# durable one-shot wake was queued, never that a device received it or an agent
# completed work.  Only transport/queue failures retry.  Policy suppressions are
# final for the revision so restoring automation cannot replay a pause backlog.
RETRY_MAX_ATTEMPTS = 3
RETRY_DELAYS_SECONDS = (15, 60)


def retry_delay(attempts: Any) -> float | None:
    """Return the bounded delay after a failed claimed attempt.

    ``attempts`` is incremented while a row is claimed.  A first failed claim
    therefore retries in 15 seconds, a second in 60, and the third is terminal.
    Keeping this pure makes the database transaction and TLA model share one
    deterministic contract.
    """
    if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts <= 0:
        return None
    if attempts >= RETRY_MAX_ATTEMPTS:
        return None
    return float(RETRY_DELAYS_SECONDS[attempts - 1])


def retry_eligible(reminder: Mapping[str, Any], *, now: float) -> bool:
    """Whether a pending durable reminder is eligible for another claim."""
    if reminder.get("status") != "pending":
        return False
    due = reminder.get("next_attempt_at")
    if due is None:
        due = reminder.get("due_at")
    return (isinstance(due, (int, float)) and not isinstance(due, bool)
            and math.isfinite(due) and due <= now)


def is_terminal(status: str | None) -> bool:
    return status in TERMINAL_STATUSES


def priority_rank(priority: str) -> int:
    """Lower is more urgent, suitable for a stable agenda/timeline sort."""
    return {"critical": 0, "high": 1, "normal": 2, "low": 3}.get(priority, 99)


def reminder_specs(schedule: Mapping[str, Any], *, now: float) -> tuple[dict[str, Any], ...]:
    """Return deterministic due-boundary reminders for current schedule facts.

    This is deliberately pure: it never decides whether a recipient can actually
    run, and it does not infer a deadline. The repository binds each returned
    specification to the current revision when it creates the durable row.
    """
    if is_terminal(schedule.get("status")):
        return ()
    due_at = schedule.get("due_at")
    if isinstance(due_at, bool) or not isinstance(due_at, (int, float)) or not math.isfinite(due_at):
        return ()
    if due_at > now:
        return ()
    specs = [{
        "reminder_kind": REMINDER_DUE,
        "recipient_kind": RECIPIENT_OWNER_PUSH,
        "recipient_id": "",
        "due_at": float(due_at),
    }]
    session_id = str(schedule.get("owner_session_id") or "").strip()
    if session_id:
        specs.append({
            "reminder_kind": REMINDER_DUE,
            "recipient_kind": RECIPIENT_AGENT_WAKE,
            "recipient_id": session_id,
            "due_at": float(due_at),
        })
    return tuple(specs)


def classify_delivery(schedule: Mapping[str, Any], reminder: Mapping[str, Any], *,
                      now: float, autonomous: bool, session_viable: bool,
                      session_running: bool) -> tuple[str, str]:
    """Classify one claimed delivery without changing schedule truth.

    Returns ``(outcome, reason_code)`` where outcome is accepted by
    ``reminder_finish``.  A paused agent reminder is suppressed rather than
    deferred, which prevents a resume-time catch-up burst.
    """
    if is_terminal(schedule.get("status")):
        return "suppressed", "terminal_schedule"
    due_at = schedule.get("due_at")
    if not isinstance(due_at, (int, float)) or isinstance(due_at, bool):
        return "suppressed", "no_due_boundary"
    kind = str(reminder.get("recipient_kind") or "")
    if kind == RECIPIENT_OWNER_PUSH:
        return "delivered", "owner_attention"
    if kind != RECIPIENT_AGENT_WAKE:
        return "suppressed", "unknown_recipient"
    if not autonomous:
        return "suppressed", "automation_paused"
    if not session_viable:
        return "suppressed", "stranded_missing_session"
    if session_running:
        return "suppressed", "agent_already_running"
    return "delivered", "agent_wake_queued"


def validate_timezone(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return "timezone is required"
    try:
        ZoneInfo(value)
    except ZoneInfoNotFoundError:
        return "timezone must be a valid IANA timezone"
    return None


def _timestamp(value: Any, name: str) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return f"{name} must be a finite UTC timestamp"
    return None


def validate_schedule_fields(fields: Mapping[str, Any], *, creating: bool = False) -> str | None:
    """Validate persisted schedule values without coercion.

    Callers must normalize civil input before reaching this boundary.  A missing
    field means "leave it alone" on an update, while a present ``None`` clears
    a nullable timestamp deliberately.
    """
    if creating or "timezone" in fields:
        err = validate_timezone(fields.get("timezone"))
        if err:
            return err
    for name in ("starts_at", "due_at"):
        if name in fields:
            err = _timestamp(fields[name], name)
            if err:
                return err
    if "all_day" in fields and not isinstance(fields["all_day"], bool):
        return "all_day must be boolean"
    if "estimated_duration_sec" in fields:
        value = fields["estimated_duration_sec"]
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value <= 0):
            return "estimated_duration_sec must be a positive integer"
    if "priority" in fields and fields["priority"] not in PRIORITIES:
        return "priority must be critical, high, normal or low"
    if "status" in fields and fields["status"] not in STATUSES:
        return "unknown delivery status"
    if "owner_commitment" in fields and not isinstance(fields["owner_commitment"], bool):
        return "owner_commitment must be boolean"
    return None


def validate_schedule_shape(current: Mapping[str, Any], changes: Mapping[str, Any]) -> str | None:
    """Validate the complete resulting shape after a partial update."""
    merged = dict(current)
    merged.update(changes)
    err = validate_schedule_fields(merged, creating=True)
    if err:
        return err
    starts_at, due_at = merged.get("starts_at"), merged.get("due_at")
    if starts_at is not None and due_at is not None and starts_at > due_at:
        return "starts_at must not be after due_at"
    # All-day work is represented as timezone-aware logical-day boundaries at
    # the route edge. Requiring a due boundary stops a bare boolean from
    # silently acquiring an arbitrary time of day.
    if merged.get("all_day") and due_at is None:
        return "all_day schedules require a due_at day boundary"
    return None


def transition_allowed(before: str, after: str) -> bool:
    return before == after or after in _TRANSITIONS.get(before, frozenset())


def mutation_authority(current: Mapping[str, Any] | None, changes: Mapping[str, Any], *, actor_kind: str) -> str:
    """Return ``apply`` or ``propose`` for a requested mutation.

    Only an explicit owner action can alter timing semantics, terminal state or
    commitment itself for an owner commitment. Agents can still propose the
    exact change; the proposal is a separate durable event, not a covert write.
    """
    if actor_kind == "owner":
        return "apply"
    if not current or not current.get("owner_commitment"):
        return "apply"
    if _TIME_FIELDS.intersection(changes) or "status" in changes or "owner_commitment" in changes:
        return "propose"
    return "apply"


def validate_proposal(current: Mapping[str, Any], changes: Mapping[str, Any], *, reason: str = "") -> str | None:
    """Validate an agent's requested owner-commitment change without applying it.

    A proposal has to be meaningful enough that the owner can apply the exact
    same change later: it uses the resulting-shape and transition checks, but
    does not advance the schedule revision or alter reminder truth.  It is
    intentionally narrow.  An agent may propose timing or status, not remove
    the commitment flag that gives the owner control of those facts.
    """
    if not current.get("owner_commitment"):
        return "only owner commitments need a delivery proposal"
    if not changes:
        return "no delivery fields to propose"
    if "owner_commitment" in changes:
        return "an agent cannot propose changing owner commitment semantics"
    if not (_TIME_FIELDS.intersection(changes) or "status" in changes):
        return "proposals must change timing or delivery status"
    err = validate_schedule_shape(current, changes)
    if err:
        return err
    after = changes.get("status", current.get("status", "planned"))
    if not transition_allowed(current.get("status", "planned"), after):
        return f"delivery schedule cannot move from {current.get('status', 'planned')} to {after}"
    if not str(reason).strip():
        return "delivery proposals require a reason"
    return None


def validate_recovery(current: Mapping[str, Any], changes: Mapping[str, Any], *,
                      actor_kind: str, reason: str = "") -> str | None:
    """Validate an explicit replacement plan after completed/cancelled work.

    Reopening a board card must not quietly revive an old deadline. Recovery is
    therefore a named lifecycle action which requires a reason and a newly
    supplied due boundary. Archived history is final in v1; cancelling work is
    reversible, deleting its audit history is not.
    """
    if current.get("status") not in {"completed", "cancelled"}:
        return "only completed or cancelled delivery schedules can be recovered"
    if current.get("owner_commitment") and actor_kind != "owner":
        return "owner commitment recovery requires an owner action"
    if not str(reason).strip():
        return "delivery recovery requires a reason"
    if "due_at" not in changes or changes.get("due_at") is None:
        return "delivery recovery requires an explicit due_at"
    after = changes.get("status", "planned")
    if after not in {"planned", "active"}:
        return "delivery recovery must set status to planned or active"
    err = validate_schedule_shape(current, {**changes, "status": after})
    if err:
        return err
    return None


def validate_mutation(current: Mapping[str, Any] | None, changes: Mapping[str, Any], *, actor_kind: str,
                      reason: str = "") -> str | None:
    """Validate a state mutation after the caller has resolved its actor."""
    err = validate_schedule_shape(current or {}, changes)
    if err:
        return err
    if not current and actor_kind != "owner" and changes.get("owner_commitment"):
        return "only an owner may create an owner commitment"
    if current:
        before, after = current.get("status", "planned"), changes.get("status", current.get("status", "planned"))
        if not transition_allowed(before, after):
            return f"delivery schedule cannot move from {before} to {after}"
        protected = bool(current.get("owner_commitment")) and (
            _TIME_FIELDS.intersection(changes) or "status" in changes or "owner_commitment" in changes
        )
        if protected and actor_kind != "owner":
            return "owner commitment changes require an owner action; record a proposal instead"
        if protected and not str(reason).strip():
            return "owner commitment changes require a reason"
    return None
