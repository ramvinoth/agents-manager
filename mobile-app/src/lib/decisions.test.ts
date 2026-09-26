import assert from "node:assert"
import { fmtWaiting } from "./decisions.ts"

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

console.log(`${passed} passing`)
