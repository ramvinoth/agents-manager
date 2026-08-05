/**
 * Tests for the pure barge-in command parser.
 *     node --experimental-strip-types src/lib/bargeCommand.test.ts
 */
import assert from "node:assert"
import { parseBargeCommand, parseBargeTail, stripWake } from "./bargeCommand.ts"

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

// --- stop ---
test("Harman stop → stop", () => {
  assert.deepEqual(parseBargeCommand("Harman, stop"), { kind: "stop" })
})
test("wake variant + stop → stop", () => {
  assert.deepEqual(parseBargeCommand("Herman stop it"), { kind: "stop" })
})
test("wake word alone → stop", () => {
  assert.deepEqual(parseBargeCommand("Harman"), { kind: "stop" })
})
test("Harman be quiet → stop", () => {
  assert.deepEqual(parseBargeCommand("Harman be quiet"), { kind: "stop" })
})

// --- end ---
test("Harman end the call → end", () => {
  assert.deepEqual(parseBargeCommand("Harman, end the call"), { kind: "end" })
})
test("Harman hang up → end", () => {
  assert.deepEqual(parseBargeCommand("harmon hang up"), { kind: "end" })
})
test("end beats stop (stop the call → end)", () => {
  assert.deepEqual(parseBargeCommand("Harman stop the call"), { kind: "end" })
})

// --- ask ---
test("Harman + question → ask with tail", () => {
  assert.deepEqual(parseBargeCommand("Harman, what's the weather today"), {
    kind: "ask",
    tail: "what s the weather today",
  })
})
test("Harman + instruction → ask", () => {
  assert.deepEqual(parseBargeCommand("Harman list the files here"), {
    kind: "ask",
    tail: "list the files here",
  })
})

// --- none (no wake word → ignore, avoids false triggers during playback) ---
test("no wake word → none", () => {
  assert.deepEqual(parseBargeCommand("what time is it"), { kind: "none" })
})
test("empty → none", () => {
  assert.deepEqual(parseBargeCommand(""), { kind: "none" })
})
test("wake word not first → none", () => {
  // "please Harman stop" — wake not leading; barge-in requires leading wake.
  assert.deepEqual(parseBargeCommand("please Harman stop"), { kind: "none" })
})

// --- stripWake helper ---
test("stripWake pulls wake + tail", () => {
  assert.deepEqual(stripWake("Harman, do the thing"), { hadWake: true, tail: "do the thing" })
})
test("stripWake no wake", () => {
  assert.deepEqual(stripWake("do the thing"), { hadWake: false, tail: "do the thing" })
})

// --- parseBargeTail: server /wakeguard already stripped "Harman" ---
test("tail 'stop' → stop", () => {
  assert.deepEqual(parseBargeTail("stop"), { kind: "stop" })
})
test("tail '' (wake alone) → stop", () => {
  assert.deepEqual(parseBargeTail(""), { kind: "stop" })
})
test("tail 'end the call' → end", () => {
  assert.deepEqual(parseBargeTail("end the call"), { kind: "end" })
})
test("tail question → ask (matches server output)", () => {
  assert.deepEqual(parseBargeTail("what s the weather today"), {
    kind: "ask",
    tail: "what s the weather today",
  })
})
test("tail is normalized (punctuation/·case)", () => {
  assert.deepEqual(parseBargeTail("Stop It."), { kind: "stop" })
})

console.log(`${passed} passing`)
