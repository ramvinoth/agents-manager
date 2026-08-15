import assert from "node:assert"
import {
  baseName, humanSize, joinPath, sortEntries,
  navInit, navVisit, navBack, navForward, navCurrent, navCanBack, navCanForward,
} from "./files.ts"

let passed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
  } catch (e) {
    console.error(`✖ ${name}\n  ${(e as Error).message}`)
    process.exitCode = 1
  }
}

test("humanSize scales units", () => {
  assert.equal(humanSize(512), "512 B")
  assert.equal(humanSize(1536), "1.5 KB")
  assert.equal(humanSize(1024 * 1024 * 5), "5.0 MB")
  assert.equal(humanSize(1024 * 1024 * 1024 * 3), "3.0 GB")
})

test("humanSize handles junk", () => {
  assert.equal(humanSize(-1), "")
  assert.equal(humanSize(NaN), "")
})

test("directories sort before files, then case-insensitive", () => {
  const out = sortEntries([
    { name: "zeta.txt", dir: false, size: 1, mtime: 0 },
    { name: "Beta", dir: true, size: 0, mtime: 0 },
    { name: "alpha.txt", dir: false, size: 1, mtime: 0 },
    { name: "acme", dir: true, size: 0, mtime: 0 },
  ]).map((e) => e.name)
  assert.deepEqual(out, ["acme", "Beta", "alpha.txt", "zeta.txt"])
})

test("joinPath never doubles slashes", () => {
  assert.equal(joinPath("/a/b", "c"), "/a/b/c")
  assert.equal(joinPath("/a/b/", "c"), "/a/b/c")
  assert.equal(joinPath("", "c"), "c")
})

test("baseName picks the last segment", () => {
  assert.equal(baseName("/home/tim/projects"), "projects")
  assert.equal(baseName("/"), "/")
  assert.equal(baseName("/a/b/"), "b")
})

test("navHistory: init has no back/forward", () => {
  const h = navInit("/home")
  assert.equal(navCurrent(h), "/home")
  assert.equal(navCanBack(h), false)
  assert.equal(navCanForward(h), false)
})

test("navHistory: visit then back/forward", () => {
  let h = navInit("/home")
  h = navVisit(h, "/home/a")
  h = navVisit(h, "/home/a/b")
  assert.equal(navCurrent(h), "/home/a/b")
  assert.equal(navCanForward(h), false)
  h = navBack(h)
  assert.equal(navCurrent(h), "/home/a")
  assert.equal(navCanBack(h), true)
  assert.equal(navCanForward(h), true)
  h = navBack(h)
  assert.equal(navCurrent(h), "/home")
  assert.equal(navCanBack(h), false)
  h = navForward(h)
  assert.equal(navCurrent(h), "/home/a")
})

test("navHistory: visiting after back truncates forward branch", () => {
  let h = navInit("/home")
  h = navVisit(h, "/home/a")
  h = navVisit(h, "/home/a/b")
  h = navBack(h) // back to /home/a, forward available
  h = navVisit(h, "/home/c") // new branch drops /home/a/b
  assert.equal(navCurrent(h), "/home/c")
  assert.equal(navCanForward(h), false)
  h = navBack(h)
  assert.equal(navCurrent(h), "/home/a")
})

test("navHistory: revisiting the current path is a no-op", () => {
  let h = navInit("/home")
  h = navVisit(h, "/home/a")
  const before = h
  h = navVisit(h, "/home/a")
  assert.equal(h, before) // same object; no history bloat
})

test("navHistory: back/forward at the ends are no-ops", () => {
  let h = navInit("/home")
  assert.equal(navBack(h), h)
  assert.equal(navForward(h), h)
})

console.log(`${passed} passing`)