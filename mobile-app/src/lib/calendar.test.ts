import assert from "node:assert"
import type { CalendarEvent, IntegrationsView } from "../api/client"
import { agenda, calendarAccounts, dayLabel, draftOf, draftProblem, fieldsOf, isoLocal, localDate, newDraft, parseDate, timeLabel } from "./calendar.ts"

let passed = 0
function test(name: string, fn: () => void) {
  try { fn(); passed++ } catch (e) { console.error(`✖ ${name}\n  ${(e as Error).message}`); process.exitCode = 1 }
}
const ev = (o: Partial<CalendarEvent>): CalendarEvent => ({
  id: "e", title: "T", start: "", end: "", all_day: false, location: "", description: "", attendees: [], link: "", status: "confirmed", ...o,
})
const now = new Date(2026, 9, 5, 14, 20) // Mon Oct 5 2026, 2:20 PM local

test("dates parse and print in local time, not UTC", () => {
  assert.strictEqual(localDate(parseDate("2026-10-05")), "2026-10-05")
  assert.strictEqual(parseDate("2026-10-05").getHours(), 0)
  assert.strictEqual(localDate(new Date(2026, 0, 31, 23, 59)), "2026-01-31")
})

test("isoLocal carries the device offset and round-trips to the same instant", () => {
  const d = new Date(2026, 9, 5, 9, 30)
  const s = isoLocal(d)
  assert.match(s, /^2026-10-05T09:30:00[+-]\d\d:\d\d$/)
  assert.strictEqual(new Date(s).getTime(), d.getTime())
})

test("today / tomorrow / a weekday", () => {
  assert.strictEqual(dayLabel("2026-10-05", now), "Today")
  assert.strictEqual(dayLabel("2026-10-06", now), "Tomorrow")
  assert.notStrictEqual(dayLabel("2026-10-08", now), "Today")
})

test("agenda groups by start day, all-day first, then by time; drops cancelled", () => {
  const nine = isoLocal(new Date(2026, 9, 6, 9)), eight = isoLocal(new Date(2026, 9, 6, 8))
  const days = agenda([
    ev({ id: "b", start: nine, end: nine }),
    ev({ id: "a", start: eight, end: eight }),
    ev({ id: "all", all_day: true, start: "2026-10-06", end: "2026-10-07" }),
    ev({ id: "x", start: eight, end: eight, status: "cancelled" }),
    ev({ id: "t", start: isoLocal(new Date(2026, 9, 5, 16)), end: isoLocal(new Date(2026, 9, 5, 17)) }),
  ], now)
  assert.deepStrictEqual(days.map((d) => [d.label, d.events.map((e) => e.id)]), [["Today", ["t"]], ["Tomorrow", ["all", "a", "b"]]])
})

test("all-day end is exclusive on the wire, inclusive in the label and editor", () => {
  const one = ev({ all_day: true, start: "2026-10-05", end: "2026-10-06" })
  assert.strictEqual(timeLabel(one), "All day")
  const three = ev({ all_day: true, start: "2026-10-05", end: "2026-10-08" })
  assert.match(timeLabel(three), /^All day · until /)
  const d = draftOf(three)
  assert.strictEqual(localDate(d.end), "2026-10-07")
  assert.deepStrictEqual([fieldsOf(d).start, fieldsOf(d).end], ["2026-10-05", "2026-10-08"])
})

test("a timed draft round-trips through fields", () => {
  const e = ev({ id: "z", title: "Standup", start: isoLocal(new Date(2026, 9, 5, 9)), end: isoLocal(new Date(2026, 9, 5, 9, 15)), location: " HQ " })
  const f = fieldsOf(draftOf(e))
  assert.strictEqual(new Date(f.start!).getTime(), new Date(e.start).getTime())
  assert.strictEqual(f.location, "HQ")
  assert.strictEqual(f.all_day, false)
})

test("new draft starts at the next whole hour for an hour; untitled saves as (no title)", () => {
  const d = newDraft(now)
  assert.deepStrictEqual([d.start.getHours(), d.start.getMinutes(), (d.end.getTime() - d.start.getTime()) / 60000], [15, 0, 60])
  assert.strictEqual(fieldsOf(d).title, "(no title)")
  assert.strictEqual(draftOf(ev({ title: "(no title)", start: d.start.toISOString(), end: d.end.toISOString() })).title, "")
})

test("an event must end after it starts; a one-day all-day event is fine", () => {
  const d = newDraft(now)
  assert.strictEqual(draftProblem(d), "")
  assert.notStrictEqual(draftProblem({ ...d, end: d.start }), "")
  assert.strictEqual(draftProblem({ ...d, all_day: true, end: d.start }), "")
  assert.notStrictEqual(draftProblem({ ...d, all_day: true, end: new Date(2026, 9, 1) }), "")
})

test("calendar accounts: only switched-on ones; edit follows the grant, not the agent switches", () => {
  const conn = (id: string, cal: string, ops: Record<string, string>) => ({
    id, account: `${id}@x`, status: "active", authorized: true, root: "/",
    services: { "google.calendar": cal }, ops: { "google.calendar": ops },
  })
  const view = { redirect_uri: "", local: { roots: [], ops: [] }, providers: [{ connections: [
    conn("a", "on", { read: "on", create: "off", update: "on", delete: "off" }),
    conn("b", "on", { read: "on", create: "grant", update: "grant", delete: "grant" }),
    conn("c", "off", { read: "off", create: "off", update: "off", delete: "off" }),
  ] }] } as unknown as IntegrationsView
  assert.deepStrictEqual(calendarAccounts(view), [{ id: "a", account: "a@x", edit: true }, { id: "b", account: "b@x", edit: false }])
})

console.log(`calendar: ${passed} passed`)
