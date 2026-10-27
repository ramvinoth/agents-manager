import assert from "node:assert/strict"
import { test } from "node:test"
import { createUndoQueue, UNDO_MS } from "./undo.ts"

function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let id = 0
  return {
    timers: { set: (fn: () => void, ms: number) => { pending.set(++id, { fn, ms }); return id }, clear: (h: unknown) => { pending.delete(h as number) } },
    fire() { for (const [k, v] of [...pending]) { pending.delete(k); v.fn() } },
    pending,
  }
}

test("the window closing commits; undo is not called", () => {
  const ft = fakeTimers(); const q = createUndoQueue(ft.timers); const log: string[] = []
  q.push({ label: "x", undo: () => log.push("undo"), commit: () => { log.push("commit") } })
  assert.equal([...ft.pending.values()][0].ms, UNDO_MS)
  ft.fire()
  assert.deepEqual(log, ["commit"])
  assert.equal(q.current(), null)
})

test("undo restores and the deferred commit never runs", () => {
  const ft = fakeTimers(); const q = createUndoQueue(ft.timers); const log: string[] = []
  q.push({ label: "x", undo: () => log.push("undo"), commit: () => { log.push("commit") } })
  q.undo(); ft.fire(); q.undo()
  assert.deepEqual(log, ["undo"])
})

test("a second action commits the first at once; only the newest can be undone", () => {
  const ft = fakeTimers(); const q = createUndoQueue(ft.timers); const log: string[] = []
  q.push({ label: "a", undo: () => log.push("undo a"), commit: () => { log.push("commit a") } })
  q.push({ label: "b", undo: () => log.push("undo b"), commit: () => { log.push("commit b") } })
  assert.equal(q.current()?.label, "b")
  q.undo(); ft.fire()
  assert.deepEqual(log, ["commit a", "undo b"])
})

test("flush (app backgrounded) commits now; dismiss just closes", () => {
  const ft = fakeTimers(); const q = createUndoQueue(ft.timers); const log: string[] = []
  q.push({ label: "a", undo: () => log.push("undo"), commit: () => { log.push("commit") } })
  q.flush(); ft.fire()
  q.push({ label: "flip", undo: () => log.push("undo flip") })
  q.dismiss(); ft.fire()
  assert.deepEqual(log, ["commit"])
})

test("a failing commit never wedges the queue; listeners see each change", async () => {
  const ft = fakeTimers(); const q = createUndoQueue(ft.timers); const seen: (string | null)[] = []
  const off = q.subscribe((a) => seen.push(a?.label ?? null))
  q.push({ label: "boom", undo: () => {}, commit: () => { throw new Error("x") } })
  q.push({ label: "rej", undo: () => {}, commit: () => Promise.reject(new Error("y")) })
  ft.fire()
  await new Promise((r) => setImmediate(r))
  off(); q.push({ label: "quiet", undo: () => {} })
  assert.deepEqual(seen, ["boom", null, "rej", null])
})
