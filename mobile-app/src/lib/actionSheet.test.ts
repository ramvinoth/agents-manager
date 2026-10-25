import { test } from "node:test"
import assert from "node:assert/strict"
import { createActionSheetQueue } from "./actionSheet.ts"

test("show emits the request and close returns the chosen action", () => {
  const q = createActionSheetQueue()
  const seen: (string | null)[] = []
  q.subscribe((r) => seen.push(r?.title ?? null))
  let ran = ""
  q.show("Job", [{ text: "Edit", onPress: () => { ran = "edit" } }, { text: "Remove", onPress: () => { ran = "remove" }, destructive: true }])
  assert.equal(q.current()?.actions.length, 2)
  q.close(1)?.onPress()
  assert.equal(ran, "remove")
  assert.equal(q.current(), null)
  assert.deepEqual(seen, ["Job", null])
})

test("cancel runs nothing and an out-of-range index is a cancel", () => {
  const q = createActionSheetQueue()
  q.show("X", [{ text: "A", onPress: () => assert.fail("must not run") }])
  assert.equal(q.close(null), null)
  q.show("X", [{ text: "A", onPress: () => assert.fail("must not run") }])
  assert.equal(q.close(5), null)
})

test("a second show replaces the open sheet; unsubscribe stops updates", () => {
  const q = createActionSheetQueue()
  let n = 0
  const off = q.subscribe(() => n++)
  q.show("First", [])
  q.show("Second", [])
  assert.equal(q.current()?.title, "Second")
  off()
  q.close(null)
  assert.equal(n, 2)
})
