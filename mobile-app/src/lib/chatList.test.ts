import { test } from "node:test"
import assert from "node:assert/strict"
import { groupByProject } from "./chatList.ts"

const s = (id: string, project: string | undefined, modified: number) =>
  ({ id, project, modified, path: id }) as any

test("projects order by their newest chat, not alphabetically", () => {
  const out = groupByProject([s("a", "alpha", 1), s("z", "zeta", 9), s("b", "alpha", 5)])
  assert.deepEqual(out.map((g) => g.project), ["zeta", "alpha"])
  assert.deepEqual(out[1].chats.map((c) => c.id), ["b", "a"])
})

test("chats without a project group under No project", () => {
  const out = groupByProject([s("x", undefined, 3)])
  assert.equal(out[0].project, "No project")
})
