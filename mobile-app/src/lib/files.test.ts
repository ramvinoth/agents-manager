import assert from "node:assert"
import { baseName, humanSize, joinPath, sortEntries } from "./files.ts"

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

console.log(`${passed} passing`)
