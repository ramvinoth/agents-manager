import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveSessionPath } from "./session.ts"

const fast = { intervalMs: 0 }

test("keeps waiting past 20 tries while the run is alive", async () => {
  let n = 0
  const lookup = async () => (++n < 35 ? { found: false, running: true } : { found: true, path: "projects/-x/s.jsonl" })
  assert.equal(await resolveSessionPath(lookup, { ...fast }), "projects/-x/s.jsonl")
})

test("gives up when the run ended without a transcript", async () => {
  let n = 0
  const lookup = async () => { n++; return { found: false, running: false } }
  assert.equal(await resolveSessionPath(lookup, { ...fast }), null)
  assert.equal(n, 5)
})

test("stops when the caller has gone", async () => {
  let n = 0
  const lookup = async () => { n++; return { found: false, running: true } }
  assert.equal(await resolveSessionPath(lookup, { ...fast, stop: () => n >= 3 }), null)
  assert.equal(n, 3)
})

test("rides out transient errors and is bounded", async () => {
  const lookup = async () => { throw new Error("net") }
  assert.equal(await resolveSessionPath(lookup, { ...fast, maxTries: 4 }), null)
})
