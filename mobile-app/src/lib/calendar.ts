// Calendar — the pure half of the Calendar screen. The server (viewer/workspace.Calendar)
// speaks Google's shapes: a timed event's start/end are RFC 3339 datetimes, an
// all-day event's are YYYY-MM-DD dates with an EXCLUSIVE end (a one-day event
// on Oct 5 ends "2026-10-06"). This module turns those into an agenda and back
// into the fields an editor sends, so no screen does date arithmetic.
import type { CalendarEvent, EventFields, IntegrationsView, ServiceState } from "../api/client"

export const CALENDAR_SERVICE = "google.calendar"

const pad = (n: number) => String(n).padStart(2, "0")

/** YYYY-MM-DD of a Date in LOCAL time (toISOString would use UTC). */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** A YYYY-MM-DD date as local midnight (`new Date("2026-10-05")` is UTC midnight). */
export function parseDate(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number)
  return new Date(y, m - 1, d)
}

/** A Date as RFC 3339 with the device's offset, e.g. 2026-10-05T09:00:00-07:00. */
export function isoLocal(d: Date): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? "+" : "-"
  const a = Math.abs(off)
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes())

/** The local day an event belongs to in the agenda (its start day). */
export function dayOf(e: CalendarEvent): string {
  return e.all_day ? e.start.slice(0, 10) : localDate(new Date(e.start))
}

export function dayLabel(day: string, now: Date): string {
  const today = localDate(now)
  if (day === today) return "Today"
  if (day === localDate(addDays(now, 1))) return "Tomorrow"
  return parseDate(day).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
}

export type AgendaDay = { day: string; label: string; events: CalendarEvent[] }

/** Events grouped by start day, days and events in time order; all-day first. */
export function agenda(events: CalendarEvent[], now: Date): AgendaDay[] {
  const by = new Map<string, CalendarEvent[]>()
  for (const e of events) {
    if (e.status === "cancelled") continue
    const k = dayOf(e)
    by.set(k, [...(by.get(k) || []), e])
  }
  const key = (e: CalendarEvent) => (e.all_day ? 0 : new Date(e.start).getTime())
  return [...by.keys()].sort().map((day) => ({
    day, label: dayLabel(day, now),
    events: by.get(day)!.sort((a, b) => key(a) - key(b)),
  }))
}

const clock = (s: string) => new Date(s).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

/** "All day", "All day · until Oct 7", or "9:00 AM – 10:00 AM". */
export function timeLabel(e: CalendarEvent): string {
  if (e.all_day) {
    const last = addDays(parseDate(e.end), -1)
    return localDate(last) > e.start.slice(0, 10)
      ? `All day · until ${last.toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "All day"
  }
  return `${clock(e.start)} – ${clock(e.end)}`
}

/** What the editor holds. All-day `end` is the LAST day (inclusive), as people say it. */
export type EventDraft = { id?: string; title: string; all_day: boolean; start: Date; end: Date; location: string; description: string }

/** A new event: the next whole hour, one hour long. */
export function newDraft(now: Date): EventDraft {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1)
  return { title: "", all_day: false, start, end: new Date(start.getTime() + 3600_000), location: "", description: "" }
}

export function draftOf(e: CalendarEvent): EventDraft {
  return {
    id: e.id, title: e.title === "(no title)" ? "" : e.title, all_day: e.all_day,
    start: e.all_day ? parseDate(e.start) : new Date(e.start),
    end: e.all_day ? addDays(parseDate(e.end), -1) : new Date(e.end),
    location: e.location, description: e.description,
  }
}

/** Why a draft cannot be saved, or "" when it can. */
export function draftProblem(d: EventDraft): string {
  if (d.all_day ? localDate(d.end) < localDate(d.start) : d.end <= d.start) return "The event must end after it starts."
  return ""
}

/** The body the server takes (viewer/workspace.event_body). */
export function fieldsOf(d: EventDraft): EventFields {
  return {
    title: d.title.trim() || "(no title)", all_day: d.all_day,
    start: d.all_day ? localDate(d.start) : isoLocal(d.start),
    end: d.all_day ? localDate(addDays(d.end, 1)) : isoLocal(d.end),
    location: d.location.trim(), description: d.description.trim(),
  }
}

/** The calendar accounts the owner can use, from the Integrations view: those
 *  where Calendar is switched on. `edit` is the vendor grant for editing — the
 *  owner is bounded by the grant, not by the switches that govern agents. */
export type CalendarAccount = { id: string; account: string; edit: boolean }

export function calendarAccounts(view: IntegrationsView): CalendarAccount[] {
  const granted = (s: ServiceState | undefined) => s === "on" || s === "off"
  return view.providers.flatMap((p) => p.connections)
    .filter((c) => c.services[CALENDAR_SERVICE] === "on")
    .map((c) => ({ id: c.id, account: c.account, edit: ["create", "update", "delete"].every((op) => granted(c.ops?.[CALENDAR_SERVICE]?.[op])) }))
}
