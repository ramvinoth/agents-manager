/**
 * Tests for the pure endpointing decision (silence-hang + barge-in-to-extend).
 *     node --experimental-strip-types src/lib/endpoint.test.ts
 */
import assert from "node:assert"
import {
  endpointVerdict,
  observeFrame,
  type EndpointOptions,
  type EndpointState,
} from "./endpoint.ts"

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

const OPTS: EndpointOptions = {
  floorDb: -45,
  silenceHangMs: 1500,
  maxMs: 15000,
  noSpeechTimeoutMs: 4000,
}
const fresh = (): EndpointState => ({ heardSpeech: false, lastLoudMs: -1 })

// Feed a sequence of {db, at} frames, checking the verdict after each.
function run(frames: { db: number; at: number }[], opts = OPTS) {
  let st = fresh()
  const start = 0
  let last: ReturnType<typeof endpointVerdict> = { done: false }
  for (const f of frames) {
    st = observeFrame(st, f.db, f.at, opts.floorDb)
    last = endpointVerdict(st, f.at - start, f.at, opts)
    if (last.done) return { verdict: last, at: f.at }
  }
  return { verdict: last, at: frames[frames.length - 1]?.at ?? 0 }
}

test("no speech at all → stops as 'no-speech' after the timeout", () => {
  const r = run([
    { db: -80, at: 500 },
    { db: -70, at: 2000 },
    { db: -75, at: 4100 },
  ])
  assert.deepEqual(r.verdict, { done: true, reason: "no-speech" })
})

test("speech then ~1.5s of quiet → endpoints", () => {
  const r = run([
    { db: -20, at: 300 }, // speech
    { db: -22, at: 600 },
    { db: -70, at: 900 }, // silence begins after 600ms
    { db: -72, at: 1500 },
    { db: -75, at: 2100 }, // 2100 - 600 = 1500ms quiet → stop
  ])
  assert.equal(r.verdict.done, true)
  assert.equal((r.verdict as { reason: string }).reason, "endpoint")
  assert.equal(r.at, 2100)
})

test("a thinking pause SHORTER than the hang does NOT end the turn", () => {
  const r = run([
    { db: -20, at: 300 },
    { db: -70, at: 700 }, // pause starts
    { db: -71, at: 1500 }, // ~800ms quiet — under 1500, keep going
    { db: -19, at: 1800 }, // resumed talking (barge-in-to-extend)
    { db: -70, at: 2100 },
  ])
  // Still recording at the end of this sequence (no 1.5s gap ever completed).
  assert.equal(r.verdict.done, false)
})

test("resuming speech RESETS the silence timer (barge-in-to-extend)", () => {
  // A gap that would have endpointed, interrupted by one loud frame, must not fire
  // until a fresh full hang elapses AFTER the interruption.
  let st = fresh()
  st = observeFrame(st, -20, 2000, OPTS.floorDb) // speech
  st = observeFrame(st, -70, 2100, OPTS.floorDb) // quiet begins (lastLoud=2000)
  // 2000+1400 = 3400: 1400ms quiet, not yet.
  assert.equal(endpointVerdict(st, 3400, 3400, OPTS).done, false)
  st = observeFrame(st, -18, 3450, OPTS.floorDb) // talk again → resets lastLoudMs
  // Now even at 4800 (1350ms after the reset) it must NOT be done.
  assert.equal(endpointVerdict(st, 4800, 4800, OPTS).done, false)
  // Only after a full 1500ms from 3450 → 4950 does it endpoint.
  st = observeFrame(st, -70, 4960, OPTS.floorDb)
  assert.equal(endpointVerdict(st, 4960, 4960, OPTS).done, true)
})

test("a very long monologue hits the hard max cap", () => {
  const frames = []
  for (let at = 200; at <= 16000; at += 400) frames.push({ db: -20, at }) // never quiet
  const r = run(frames)
  assert.equal(r.verdict.done, true)
  assert.equal((r.verdict as { reason: string }).reason, "max")
})

setTimeout(() => {
  if (!process.exitCode) console.log(`${passed} passing`)
}, 50)
