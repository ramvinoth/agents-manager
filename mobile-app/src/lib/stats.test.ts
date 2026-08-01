import assert from "node:assert"
import { compactNumber, durationBetween, shortModel, topTools } from "./stats.ts"

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

test("compactNumber scales", () => {
  assert.equal(compactNumber(999), "999")
  assert.equal(compactNumber(1234), "1.2k")
  assert.equal(compactNumber(554226), "554k")
  assert.equal(compactNumber(3_500_000), "3.5M")
})

test("compactNumber handles junk", () => {
  assert.equal(compactNumber(NaN), "0")
  assert.equal(compactNumber(0), "0")
})

test("topTools ranks by count then name", () => {
  const out = topTools({ Bash: 230, Write: 37, Edit: 37, Read: 18 })
  assert.deepEqual(out.map((t) => t.name), ["Bash", "Edit", "Write", "Read"])
  assert.equal(out[0].count, 230)
})

test("topTools respects the limit and tolerates empty", () => {
  assert.equal(topTools({ a: 1, b: 2, c: 3 }, 2).length, 2)
  assert.deepEqual(topTools({} as Record<string, number>), [])
})

test("durationBetween formats sensibly", () => {
  assert.equal(durationBetween("2026-01-01T00:00:00Z", "2026-01-01T00:45:00Z"), "45m")
  assert.equal(durationBetween("2026-01-01T00:00:00Z", "2026-01-01T02:30:00Z"), "2h 30m")
  assert.equal(durationBetween("2026-01-01T00:00:00Z", "2026-01-03T05:00:00Z"), "2d 5h")
  assert.equal(durationBetween(undefined, "2026-01-01T00:00:00Z"), "")
})

test("shortModel trims vendor prefix and date suffix", () => {
  assert.equal(shortModel("claude-opus-4-8"), "opus-4-8")
  assert.equal(shortModel("claude-haiku-4-5-20251001"), "haiku-4-5")
})

console.log(`${passed} passing`)
