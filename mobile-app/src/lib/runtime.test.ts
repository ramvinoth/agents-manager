// Unit tests for the runtime choice helpers. Pure, run under node --experimental-strip-types.
import assert from "node:assert"
import { RUNTIME_OPTIONS, isRuntime, runtimeSummary } from "./runtime.ts"

let passed = 0
function test(name: string, fn: () => void) {
  try { fn(); passed++ } catch (e) { console.error(`✖ ${name}\n  ${(e as Error).message}`); process.exitCode = 1 }
}

test("options start with the server default, then each runtime", () => {
  assert.deepStrictEqual(RUNTIME_OPTIONS.map((o) => o.v), ["", "local", "sandbox"])
})
test("only known runtimes pass the guard", () => {
  assert.ok(isRuntime("sandbox") && isRuntime("local"))
  assert.ok(!isRuntime("") && !isRuntime("mars") && !isRuntime(undefined))
})
test("summary names what applies and where it came from", () => {
  assert.strictEqual(runtimeSummary("sandbox", "sandbox"), "Cloud sandbox")
  assert.strictEqual(runtimeSummary("", "local"), "Server (server default)")
  assert.strictEqual(runtimeSummary("", ""), "Loading…")
})

console.log(`runtime: ${passed} passed`)
