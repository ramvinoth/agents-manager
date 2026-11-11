import test from "node:test"
import assert from "node:assert/strict"
import { chatProjects, defaultFilter, filterLabel, orderChats, toStored, visibleChats } from "./chatList.ts"

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

const pool = [
  { id: "a", path: "a", title: "Alpha", project: "/w/sift", last_message: 30, unread: true },
  { id: "b", path: "b", title: "Beta", project: "/w/harman", last_message: 20, favorite: true },
  { id: "c", path: "c", title: "Gamma", project: "/w/sift", last_message: 10, archived: true, unread: true },
  { id: "d", path: "d", title: "Delta", last_message: 5 },
]
const ids = (r: { id: string }[]) => r.map((s) => s.id)

test("filters: unread, starred, project; archived chats stay out of the main view", () => {
  assert.deepEqual(ids(visibleChats(pool, { archived: false, query: "", filter: { kind: "unread" } })), ["a"])
  assert.deepEqual(ids(visibleChats(pool, { archived: false, query: "", filter: { kind: "starred" } })), ["b"])
  assert.deepEqual(ids(visibleChats(pool, { archived: false, query: "", filter: { kind: "project", project: "/w/sift" } })), ["a"])
  assert.deepEqual(ids(visibleChats(pool, { archived: true, query: "", filter: { kind: "unread" } })), ["c"])
})

test("search and filter combine; no filter keeps star-first order", () => {
  assert.deepEqual(ids(visibleChats(pool, { archived: false, query: "harman", filter: null })), ["b"])
  assert.deepEqual(ids(visibleChats(pool, { archived: false, query: "alp", filter: { kind: "starred" } })), [])
  assert.deepEqual(ids(visibleChats(pool, { archived: false, query: "", filter: null })), ["b", "a", "d"])
})

test("projects menu: distinct, newest activity first; labels use the folder name", () => {
  assert.deepEqual(chatProjects(pool), ["/w/sift", "/w/harman"])
  assert.equal(filterLabel({ kind: "project", project: "/w/sift/" }), "sift")
  assert.equal(filterLabel(null), "")
})

test("default filter: all chats (grouped) when nothing was chosen", () => {
  assert.equal(defaultFilter(undefined, pool), null)
  assert.equal(defaultFilter({ kind: "bogus" }, pool), null)
  assert.equal(defaultFilter(undefined, []), null)
})

test("default filter: a remembered choice stands; a project with no live chats falls back to all", () => {
  assert.deepEqual(defaultFilter({ kind: "project", project: "/w/harman" }, pool), { kind: "project", project: "/w/harman" })
  assert.equal(defaultFilter({ kind: "all" }, pool), null)
  assert.deepEqual(defaultFilter({ kind: "starred" }, pool), { kind: "starred" })
  // only an archived chat is left in /w/old: fall back to all
  const withOld = [...pool, { id: "e", path: "e", project: "/w/old", last_message: 99, archived: true }]
  assert.equal(defaultFilter({ kind: "project", project: "/w/old" }, withOld), null)
  assert.equal(defaultFilter({ kind: "project", project: 7 }, pool), null)
})

test("stored form: clearing the filter is remembered as all", () => {
  assert.deepEqual(toStored(null), { kind: "all" })
  assert.deepEqual(toStored({ kind: "unread" }), { kind: "unread" })
})

import { chatRows, isGrouped } from "./chatList.ts"
test("chatRows groups by project in first-seen order, honours collapse, flat when off", () => {
  const mk = (id: string, project?: string) => ({ id, path: id, project } as never)
  const list = [mk("a", "/x/p1"), mk("b"), mk("c", "/x/p1")]
  assert.deepEqual(chatRows(list, true, new Set()).map((r) => (r.kind === "header" ? `H:${r.project}:${r.count}` : r.s.id)),
    ["H:/x/p1:2", "a", "c", "H:No project:1", "b"])
  assert.deepEqual(chatRows(list, true, new Set(["/x/p1"])).map((r) => (r.kind === "header" ? r.project : r.s.id)),
    ["/x/p1", "No project", "b"])
  assert.equal(chatRows(list, false, new Set()).length, 3)
  assert.equal(isGrouped(undefined), true)
  assert.equal(isGrouped(false), false)
})
