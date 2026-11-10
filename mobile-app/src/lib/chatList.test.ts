import test from "node:test"
import assert from "node:assert/strict"
import { orderChats } from "./chatList.ts"

const chat = (id: string, last_message: number, favorite = false) => ({ id, path: id, last_message, favorite })

test("favorites first, then newest message first", () => {
  const out = orderChats([chat("old", 10), chat("starOld", 5, true), chat("new", 30), chat("starNew", 20, true)])
  assert.deepEqual(out.map((c) => c.id), ["starNew", "starOld", "new", "old"])
})

test("a server without last_message falls back to modified; input is not mutated", () => {
  const input = [{ id: "a", path: "a", modified: 50 }, chat("b", 40)]
  assert.deepEqual(orderChats(input).map((c) => c.id), ["a", "b"])
  assert.equal(input[0].id, "a")
})
