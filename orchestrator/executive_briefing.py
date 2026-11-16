"""Bounded, privacy-safe executive briefing composed from live authorities.

This module owns no delivery, mail, calendar, inbox or decision state.  It
reads the existing authorities when asked and returns a small typed projection
for Call mode and future authenticated clients.  A source that cannot be read
remains unavailable; it never becomes a misleading zero.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any, Callable, Mapping
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from orchestrator import db, delivery_policy, delivery_repository, inbox, queue
from orchestrator.integrations import service_access

MAX_DELIVERY_ITEMS = 5
MAX_INBOX_ITEMS = 5
MAX_DECISION_ITEMS = 3
MAX_GMAIL_ITEMS = 5
MAX_CALENDAR_ITEMS = 3
TEXT_LIMIT = 120
# A phone turn must not inherit the 60-second vendor default. Each source is
# optional, so timing it out must degrade only that source to "unavailable".
VENDOR_TIMEOUT = 3


@dataclass(frozen=True)
class SourceState:
    state: str
    error: str = ""

    def as_dict(self) -> dict[str, str]:
        return asdict(self)


def _clip(value: Any, limit: int = TEXT_LIMIT) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def _source(read: Callable[[], Any]) -> tuple[SourceState, Any]:
    try:
        return SourceState("available"), read()
    except Exception as exc:
        # Vendor and database error wording can contain account names or request
        # fragments. The briefing only needs to know that source is unavailable.
        return SourceState("unavailable", _clip(type(exc).__name__, 60)), None


def _delivery_item(schedule: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "schedule_id": int(schedule["id"]),
        "card_id": int(schedule["card_id"]),
        "status": schedule.get("status") or "planned",
        "priority": schedule.get("priority") or "normal",
        "due_at": schedule.get("due_at"),
        "starts_at": schedule.get("starts_at"),
        "timezone": schedule.get("timezone") or "UTC",
        "all_day": bool(schedule.get("all_day")),
        "owner_commitment": bool(schedule.get("owner_commitment")),
        "revision": int(schedule.get("revision") or 0),
    }


def _delivery_boundary(item: Mapping[str, Any]) -> str:
    """Render a due boundary in the schedule's own timezone for Call mode.

    The stored epoch is canonical, but saying it raw makes an all-day schedule
    ambiguous and can move the apparent date across a UTC boundary.
    """
    due_at = item.get("due_at")
    if due_at is None:
        return "no due time"
    try:
        zone = ZoneInfo(str(item.get("timezone") or "UTC"))
    except ZoneInfoNotFoundError:
        zone = ZoneInfo("UTC")
    when = datetime.fromtimestamp(float(due_at), zone)
    if item.get("all_day"):
        return "all day %s" % when.date().isoformat()
    return when.strftime("%Y-%m-%d %-I:%M %p %Z")


def _delivery_agenda(project_id: int | None) -> list[dict[str, Any]]:
    rows = delivery_repository.schedule_list(project_id)
    rows.sort(key=lambda row: (
        row.get("due_at") is None,
        row.get("due_at") or float("inf"),
        delivery_policy.priority_rank(row.get("priority") or "normal"),
        row.get("id") or 0,
    ))
    return [_delivery_item(row) for row in rows[:MAX_DELIVERY_ITEMS]]


def _inbox_summary(rows: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    # The free-message body is intentionally excluded. Decision summaries are
    # already bounded cold-reader labels from their durable sources.
    result = []
    for row in rows[:MAX_INBOX_ITEMS]:
        item = {"id": int(row["id"]), "kind": row.get("kind") or "message",
                "created_at": row.get("created_at"), "status": row.get("status") or "sent"}
        if item["kind"] != "message":
            item["summary"] = _clip(row.get("summary") or row.get("ref_id"))
        result.append(item)
    return result


def _decision_summary(items: list[Mapping[str, Any]], cap: int) -> dict[str, Any]:
    view = inbox.visible_queue(items, cap)
    return {"visible": [
        {"kind": item.get("kind") or "", "summary": _clip(item.get("summary")),
         "waiting_s": int(item.get("waiting_s") or 0)}
        for item in view["decisions"][:MAX_DECISION_ITEMS]
    ], "shown": view["count"], "held": view["held"], "cap": view["cap"]}


def _gmail_summary(client) -> list[dict[str, Any]]:
    # Search metadata is projected again so snippets cannot reach a call prompt.
    reply = client.search("in:inbox is:unread", MAX_GMAIL_ITEMS, timeout=VENDOR_TIMEOUT)
    return [{"id": _clip(row.get("id"), 80), "from": _clip(row.get("from")),
             "subject": _clip(row.get("subject")), "date": _clip(row.get("date"), 60)}
            for row in (reply.get("messages") or [])[:MAX_GMAIL_ITEMS]]


def _calendar_summary(client, start: str = "", end: str = "") -> list[dict[str, Any]]:
    # The vendor response contains location, description and attendees. None of
    # those are carried into the default executive projection.
    reply = client.events(start, end, "", "primary", MAX_CALENDAR_ITEMS, timeout=VENDOR_TIMEOUT)
    return [{"id": _clip(row.get("id"), 80), "title": _clip(row.get("title")),
             "start": _clip(row.get("start"), 60), "end": _clip(row.get("end"), 60),
             "all_day": bool(row.get("all_day"))}
            for row in (reply.get("events") or [])[:MAX_CALENDAR_ITEMS]]


def current(*, project_id: int | None, include_delivery: bool = True,
            gmail_connection: str | None = None, calendar_connection: str | None = None,
            calendar_start: str = "", calendar_end: str = "") -> dict[str, Any]:
    """Compose a live briefing with source availability preserved independently."""
    inbox_state, inbox_rows = _source(lambda: db.inbox_list(limit=MAX_INBOX_ITEMS))
    decision_state, decision_data = _source(
        lambda: (queue.open_items(materialize_missing_red=False), queue.cap()))
    decisions, decision_cap = decision_data if decision_data is not None else ([], 0)
    result = build(project_id=project_id, include_delivery=include_delivery,
                   inbox_rows=inbox_rows or [], decisions=decisions, decision_cap=decision_cap,
                   gmail_connection=gmail_connection, calendar_connection=calendar_connection,
                   calendar_start=calendar_start, calendar_end=calendar_end)
    if inbox_state.state != "available":
        result["inbox"] = {"source": inbox_state.as_dict(), "items": []}
    if decision_state.state != "available":
        result["decisions"] = {"source": decision_state.as_dict(), "visible": [],
                               "shown": 0, "held": 0, "cap": 0}
    return result


def render_call_facts(briefing: Mapping[str, Any]) -> str:
    """A compact, source-state-aware projection for an untrusted model prompt.

    This is intentionally less detailed than the authenticated JSON briefing:
    it gives the call model counts and schedule boundaries, never mail senders or
    subjects, calendar titles, inbox bodies, or decision payloads.
    """
    lines = []
    delivery = briefing["delivery"]
    if delivery["source"]["state"] == "available":
        items = delivery["items"]
        if items:
            named = "; ".join(
                f"card {item['card_id']} due {_delivery_boundary(item)} ({item['priority']})"
                for item in items[:MAX_DELIVERY_ITEMS]
            )
            lines.append("Delivery agenda: " + named + ".")
        else:
            lines.append("Delivery agenda: no active scheduled work.")
    else:
        lines.append("Delivery agenda is unavailable.")

    inbox_state = briefing["inbox"]["source"]["state"]
    lines.append("Inbox: %s recent owner-facing items." % len(briefing["inbox"]["items"])
                 if inbox_state == "available" else "Inbox is unavailable.")
    decisions = briefing["decisions"]
    lines.append("Decision queue: %s visible, %s held." % (decisions["shown"], decisions["held"])
                 if decisions["source"]["state"] == "available" else "Decision queue is unavailable.")
    gmail = briefing["gmail"]
    lines.append("Gmail: %s unread messages in the bounded check." % len(gmail["items"])
                 if gmail["source"]["state"] == "available" else "Gmail is unavailable.")
    calendar = briefing["calendar"]
    if calendar["source"]["state"] == "available":
        lines.append("Calendar: %s upcoming events in the bounded check." % len(calendar["items"]))
    else:
        lines.append("Calendar is unavailable.")
    return "\n".join(lines)


def _vendor_sources(gmail_connection: str | None, calendar_connection: str | None,
                    calendar_start: str, calendar_end: str) -> tuple[tuple[SourceState, Any],
                                                                        tuple[SourceState, Any]]:
    """Read optional vendors concurrently so one cannot delay the other."""
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="executive-briefing") as pool:
        gmail = pool.submit(_source, lambda: _gmail_summary(
            service_access.open_client("google.gmail", "read", connection_id=gmail_connection)[0]))
        calendar = pool.submit(_source, lambda: _calendar_summary(
            service_access.open_client("google.calendar", "read", connection_id=calendar_connection)[0],
            calendar_start, calendar_end))
        return gmail.result(), calendar.result()


def build(*, project_id: int | None, inbox_rows: list[Mapping[str, Any]],
          decisions: list[Mapping[str, Any]], decision_cap: int, include_delivery: bool | None = None,
          gmail_connection: str | None = None, calendar_connection: str | None = None,
          calendar_start: str = "", calendar_end: str = "") -> dict[str, Any]:
    """Build the read-only executive briefing from current authoritative readers.

    Callers supply inbox/decision rows so they can choose an explicitly
    side-effect-free reader. In particular this function does not call
    ``queue.open_items()``, which may materialize missing Red approval inbox
    rows. Integration clients always use the agent-like grant boundary.
    """
    include_delivery = project_id is not None if include_delivery is None else include_delivery
    delivery_state, delivery = (_source(lambda: _delivery_agenda(project_id))
                                if include_delivery else (SourceState("available"), []))
    (gmail_state, gmail), (calendar_state, calendar) = _vendor_sources(
        gmail_connection, calendar_connection, calendar_start, calendar_end)
    return {
        "delivery": {"source": delivery_state.as_dict(), "items": delivery or []},
        "inbox": {"source": SourceState("available").as_dict(), "items": _inbox_summary(inbox_rows)},
        "decisions": {"source": SourceState("available").as_dict(),
                      **_decision_summary(decisions, decision_cap)},
        "gmail": {"source": gmail_state.as_dict(), "items": gmail or []},
        "calendar": {"source": calendar_state.as_dict(), "items": calendar or []},
    }
