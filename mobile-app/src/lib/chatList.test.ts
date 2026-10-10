import { test } from "node:test"
import assert from "node:assert/strict"
import { groupByProject } from "./chatList.ts"

const chat = (id: string, project: string | undefined, last_message: number) => ({ id, path: id, project, last_message })

test("projects are ordered by their newest message, not by name", () => {
  const groups = groupByProject([chat("a1", "alpha", 10), chat("z1", "zeta", 30), chat("a2", "alpha", 20)])
  assert.deepEqual(groups.map((g) => g.project), ["zeta", "alpha"])
  assert.deepEqual(groups[1].chats.map((c) => c.id), ["a2", "a1"])
})

test("chats without a project share one group, ordered like the rest", () => {
  const groups = groupByProject([chat("x", undefined, 5), chat("y", "beta", 1), chat("w", "", 9)])
  assert.deepEqual(groups.map((g) => [g.project, g.chats.map((c) => c.id)]), [["No project", ["w", "x"]], ["beta", ["y"]]])
})

test("a server that predates last_message falls back to modified", () => {
  const groups = groupByProject([{ id: "o", path: "o", project: "old", modified: 50 }, chat("n", "new", 40)])
  assert.deepEqual(groups.map((g) => g.project), ["old", "new"])
})
