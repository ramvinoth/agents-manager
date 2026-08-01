import assert from "node:assert"
import { buildReply, quotePreview } from "./quote.ts"

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

test("preview collapses whitespace and truncates", () => {
  assert.equal(quotePreview("hello\n\n  world"), "hello world")
  const long = quotePreview("x".repeat(200), 20)
  assert.equal(long.length, 20)
  assert.ok(long.endsWith("…"))
})

test("buildReply wraps the quote in double quotes on its own line", () => {
  const out = buildReply("the build failed", "why?")
  assert.equal(out, 'Replying to: "the build failed"\n\nwhy?')
})

test("inner double quotes are collapsed so the block stays unambiguous", () => {
  const out = buildReply('he said "hi" loudly', "ok")
  assert.ok(!out.includes('"hi"'), "inner quotes should not survive verbatim")
  assert.ok(out.includes("'hi'"))
})

test("long quotes are clipped", () => {
  const out = buildReply("y".repeat(900), "go", 100)
  assert.ok(out.length < 200)
  assert.ok(out.includes("…"))
})

test("no quote returns the reply unchanged", () => {
  assert.equal(buildReply("", "just this"), "just this")
  assert.equal(buildReply("   ", "just this"), "just this")
})

console.log(`${passed} passing`)
