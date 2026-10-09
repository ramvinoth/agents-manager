import assert from "node:assert/strict"
import { editRows, effectiveWindow, formatTokens, mergeDiscovered, overrideError, overridesPayload, parseTokens, sortRows } from "./providerModels.ts"

assert.equal(parseTokens("242000"), 242000)
assert.equal(parseTokens("242k"), 242000)
assert.equal(parseTokens("1.5M"), 1500000)
assert.equal(parseTokens("128,000"), 128000)
for (const bad of ["", "abc", "-5", "0", "12kk", "999999999"]) assert.equal(parseTokens(bad), 0, bad)
assert.equal(overrideError("12x"), "Use a token count like 128000, 128k or 1m")
assert.equal(overrideError(""), "")

assert.equal(formatTokens(242000), "242K")
assert.equal(formatTokens(1000000), "1M")
assert.equal(formatTokens(1048576), "1M")
assert.equal(formatTokens(0), "—")

const saved = editRows([
  { id: "a", contextWindow: 100000, source: "override", discovered: 200000, override: 100000, maxOutput: 0 },
  { id: "manual", contextWindow: 0, source: "", discovered: 0, override: 0, maxOutput: 0 },
])
// Discovery refreshes facts, adds new models, keeps overrides and manual rows.
const merged = mergeDiscovered(saved, [{ id: "a", contextWindow: 100000 }, { id: "b", contextWindow: 128000, maxOutput: 8000 }])
const byId = Object.fromEntries(merged.map((r) => [r.id, r]))
assert.equal(byId.a.override, "100000")
assert.equal(byId.a.discovered, 200000, "the effective (override) echo does not overwrite the discovered fact")
assert.deepEqual(byId.b, { id: "b", override: "", discovered: 128000, maxOutput: 8000 })
assert.ok(byId.manual)
assert.deepEqual(effectiveWindow(byId.a), { tokens: 100000, source: "override" })
assert.deepEqual(effectiveWindow(byId.b), { tokens: 128000, source: "discovered" })
assert.deepEqual(effectiveWindow(byId.manual), { tokens: 0, source: "" })
assert.deepEqual(sortRows(merged, "b").map((r) => r.id), ["b", "a", "manual"])
assert.deepEqual(overridesPayload(merged), { a: 100000 }, "only real overrides are sent; the rest clear")
console.log("providerModels: ok")
