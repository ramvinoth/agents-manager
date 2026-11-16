"""Durable, single-use confirmation records for consequential Call-mode work.

A phone transcript is not authorization.  Before Callbrain may perform a
consequential operation, the server stores one opaque command bound to the
resolved caller and call session.  A later explicit confirmation must consume
that exact record.  The operation adapter rereads its authority and passes a
small current source-state fingerprint to ``consume``; a changed revision,
status, or target rejects the request before any write runs.

This module deliberately does *not* execute operations.  It owns the durable
confirmation lifecycle only.  Board, delivery and integration actions retain
their existing authorization and audit boundaries.
"""
from __future__ import annotations

import json
import secrets
from typing import Any, Mapping

from orchestrator.shared import postgres

DEFAULT_TTL_SECONDS = 120
MAX_TTL_SECONDS = 300
MAX_OPERATION_CHARS = 80
MAX_JSON_BYTES = 8_192


def _row(row):
    if not row:
        return None
    result = dict(row)
    for key in ("arguments", "source_state"):
        value = result.get(key)
        if isinstance(value, str):
            try:
                result[key] = json.loads(value)
            except ValueError:
                result[key] = {}
    return result


def _canonical(value: Mapping[str, Any]) -> str:
    """Bound and canonicalize an opaque JSON fingerprint or argument object."""
    if not isinstance(value, Mapping):
        raise ValueError("command data must be an object")
    try:
        encoded = json.dumps(value, separators=(",", ":"), sort_keys=True,
                             ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError("command data must be JSON-safe") from exc
    if len(encoded.encode("utf-8")) > MAX_JSON_BYTES:
        raise ValueError("command data is too large")
    return encoded


def _ttl(value: int | None) -> int:
    if value is None:
        return DEFAULT_TTL_SECONDS
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_TTL_SECONDS:
        raise ValueError("confirmation expiry must be between 1 and 300 seconds")
    return value


def prepare(*, caller: str, call_session_id: str, operation: str,
            arguments: Mapping[str, Any], source_state: Mapping[str, Any],
            ttl_seconds: int | None = None, correlation_id: str = "") -> dict[str, Any]:
    """Store one pending confirmation and safely supersede older pending commands.

    ``caller`` and ``call_session_id`` come from the server-resolved principal
    and call route, never from model tool arguments.  ``source_state`` contains
    only durable identifiers/revisions/statuses, never free message bodies.
    """
    caller = str(caller or "").strip()
    call_session_id = str(call_session_id or "").strip()
    operation = str(operation or "").strip()
    if not caller or not call_session_id:
        raise ValueError("caller and call session are required")
    if not operation or len(operation) > MAX_OPERATION_CHARS:
        raise ValueError("operation is required and must be at most 80 characters")
    args_json = _canonical(arguments)
    source_json = _canonical(source_state)
    now = postgres.now()
    expires_at = now + _ttl(ttl_seconds)
    command_id = secrets.token_urlsafe(24)
    with postgres.cursor() as cur:
        # A caller can have only one outstanding confirmation per call session.
        # Replacing it prevents a delayed "yes" from executing an earlier request.
        cur.execute(
            "UPDATE call_pending_commands SET status = 'superseded', resolved_at = %s "
            "WHERE caller = %s AND call_session_id = %s AND status = 'pending'",
            (now, caller, call_session_id),
        )
        cur.execute(
            "INSERT INTO call_pending_commands("
            "id,caller,call_session_id,operation,arguments,source_state,correlation_id,"
            "status,created_at,expires_at) VALUES(%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s,"
            "'pending',%s,%s) RETURNING *",
            (command_id, caller, call_session_id, operation, args_json, source_json,
             str(correlation_id or "")[:120], now, expires_at),
        )
        return _row(cur.fetchone()) or {}


def get_pending(command_id: str, *, caller: str, call_session_id: str) -> dict[str, Any] | None:
    """Return this caller's still-pending command for a source reread.

    This is deliberately not a generic command-dispatch API. Callbrain uses it
    only to select the named source-specific reread for a supported operation;
    it hides rows owned by another caller or call session.
    """
    command_id = str(command_id or "").strip()
    if not command_id:
        return None
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM call_pending_commands WHERE id = %s", (command_id,))
        command = _row(cur.fetchone())
    if not command or command.get("caller") != caller or command.get("call_session_id") != call_session_id:
        return None
    return command if command.get("status") == "pending" else None


def consume(command_id: str, *, caller: str, call_session_id: str,
            current_source_state: Mapping[str, Any]) -> dict[str, Any]:
    """Atomically consume a matching, current pending command exactly once.

    The caller must reread the source of truth immediately before this call and
    provide its normalized identifier/revision/status fingerprint.  A mismatch
    makes the confirmation unusable instead of applying an old spoken intent.
    The trusted operation adapter still enforces its own compare-and-swap or
    authorization rules when it executes the returned command.
    """
    command_id = str(command_id or "").strip()
    if not command_id:
        return {"error": "confirmation is required"}
    try:
        current_json = _canonical(current_source_state)
    except ValueError as exc:
        return {"error": str(exc)}
    now = postgres.now()
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM call_pending_commands WHERE id = %s FOR UPDATE", (command_id,))
        command = _row(cur.fetchone())
        # Do not expose whether another caller has a pending command.
        if not command or command.get("caller") != caller or command.get("call_session_id") != call_session_id:
            return {"error": "confirmation is unavailable"}
        if command.get("status") != "pending":
            return {"error": "confirmation was already used or replaced"}
        if float(command.get("expires_at") or 0) <= now:
            cur.execute("UPDATE call_pending_commands SET status = 'expired', resolved_at = %s WHERE id = %s",
                        (now, command_id))
            return {"error": "confirmation expired"}
        if _canonical(command.get("source_state") or {}) != current_json:
            cur.execute("UPDATE call_pending_commands SET status = 'stale', resolved_at = %s WHERE id = %s",
                        (now, command_id))
            return {"error": "the item changed; please ask again"}
        cur.execute("UPDATE call_pending_commands SET status = 'consumed', resolved_at = %s "
                    "WHERE id = %s AND status = 'pending'", (now, command_id))
        if cur.rowcount != 1:
            return {"error": "confirmation was already used or replaced"}
        return {"command": command}
