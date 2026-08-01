import assert from "node:assert"
import { replyPreview } from "./notify.ts"

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

test("takes the first meaningful line", () => {
  assert.equal(replyPreview("Done!\nmore detail here"), "Done!")
})

test("skips markdown-only lines like separators", () => {
  assert.equal(replyPreview("---\n\nActually finished"), "Actually finished")
})

test("strips bold, inline code and heading markers", () => {
  assert.equal(replyPreview("## **Run 002** is `training`"), "Run 002 is training")
})

test("truncates long lines with an ellipsis", () => {
  const out = replyPreview("x".repeat(300), 50)
  assert.equal(out.length, 50)
  assert.ok(out.endsWith("…"))
})

test("empty input is safe", () => {
  assert.equal(replyPreview(""), "")
  assert.equal(replyPreview("\n\n"), "")
})

console.log(`${passed} passing`)
