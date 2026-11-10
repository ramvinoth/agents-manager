import assert from "node:assert/strict"
import { test } from "node:test"
import { EMPTY_WINDOW, hasOlder, prependOlder } from "./transcriptWindow.ts"

const win = { path: "p", lines: ["c", "d"], start: 200, end: 400 }

test("hasOlder only for the loaded chat with bytes above the window", () => {
  assert.equal(hasOlder(win, "p"), true)
  assert.equal(hasOlder({ ...win, start: 0 }, "p"), false)
  assert.equal(hasOlder(win, "other"), false)
  assert.equal(hasOlder(EMPTY_WINDOW, "p"), false)
  assert.equal(hasOlder(win, undefined), false)
})

test("prependOlder joins a page that ends where the window starts", () => {
  const next = prependOlder(win, "p", { lines: ["a", "b"], start: 0, end: 200 })
  assert.deepEqual(next, { path: "p", lines: ["a", "b", "c", "d"], start: 0, end: 400 })
  assert.deepEqual(win.lines, ["c", "d"]) // input untouched
})

test("prependOlder drops a stale page", () => {
  assert.equal(prependOlder(win, "p", { lines: ["x"], start: 0, end: 150 }), null) // window was reloaded
  assert.equal(prependOlder(win, "q", { lines: ["x"], start: 0, end: 200 }), null) // chat changed
})
