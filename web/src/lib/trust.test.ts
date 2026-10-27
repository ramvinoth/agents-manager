import assert from "node:assert/strict"
import { LEVEL_NAME, ORG_LEVELS, isOrgLevel, trustOutcome } from "./trust.ts"

for (const l of ORG_LEVELS) assert.notEqual(LEVEL_NAME[l].toLowerCase(), "ic", "the internal key is never a label")
assert.equal(LEVEL_NAME.ic, "Own work")
assert.ok(isOrgLevel("manager"))
for (const v of ["", "IC", "Worker", null, 1]) assert.equal(isOrgLevel(v), false)

assert.deepEqual(trustOutcome({ session: "s", level: "lead" }, "s", "level", "lead"), { applied: true, note: "" })
assert.deepEqual(trustOutcome({ session: "s", level: "" }, "s", "level", ""), { applied: true, note: "" }, "clearing to the agent default")
assert.equal(trustOutcome({ queued: true }, "s", "level", "lead").applied, false)
assert.match(trustOutcome({ queued: true }, "s", "level", "lead").note, /approval/)
assert.equal(trustOutcome({ error: "nope" }, "s", "permission_mode", "plan").note, "nope")
assert.equal(trustOutcome({ session: "other", permission_mode: "plan" }, "s", "permission_mode", "plan").applied, false, "wrong chat")
assert.equal(trustOutcome({ session: "s", permission_mode: "default" }, "s", "permission_mode", "plan").applied, false, "wrong value")
console.log("trust: ok")
