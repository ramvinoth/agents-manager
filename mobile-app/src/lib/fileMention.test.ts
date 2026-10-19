import assert from "node:assert"
import { applyMention, hashTerm, mentionFor } from "./fileMention.ts"

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

test("hashTerm finds the #word ending at the caret", () => {
  assert.deepEqual(hashTerm("look at #comp", 13), { start: 8, query: "comp" })
  assert.deepEqual(hashTerm("a\n#x", 4), { start: 2, query: "x" })
})

test("hashTerm ignores headings, lone #, mid-word # and numbers", () => {
  assert.equal(hashTerm("# Title", 7), null)
  assert.equal(hashTerm("#", 1), null)
  assert.equal(hashTerm("C#sharp", 7), null)
  assert.equal(hashTerm("card #203", 9), null)
})

test("mentionFor quotes paths with spaces", () => {
  assert.equal(mentionFor("src/a.ts"), "@src/a.ts")
  assert.equal(mentionFor("docs/My Notes.md"), '@"docs/My Notes.md"')
})

test("applyMention swaps the #word and keeps the rest", () => {
  const t = "see #comp now"
  assert.deepEqual(applyMention(t, hashTerm(t, 9)!, 9, "a/B.tsx"), { text: "see @a/B.tsx now", caret: 13 })
})

console.log(`${passed} passing`)
