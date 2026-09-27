import assert from "node:assert"
import { fmtWaiting, firstOpen, stepDecision } from "./decisions.ts"

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

console.log(`${passed} passing`)
