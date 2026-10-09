/**
 * Tests for the pure barge-in command classifier.
 *     node --experimental-strip-types src/lib/bargeCommand.test.ts
 */
import assert from "node:assert"
import { parseBargeTail } from "./bargeCommand.ts"

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
test("stop → stop", () => assert.deepEqual(parseBargeTail("stop"), { kind: "stop" }))
test("stop it → stop", () => assert.deepEqual(parseBargeTail("stop it"), { kind: "stop" }))
test("be quiet → stop", () => assert.deepEqual(parseBargeTail("be quiet"), { kind: "stop" }))
test("'' (wake alone) → stop", () => assert.deepEqual(parseBargeTail(""), { kind: "stop" }))
test("normalized punctuation/case", () => assert.deepEqual(parseBargeTail("Stop It."), { kind: "stop" }))

// --- end ---
test("end the call → end", () => assert.deepEqual(parseBargeTail("end the call"), { kind: "end" }))
test("hang up → end", () => assert.deepEqual(parseBargeTail("hang up"), { kind: "end" }))
test("end beats stop (stop the call → end)", () => assert.deepEqual(parseBargeTail("stop the call"), { kind: "end" }))

// --- ask ---
test("question → ask with normalized tail", () => {
  assert.deepEqual(parseBargeTail("what's the weather today"), { kind: "ask", tail: "what s the weather today" })
})
test("instruction → ask", () => {
  assert.deepEqual(parseBargeTail("list the files here"), { kind: "ask", tail: "list the files here" })
})
test("'stopwatch' is not a stop (prefix must be a whole word)", () => {
  assert.deepEqual(parseBargeTail("stopwatch for five minutes"), { kind: "ask", tail: "stopwatch for five minutes" })
})

console.log(`${passed} passing`)
