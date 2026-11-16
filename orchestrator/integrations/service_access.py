"""Shared, non-HTTP access boundary for connected Gmail and Google Calendar.

Interactive app routes retain their owner/grant semantics.  Agent-like callers
(Call mode and MCP compositions) use this module instead: every operation goes
through ``catalog.pick_connection(..., op=...)`` so a caller cannot silently
choose another account or bypass the owner's per-operation switch.
"""
from __future__ import annotations

from typing import Any

from orchestrator import db, workspace
from orchestrator.integrations import catalog


_CLIENTS = {
    "google.gmail": workspace.Gmail,
    "google.calendar": workspace.Calendar,
}


def open_client(service_id: str, operation: str, *, connection_id: str | None = None,
                connections: list[dict[str, Any]] | None = None):
    """Return the explicitly authorized vendor client for an agent-like caller.

    ``operation`` is mandatory.  Passing it to ``pick_connection`` is the
    important distinction from the app's human route: a granted account alone
    is insufficient when the owner has disabled that agent operation.
    """
    client_type = _CLIENTS.get(service_id)
    if client_type is None:
        raise catalog.IntegrationError("No shared client for %s" % service_id, 400)
    catalog.op_spec(service_id, operation)
    available = connections if connections is not None else list(db.drives_load().values())
    connection = catalog.pick_connection(available, service_id, connection_id, op=operation)
    return client_type(connection), connection
