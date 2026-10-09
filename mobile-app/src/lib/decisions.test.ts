import assert from "node:assert"
import { fmtWaiting, firstOpen, queueFrom, stepDecision } from "./decisions.ts"

let passed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
  } catch (e) {
    console.error(`✖ ${name}\n  ${(e as Error).message}`)
    process.exitCode = 1
  }
}

test("fmtWaiting: seconds", () => {
  assert.equal(fmtWaiting(5), "5s")
  assert.equal(fmtWaiting(59), "59s")
})

test("fmtWaiting: minutes", () => {
  assert.equal(fmtWaiting(60), "1m")
  assert.equal(fmtWaiting(125), "2m")
})

test("fmtWaiting: hours and days", () => {
  assert.equal(fmtWaiting(3600), "1h")
  assert.equal(fmtWaiting(90061), "1d")
})

test("fmtWaiting: unknown or negative reads as now", () => {
  assert.equal(fmtWaiting(0), "now")
  assert.equal(fmtWaiting(-10), "now")
})

test("stepDecision: forward skips resolved, no wrap", () => {
  // from 0, forward, 1 resolved → lands on 2
  assert.equal(stepDecision(4, 0, 1, new Set([1])), 2)
  // at the last open item, forward → stays put (worklist has an end)
  assert.equal(stepDecision(4, 3, 1, new Set()), 3)
  // everything ahead resolved → stays put
  assert.equal(stepDecision(4, 1, 1, new Set([2, 3])), 1)
})

test("stepDecision: backward skips resolved, no wrap", () => {
  assert.equal(stepDecision(4, 3, -1, new Set([2])), 1)
  assert.equal(stepDecision(4, 0, -1, new Set()), 0)
})

test("firstOpen: stays if current is open", () => {
  assert.equal(firstOpen(4, 1, new Set()), 1)
})

test("firstOpen: advances past a resolved current to the next open", () => {
  // current (1) resolved → next open is 2
  assert.equal(firstOpen(4, 1, new Set([1])), 2)
  // current and its tail resolved → falls back to an earlier open item
  assert.equal(firstOpen(4, 2, new Set([2, 3])), 1)
})

test("firstOpen: -1 only when every item is resolved", () => {
  assert.equal(firstOpen(3, 0, new Set([0, 1, 2])), -1)
  assert.equal(firstOpen(0, 0, new Set()), -1)
})

test("queueFrom: the tapped chat's items lead, in queue order", () => {
  const q = [{ session: "a", inbox_id: 1 }, { session: "b", inbox_id: 2 }, { session: "a", inbox_id: 3 }, { session: "c", inbox_id: 0 }]
  const r = queueFrom(q, 3, "a")
  assert.deepEqual(r.ordered.map((d) => d.inbox_id), [1, 3, 2, 0])
  assert.equal(r.at, 1)
})

test("queueFrom: -1 when the row is not in the visible queue (snoozed / decided)", () => {
  assert.equal(queueFrom([{ session: "a", inbox_id: 1 }], 9, "a").at, -1)
  // inbox_id 0 means "no row was delivered" — never matched by a real id 0
  assert.equal(queueFrom([{ session: "a", inbox_id: 0 }], 0, "a").at, -1)
  assert.equal(queueFrom([], 1, "a").at, -1)
})

console.log(`${passed} passing`)
