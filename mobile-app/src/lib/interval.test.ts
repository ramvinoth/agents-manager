import assert from "node:assert"
import { describeSchedule, fmtInterval, parseInterval, toIsoWithOffset } from "./interval.ts"

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

test("fmtInterval picks the largest whole unit", () => {
  assert.equal(fmtInterval(3600), "1h")
  assert.equal(fmtInterval(7200), "2h")
  assert.equal(fmtInterval(1800), "30m")
  assert.equal(fmtInterval(45), "45s")
})

test("parseInterval reads units", () => {
  assert.equal(parseInterval("1h"), 3600)
  assert.equal(parseInterval("30m"), 1800)
  assert.equal(parseInterval("45s"), 45)
  assert.equal(parseInterval("90"), 90, "bare number is seconds")
})

test("parseInterval accepts decimals (the whole point)", () => {
  assert.equal(parseInterval("7.5m"), 450, "7.5 min → 450s")
  assert.equal(parseInterval("7.5h"), 27000, "7.5 hr → 27000s")
  assert.equal(parseInterval("1.5m"), 90)
  assert.equal(parseInterval("0.5h"), 1800)
})

test("parseInterval clamps to [30, 86400]", () => {
  assert.equal(parseInterval("5s"), 30, "floor is 30s")
  assert.equal(parseInterval("48h"), 86400, "ceiling is 24h")
})

test("fmtInterval renders fractional units", () => {
  assert.equal(fmtInterval(450), "7.5m")
  assert.equal(fmtInterval(27000), "7.5h")
  assert.equal(fmtInterval(90), "1.5m", "90s → 1.5m (largest unit ≥ 1)")
  assert.equal(fmtInterval(45), "45s", "under a minute stays seconds")
})

test("round-trips whole units", () => {
  for (const s of ["1h", "30m", "45s"]) {
    assert.equal(fmtInterval(parseInterval(s)), s)
  }
})

test("toIsoWithOffset keeps local wall-clock and carries the device offset", () => {
  const d = new Date(2026, 8, 27, 9, 5, 42)
  const iso = toIsoWithOffset(d)
  assert.match(iso, /^2026-09-27T09:05:00[+-]\d\d:\d\d$/)
  // Round-trips to the same instant (seconds dropped) on any parser.
  assert.equal(Date.parse(iso), new Date(2026, 8, 27, 9, 5, 0).getTime())
})

test("describeSchedule: cron > once > interval", () => {
  assert.equal(describeSchedule({ cron: "0 9 * * *", interval: 0 }), "Daily at 9:00 AM")
  assert.match(describeSchedule({ kind: "once", nextRun: Date.now() / 1000 + 3600 }), /^Once at /)
  assert.match(describeSchedule({ at: toIsoWithOffset(new Date(Date.now() + 3600e3)) }), /^Once at /)
  assert.equal(describeSchedule({ interval: 300 }), "Every 5m")
})

console.log(`${passed} passing`)
