/**
 * Tests for the call-answer step classifier.
 *     node --experimental-strip-types src/lib/callSegments.test.ts
 */
import assert from "node:assert"
import { callStep, joinSaid } from "./callSegments.ts"

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

const base = { history: [], tools: [] }

test("audio + next plays the segment", () => {
  assert.deepStrictEqual(callStep({ ...base, audio: "a1", next: "n1" }), { kind: "play", audio: "a1", next: "n1" })
})
test("audio without next is not playable; falls to reply", () => {
  assert.deepStrictEqual(callStep({ ...base, audio: "a1", reply: "hi" }), { kind: "speak", text: "hi" })
})
test("text reply is spoken, trimmed", () => {
  assert.deepStrictEqual(callStep({ ...base, reply: "  Done.  " }), { kind: "speak", text: "Done." })
})
test("blank reply or nothing ends the turn", () => {
  assert.deepStrictEqual(callStep({ ...base, reply: "   " }), { kind: "done" })
  assert.deepStrictEqual(callStep({ ...base, said: "ok" }), { kind: "done" })
})
test("joinSaid appends segments, ignores blanks", () => {
  assert.strictEqual(joinSaid("", "Checking."), "Checking.")
  assert.strictEqual(joinSaid("Checking.", " Three cards. "), "Checking. Three cards.")
  assert.strictEqual(joinSaid("Checking.", ""), "Checking.")
  assert.strictEqual(joinSaid("x", undefined), "x")
})

console.log(`${passed} passed`)
