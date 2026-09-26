import assert from "node:assert/strict"
import { auditReducer, initialAuditState, parseAuditPage, auditPath, groupAuditEntries, auditTime, auditTimestamp, auditError, type AuditEntry, type AuditPage } from "./audit.ts"
import { themeFor, contrast } from "./theme.ts"

const entry = (id: number, created_at: number | null = 0): AuditEntry => ({
  id, actor: "Recorded actor", action: "Move card", target: { label: "Card #44", card_id: 44 },
  result: { category: "returned", label: "Handler returned", explanation: "A handler return does not establish success." }, created_at,
})
const page = (ids: number[], next_before: number | null = null): AuditPage => ({ view: "display-v1", audit: ids.map(id => entry(id)), next_before })

assert.equal(auditPath("all"), "/api/org/audit?view=display-v1&limit=50&result=all")
assert.equal(auditPath("denied", 23), "/api/org/audit?view=display-v1&limit=50&result=denied&before=23")
assert.throws(() => parseAuditPage({ audit: [{ target: { body: "SECRET_SENTINEL" } }] }), /update/i)
assert.throws(() => parseAuditPage({ ...page([]), view: "future" }), /update/i)
assert.throws(() => parseAuditPage({ ...page([]), next_before: -1 }), /invalid/i)
assert.throws(() => parseAuditPage(page([10], 10), 10), /invalid/i)
assert.throws(() => parseAuditPage(page([9], 8)), /invalid/i)
assert.deepEqual(parseAuditPage(page([9], 9), 10), page([9], 9))
for (const malformed of [null, { ...entry(1), id: -1 }, { ...entry(1), action: {} }, { ...entry(1), target: { label: "Card", card_id: "44" } }, { ...entry(1), result: { category: "unknown", label: "raw", explanation: "raw" } }]) {
  assert.throws(() => parseAuditPage({ ...page([]), audit: [malformed] }), /invalid/i)
}
const safe = parseAuditPage({ ...page([]), secret: "SECRET_SENTINEL", audit: [{ ...entry(1), args: "SECRET_SENTINEL", target: { ...entry(1).target, body: "SECRET_SENTINEL" }, result: { ...entry(1).result, raw: "SECRET_SENTINEL" } }] })
assert.equal(JSON.stringify(safe).includes("SECRET_SENTINEL"), false)
assert.equal(parseAuditPage({ ...page([]), audit: [{ ...entry(1), created_at: "bad" }] }).audit[0].created_at, null)
assert.equal(parseAuditPage({ ...page([]), audit: [{ ...entry(1), created_at: 1e100 }] }).audit[0].created_at, null)
assert.equal(auditTime(null), "Time unavailable")
assert.equal(auditTimestamp(NaN), "Time unavailable")
assert.equal(auditTimestamp(129600).includes("1970"), true)
assert.equal(auditTimestamp(0).includes("GMT") || auditTimestamp(0).includes("UTC"), true)
const localMorning = new Date(2026, 8, 19, 9).getTime() / 1000
const localEvening = new Date(2026, 8, 19, 23).getTime() / 1000
const nextDay = new Date(2026, 8, 20, 0).getTime() / 1000
const groups = groupAuditEntries([entry(4, nextDay), entry(3, localEvening), entry(2, localMorning), entry(1, null)])
assert.deepEqual(groups.map(s => s.data.map(e => e.id)), [[4], [3, 2], [1]])
assert.equal(groups[3 - 1].title, "Date unavailable")
// Non-monotonic clocks must not reorder stable record IDs to combine date sections.
assert.deepEqual(groupAuditEntries([entry(3, localMorning), entry(2, nextDay), entry(1, localMorning)]).flatMap(s => s.data.map(e => e.id)), [3, 2, 1])

let state = initialAuditState()
state = auditReducer(state, { type: "begin", request: 1, mode: "initial", filter: "all" })
state = auditReducer(state, { type: "success", request: 1, page: page([8, 7], 7) })
assert.deepEqual(state.rows.map(e => e.id), [8, 7])
state = auditReducer(state, { type: "begin", request: 2, mode: "older", filter: "all" })
state = auditReducer(state, { type: "failure", request: 2, error: "Older failed" })
assert.equal(state.olderError, "Older failed")
assert.equal(state.nextBefore, 7)
assert.equal(state.rows.length, 2)
state = auditReducer(state, { type: "begin", request: 3, mode: "older", filter: "all" })
state = auditReducer(state, { type: "success", request: 3, page: page([7, 6], 6) })
assert.deepEqual(state.rows.map(e => e.id), [8, 7, 6])
state = auditReducer(state, { type: "begin", request: 4, mode: "refresh", filter: "all" })
state = auditReducer(state, { type: "failure", request: 4, error: "Refresh failed" })
assert.deepEqual(state.rows.map(e => e.id), [8, 7, 6])
assert.equal(state.nextBefore, 6)
assert.equal(state.error, "Refresh failed")
state = auditReducer(state, { type: "begin", request: 5, mode: "refresh", filter: "all" })
state = auditReducer(state, { type: "success", request: 5, page: page([9, 8], 8) })
assert.deepEqual(state.rows.map(e => e.id), [9, 8])
state = auditReducer(state, { type: "begin", request: 6, mode: "initial", filter: "denied" })
assert.equal(state.rows.length, 0)
assert.equal(state.nextBefore, null)
assert.equal(state.filter, "denied")
assert.equal(auditReducer(state, { type: "success", request: 5, page: page([99]) }), state)
assert.equal(auditReducer(state, { type: "failure", request: 5, error: "Stale" }), state)
state = auditReducer(state, { type: "success", request: 6, page: page([]) })
assert.equal(state.loaded, true)
assert.equal(state.loading, null)
// A refresh supersedes even an in-flight older page, including same-filter races.
state = auditReducer(state, { type: "begin", request: 7, mode: "older", filter: "denied" })
state = auditReducer(state, { type: "begin", request: 8, mode: "refresh", filter: "denied" })
assert.equal(auditReducer(state, { type: "success", request: 7, page: page([88]) }), state)
assert.equal(auditError({ status: 403, message: "SECRET_SENTINEL" }), "You do not have access to this audit log.")
assert.equal(auditError(new Error("SECRET_SENTINEL")).includes("SECRET_SENTINEL"), false)
for (const scheme of ["light", "dark"] as const) {
  const t = themeFor(scheme)
  assert.ok(contrast(t.text, t.bg) >= 4.5)
  assert.ok(contrast(t.text, t.surface) >= 4.5)
}
console.log("Audit contract, date, paging, stale-request, error and contrast tests passed")
