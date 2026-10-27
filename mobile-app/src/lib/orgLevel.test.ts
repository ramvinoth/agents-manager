import test from "node:test"
import assert from "node:assert/strict"
import { ORG_LEVELS, LEVEL_NAME, isOrgLevel } from "./orgLevel.ts"

test("every level has a plain name, and the internal key is never the label", () => {
  for (const l of ORG_LEVELS) assert.ok(LEVEL_NAME[l] && LEVEL_NAME[l].toLowerCase() !== "ic")
  assert.equal(LEVEL_NAME.ic, "Own work")
})

test("isOrgLevel accepts only the wire keys", () => {
  assert.ok(isOrgLevel("lead"))
  for (const v of ["", "IC", "Worker", null, undefined, 3]) assert.equal(isOrgLevel(v), false)
})
