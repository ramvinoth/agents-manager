import assert from "node:assert"
import { findMatches, itemText, stepMatch } from "./search.ts"
import type { ThreadItem } from "./thread.ts"

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

const ITEMS: ThreadItem[] = [
  { kind: "user", id: "1", text: "fix the build error" },
  { kind: "exchange", id: "2", finalText: "The build is green now", steps: [{ kind: "tool", name: "Bash", input: {}, id: "t", result: null }], plans: [] },
  { kind: "system", id: "3", text: "background task done" },
  { kind: "user", id: "4", text: "ship it" },
]

test("finds case-insensitive matches across roles", () => {
  assert.deepEqual(findMatches(ITEMS, "BUILD"), [0, 1])
  assert.deepEqual(findMatches(ITEMS, "ship"), [3])
})

test("searches tool names inside steps", () => {
  assert.deepEqual(findMatches(ITEMS, "bash"), [1])
})

test("short queries return nothing (too noisy to jump on)", () => {
  assert.deepEqual(findMatches(ITEMS, "b"), [])
  assert.deepEqual(findMatches(ITEMS, "  "), [])
})

test("stepMatch cycles forward and back with wrap", () => {
  const m = [0, 1, 3]
  assert.equal(stepMatch(m, -1, 1), 0, "no current → first")
  assert.equal(stepMatch(m, 0, 1), 1)
  assert.equal(stepMatch(m, 3, 1), 0, "wraps forward")
  assert.equal(stepMatch(m, 0, -1), 3, "wraps back")
  assert.equal(stepMatch([], 0, 1), -1)
})

test("itemText flattens an exchange", () => {
  assert.ok(itemText(ITEMS[1]).includes("green"))
  assert.ok(itemText(ITEMS[1]).includes("Bash"))
})

console.log(`${passed} passing`)
