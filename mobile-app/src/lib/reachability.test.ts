import assert from "node:assert/strict"
import { test } from "node:test"
import { Reachability } from "./reachability.ts"

test("starts online; notifies only on transitions", () => {
  const r = new Reachability()
  const seen: boolean[] = []
  r.subscribe((s) => seen.push(s.online))
  assert.equal(r.get().online, true)
  r.report(true, 1)
  r.report(false, 2)
  r.report(false, 3)
  r.report(true, 4)
  assert.deepEqual(seen, [false, true])
  assert.deepEqual(r.get(), { online: true, since: 4 })
})
test("since marks when the outage began, not the latest failure", () => {
  const r = new Reachability()
  r.report(false, 10)
  r.report(false, 99)
  assert.deepEqual(r.get(), { online: false, since: 10 })
})
test("unsubscribe stops notifications", () => {
  const r = new Reachability()
  let n = 0
  const off = r.subscribe(() => n++)
  off()
  r.report(false)
  assert.equal(n, 0)
})
