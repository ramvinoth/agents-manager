import assert from "node:assert"
import { attachMessage, guessMime, pathFromUploadResponse, uploadedPath } from "./attach.ts"

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

test("guessMime covers the formats a phone produces", () => {
  assert.equal(guessMime("shot.png"), "image/png")
  assert.equal(guessMime("IMG_1234.HEIC"), "image/heic")
  assert.equal(guessMime("photo.jpg"), "image/jpeg")
  assert.equal(guessMime("noextension"), "image/jpeg", "safe default")
})

test("uploadedPath joins the upload dir", () => {
  assert.equal(uploadedPath("a.png"), "~/agents-uploads/a.png")
  assert.equal(uploadedPath("a.png", "/tmp"), "/tmp/a.png")
})

test("attachMessage keeps the user's note and points at the file", () => {
  const m = attachMessage("~/agents-uploads/a.png", "why is this misaligned?")
  assert.ok(m.startsWith("why is this misaligned?"))
  assert.ok(m.includes("~/agents-uploads/a.png"))
})

test("attachMessage works with no note", () => {
  const m = attachMessage("~/x/a.png", "   ")
  assert.ok(m.includes("~/x/a.png"))
  assert.ok(m.length > 10)
})

test("uses the server's ABSOLUTE path, not the ~-prefixed guess", () => {
  const res = { uploaded: [{ name: "a.png", size: 10, path: "/home/tim/agents-uploads/a.png" }] }
  assert.equal(pathFromUploadResponse(res, "a.png"), "/home/tim/agents-uploads/a.png")
})

test("surfaces a per-file upload error instead of pretending success", () => {
  assert.throws(() => pathFromUploadResponse({ uploaded: [{ name: "a.png", error: "disk full" }] }, "a.png"), /disk full/)
})

test("falls back to the computed path when the response has none", () => {
  assert.equal(pathFromUploadResponse(null, "a.png"), "~/agents-uploads/a.png")
})

console.log(`${passed} passing`)
