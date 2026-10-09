import test from "node:test"
import assert from "node:assert/strict"
import { HARMAN_LEVELS, LEVEL_NAME, isHarmanLevel } from "./harmanLevel.ts"

test("every level has a plain name, and the internal key is never the label", () => {
  for (const l of HARMAN_LEVELS) assert.ok(LEVEL_NAME[l] && LEVEL_NAME[l].toLowerCase() !== "ic")
  assert.equal(LEVEL_NAME.ic, "Own work")
})

test("isHarmanLevel accepts only the wire keys", () => {
  assert.ok(isHarmanLevel("lead"))
  for (const v of ["", "IC", "Worker", null, undefined, 3]) assert.equal(isHarmanLevel(v), false)
})
