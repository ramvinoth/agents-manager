import assert from "node:assert/strict"
import { test } from "node:test"
import { Prefetcher } from "./prefetch.ts"

const tick = () => new Promise((r) => setImmediate(r))

test("a prefetch and the screen share one request", async () => {
  let calls = 0
  const p = new Prefetcher<number>(3000, () => 0)
  const load = () => (calls++, Promise.resolve(7))
  const a = p.get("k", load)
  const b = p.get("k", load)
  assert.equal(a, b)
  assert.equal(await b, 7)
  assert.equal(calls, 1)
})

test("a slow request stays shared until it settles", async () => {
  let t = 0
  let calls = 0
  let done!: (v: number) => void
  const p = new Prefetcher<number>(3000, () => t)
  p.get("k", () => (calls++, new Promise((r) => (done = r))))
  t = 10_000 // still in flight long after freshMs
  p.get("k", () => (calls++, Promise.resolve(0)))
  assert.equal(calls, 1)
  done(1)
})

test("a settled result goes stale after freshMs", async () => {
  let t = 0
  let calls = 0
  const p = new Prefetcher<number>(3000, () => t)
  const load = () => (calls++, Promise.resolve(calls))
  await p.get("k", load)
  await tick()
  t = 2999
  assert.equal(await p.get("k", load), 1)
  t = 6000
  assert.equal(await p.get("k", load), 2)
})

test("a failure is never shared: the next get retries", async () => {
  let calls = 0
  const p = new Prefetcher<number>(3000, () => 0)
  await assert.rejects(p.get("k", () => (calls++, Promise.reject(new Error("down")))))
  await tick()
  assert.equal(await p.get("k", () => (calls++, Promise.resolve(5))), 5)
  assert.equal(calls, 2)
})

test("keys are independent", async () => {
  const p = new Prefetcher<string>(3000, () => 0)
  assert.equal(await p.get("a", async () => "A"), "A")
  assert.equal(await p.get("b", async () => "B"), "B")
})
