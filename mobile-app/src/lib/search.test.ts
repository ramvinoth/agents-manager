import assert from "node:assert"
import { findMatches, isUnread, itemText, stepMatch, trimSeen } from "./search.ts"
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
  { kind: "exchange", id: "2", finalText: "The build is green now", steps: [{ kind: "tool", name: "Bash", input: {}, id: "t", result: null }] },
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

test("trimSeen keeps the most recently seen entries", () => {
  const big: Record<string, number> = {}
  for (let i = 0; i < 100; i++) big[`p${i}`] = i
  const t = trimSeen(big, 10)
  assert.equal(Object.keys(t).length, 10)
  assert.ok(t["p99"] && t["p90"], "newest kept")
  assert.ok(!t["p0"], "oldest dropped")
})

test("unread: only chats seen before and changed since", () => {
  const seen = { "a.jsonl": 100 }
  assert.equal(isUnread(seen, "a.jsonl", 200), true)
  assert.equal(isUnread(seen, "a.jsonl", 50), false)
  assert.equal(isUnread(seen, "never-opened.jsonl", 200), false, "no dot-flood on fresh installs")
})

console.log(`${passed} passing`)
