import assert from "node:assert"
import { resolveRed, withoutRed } from "./redApproval.ts"

let passed = 0
const tests: Promise<void>[] = []
function test(name: string, fn: () => Promise<void> | void) {
  tests.push(run(name, fn))
}
async function run(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passed++
  } catch (e) {
    console.error(`✖ ${name}\n  ${(e as Error).message}`)
    process.exitCode = 1
  }
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status })
}

test("resolveRed sends the numeric id and the decision", async () => {
  const calls: unknown[] = []
  await resolveRed(async (b) => { calls.push(b); return {} }, "12", "denied")
  assert.deepEqual(calls, [{ id: 12, resolution: "denied" }])
})

test("resolveRed: decided elsewhere (404) counts as decided", async () => {
  await resolveRed(async () => { throw httpError(404, "not found") }, "3", "approved")
})

test("resolveRed: the asker cannot self-resolve — the 403 reaches the reader", async () => {
  await assert.rejects(
    resolveRed(async () => { throw httpError(403, "you raised this approval") }, "3", "approved"),
    /you raised this approval/)
})

test("resolveRed: an approval that ran but failed is not reported as done", async () => {
  await assert.rejects(
    resolveRed(async () => ({ result: { error: "card is gone" } }), "3", "approved"),
    /Approved, but it failed: card is gone/)
})

test("resolveRed: a denial ignores a result error (nothing ran)", async () => {
  await resolveRed(async () => ({ result: { error: "irrelevant" } }), "3", "denied")
})

test("resolveRed: a missing or junk id never calls the server", async () => {
  let called = false
  const spy = async () => { called = true; return {} }
  for (const id of [undefined, "", "abc", "0", "-2", "1.5"]) {
    await assert.rejects(resolveRed(spy, id, "approved"), /no id/)
  }
  assert.equal(called, false)
})

test("withoutRed drops only the decided ask", () => {
  const asks = [{ id: "1", summary: "a" }, { id: "2", summary: "b" }]
  assert.deepEqual(withoutRed(asks, "1"), [{ id: "2", summary: "b" }])
  assert.deepEqual(withoutRed(asks, "9"), asks)
})

Promise.all(tests).then(() => console.log(`redApproval: ${passed} passed`))
