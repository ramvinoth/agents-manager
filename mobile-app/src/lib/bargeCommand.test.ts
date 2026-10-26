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
test("Agent stop → stop", () => {
  assert.deepEqual(parseBargeCommand("Agent, stop"), { kind: "stop" })
})
test("wake variant + stop → stop", () => {
  assert.deepEqual(parseBargeCommand("Aged stop it"), { kind: "stop" })
})
test("wake word alone → stop", () => {
  assert.deepEqual(parseBargeCommand("Agent"), { kind: "stop" })
})
test("Agent be quiet → stop", () => {
  assert.deepEqual(parseBargeCommand("Agent be quiet"), { kind: "stop" })
})

// --- end ---
test("Agent end the call → end", () => {
  assert.deepEqual(parseBargeCommand("Agent, end the call"), { kind: "end" })
})
test("Agent hang up → end", () => {
  assert.deepEqual(parseBargeCommand("agents hang up"), { kind: "end" })
})
test("end beats stop (stop the call → end)", () => {
  assert.deepEqual(parseBargeCommand("Agent stop the call"), { kind: "end" })
})

// --- ask ---
test("Agent + question → ask with tail", () => {
  assert.deepEqual(parseBargeCommand("Agent, what's the weather today"), {
    kind: "ask",
    tail: "what s the weather today",
  })
})
test("Agent + instruction → ask", () => {
  assert.deepEqual(parseBargeCommand("Agent list the files here"), {
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
  // "please Agent stop" — wake not leading; barge-in requires leading wake.
  assert.deepEqual(parseBargeCommand("please Agent stop"), { kind: "none" })
})

// --- stripWake helper ---
test("stripWake pulls wake + tail", () => {
  assert.deepEqual(stripWake("Agent, do the thing"), { hadWake: true, tail: "do the thing" })
})
test("stripWake no wake", () => {
  assert.deepEqual(stripWake("do the thing"), { hadWake: false, tail: "do the thing" })
})

// --- parseBargeTail: server /wakeguard already stripped "Agent" ---
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
