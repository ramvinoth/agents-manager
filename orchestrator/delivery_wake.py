"""Delivery reminder adapter for the existing durable one-shot scheduler.

A delivery reminder is committed by ``delivery_repository`` before this module is
called.  This adapter never starts a process directly: it creates a namespaced,
revision-bound one-shot loop, allowing the ordinary scheduler to preserve its
busy-session deferral and job-run audit behavior.
"""
from __future__ import annotations

import hashlib

from typing import Any, Mapping

from orchestrator import boardwatch, loops
from orchestrator.config import CHAT_JOBS, CHAT_LOCK, transcript_path


def wake_id(reminder: Mapping[str, Any]) -> str:
    """Return a bounded, collision-resistant logical wake identity.

    ``loops.id`` is an unconstrained opaque key. Hashing the recipient/purpose
    avoids leaking a session id into that shared scheduler table and makes a
    maliciously long id unable to create oversized rows. The preimage remains
    revision-bound schedule identity, so retries coalesce while a reschedule
    receives a distinct wake.
    """
    schedule_id = int(reminder["schedule_id"])
    revision = int(reminder["schedule_revision"])
    purpose = str(reminder.get("reminder_kind") or "due")
    recipient = str(reminder.get("recipient_id") or "-").strip() or "-"
    identity = f"{schedule_id}\x1f{revision}\x1f{purpose}\x1f{recipient}".encode()
    return f"dw:{schedule_id}:{revision}:{hashlib.sha256(identity).hexdigest()[:20]}"


def _session_running(session_id: str) -> bool:
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        return bool(job and job.get("running"))


def schedule_delivery_wake(schedule: Mapping[str, Any], reminder: Mapping[str, Any]) -> tuple[bool, str]:
    """Queue a harman-origin delivery wake after caller-side gate checks.

    ``False`` outcomes are intentionally precise so the scheduler can persist a
    durable suppressed result rather than creating a loop guaranteed to fail.
    """
    session_id = str(reminder.get("recipient_id") or schedule.get("owner_session_id") or "").strip()
    if not session_id:
        return False, "stranded_missing_session"
    if _session_running(session_id):
        return False, "agent_already_running"
    if not transcript_path(session_id):
        return False, "stranded_missing_session"

    card_id = int(schedule["card_id"])
    title = str(schedule.get("card_title") or "").strip()
    due_at = reminder.get("due_at")
    prompt = (
        f"[delivery-reminder] Schedule {schedule['id']} for card {card_id}"
        f"{f' \"{title}\"' if title else ''} reached its delivery boundary at {due_at}. "
        "Re-read the card and current delivery schedule before acting. The reminder is advisory: "
        "do not assume its original timing or status remains current, and do not silently reschedule, "
        "complete, delete, or reassign work. Report the present blocker or next step on the card."
    )
    boardwatch.schedule_once(wake_id(reminder), session_id, prompt, loops.AGENT_ORIGIN)
    return True, "agent_wake_queued"
