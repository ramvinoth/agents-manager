import assert from "node:assert"
import { attachMessage, fileMessage, guessMime, mimeFor, pathFromUploadResponse, uniqueName, uploadFile, uploadedPath } from "./attach.ts"

let passed = 0
const pending: Promise<void>[] = []
function test(name: string, fn: () => void | Promise<void>) {
  const fail = (e: unknown) => {
    console.error(`✖ ${name}\n  ${(e as Error).message}`)
    process.exitCode = 1
  }
  try {
    const r = fn()
    if (r) pending.push(r.then(() => void passed++, fail))
    else passed++
  } catch (e) {
    fail(e)
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

test("mimeFor knows video, audio and pdf, and never refuses an unknown type", () => {
  assert.equal(mimeFor("clip.MOV"), "video/quicktime")
  assert.equal(mimeFor("voice.m4a"), "audio/mp4")
  assert.equal(mimeFor("doc.pdf"), "application/pdf")
  assert.equal(mimeFor("data.xyz"), "application/octet-stream")
  assert.equal(mimeFor("noextension"), "application/octet-stream")
})

test("uniqueName stamps and sanitises", () => {
  assert.equal(uniqueName("my clip (1).mov", 5), "5-my_clip_1_.mov")
  assert.equal(uniqueName("../../etc", 5), "5-etc")
  assert.equal(uniqueName("", 5), "5-file")
})

test("fileMessage keeps the note and points at the file", () => {
  assert.ok(fileMessage("/x/a.mov", "watch this").startsWith("watch this"))
  assert.ok(fileMessage("/x/a.mov", " ").includes("/x/a.mov"))
})

test("uploadFile sends a unique name with the right mime and returns the server path", async () => {
  const calls: any[] = []
  const files = {
    fsMkdir: async () => ({}),
    fsUpload: async (_s: any, dir: string, uri: string, name: string, mime?: string) => {
      calls.push({ dir, uri, name, mime })
      return { uploaded: [{ name, path: `/abs/${name}` }] }
    },
  }
  const path = await uploadFile(files, "local", { uri: "file:///c.mov", name: "c.mov" })
  assert.equal(calls[0].mime, "video/quicktime")
  assert.match(calls[0].name, /^\d+-c\.mov$/)
  assert.equal(path, `/abs/${calls[0].name}`)
})

void Promise.all(pending).then(() => console.log(`${passed} passing`))
