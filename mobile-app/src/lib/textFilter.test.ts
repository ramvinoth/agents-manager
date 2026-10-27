import { test } from "node:test"
import assert from "node:assert/strict"
import { textFilter } from "./textFilter.ts"

const rows = [{ name: "deploy", desc: "Ship to Fly" }, { name: "lint", desc: undefined }, { name: "Review", desc: "code review" }]
const fields = (r: typeof rows[number]) => [r.name, r.desc]

test("a blank query keeps every row, in order", () => {
  assert.deepEqual(textFilter(rows, "  ", fields), rows)
})

test("matches any field, ignoring case and surrounding spaces; a missing field never matches", () => {
  assert.deepEqual(textFilter(rows, " REVIEW ", fields).map((r) => r.name), ["Review"])
  assert.deepEqual(textFilter(rows, "fly", fields).map((r) => r.name), ["deploy"])
  assert.deepEqual(textFilter(rows, "undefined", fields), [])
})
