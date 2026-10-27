import assert from "node:assert/strict"
import { test } from "node:test"
import { OfflineCache, tailLines, type CacheIO } from "./offlineCache.ts"

function memIO() {
  const files = new Map<string, string>()
  const io: CacheIO = {
    read: async (n) => files.get(n) ?? null,
    write: async (n, d) => void files.set(n, d),
    remove: async (n) => void files.delete(n),
  }
  return { io, files }
}

test("chats round-trip per server and host", async () => {
  const { io } = memIO()
  const c = new OfflineCache(io, {}, () => 42)
  await c.saveChats("s1", "local", [{ path: "a" }])
  assert.deepEqual(await c.loadChats("s1", "local"), [{ path: "a" }])
  assert.equal(await c.loadChats("s1", "box"), null)
  assert.equal(await c.loadChats("s2", "local"), null)
})

test("survives a restart (fresh instance reads the index from disk)", async () => {
  const { io } = memIO()
  await new OfflineCache(io).saveThread("s1", "local", "/p.jsonl", ["x", "y"])
  assert.deepEqual((await new OfflineCache(io).loadThread("s1", "local", "/p.jsonl")), ["x", "y"])
})

test("threads keep only their tail and the newest N threads", async () => {
  const { io, files } = memIO()
  let t = 0
  const c = new OfflineCache(io, { maxThreads: 2, maxLines: 2 }, () => ++t)
  await c.saveThread("s", "h", "a", ["1", "2", "3"])
  await c.saveThread("s", "h", "b", ["b"])
  await c.saveThread("s", "h", "c", ["c"])
  assert.equal(await c.loadThread("s", "h", "a"), null) // evicted, file removed
  assert.deepEqual((await c.loadThread("s", "h", "c")), ["c"])
  assert.equal(files.size, 3) // index + 2 threads
})

test("tailLines respects the byte cap", () => {
  assert.deepEqual(tailLines(["aaaa", "bb", "c"], 10, 5), ["bb", "c"])
  assert.deepEqual(tailLines(["x".repeat(100)], 10, 5), [])
})

test("pruneServers drops a signed-out server's copies only", async () => {
  const { io } = memIO()
  const c = new OfflineCache(io)
  await c.saveChats("keep", "local", [1])
  await c.saveThread("gone", "local", "p", ["l"])
  await c.pruneServers(["keep"])
  assert.equal(await c.loadThread("gone", "local", "p"), null)
  assert.deepEqual((await c.loadChats("keep", "local")), [1])
})

test("identical saves don't rewrite; no server is a no-op; bad files read as empty", async () => {
  const { io, files } = memIO()
  let writes = 0
  const c = new OfflineCache({ ...io, write: async (n, d) => { writes++; await io.write(n, d) } })
  await c.saveChats("s", "h", [1])
  const after = writes
  await c.saveChats("s", "h", [1])
  assert.equal(writes, after)
  await c.saveChats("", "h", [2])
  assert.equal(writes, after)
  for (const k of files.keys()) if (k !== "index.json") files.set(k, "{oops")
  assert.equal(await c.loadChats("s", "h"), null)
})

test("a failing disk never throws to the screen", async () => {
  const c = new OfflineCache({ read: async () => null, write: async () => { throw new Error("full") }, remove: async () => {} })
  await c.saveChats("s", "h", [1])
  assert.equal(await c.loadChats("s", "h"), null)
})
