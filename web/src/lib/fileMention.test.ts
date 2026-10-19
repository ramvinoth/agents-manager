import { test } from "node:test"
import assert from "node:assert/strict"
import { hashTerm, mentionFor, applyMention } from "./fileMention.ts"

test("hashTerm finds the #word ending at the caret", () => {
  assert.deepEqual(hashTerm("look at #comp", 13), { start: 8, query: "comp" })
  assert.deepEqual(hashTerm("#src/lib", 8), { start: 0, query: "src/lib" })
  assert.deepEqual(hashTerm("a\n#x", 4), { start: 2, query: "x" })
})

test("hashTerm ignores headings, lone #, mid-word # and numbers", () => {
  assert.equal(hashTerm("# Title", 7), null)
  assert.equal(hashTerm("#", 1), null)
  assert.equal(hashTerm("C#sharp", 7), null)
  assert.equal(hashTerm("card #203", 9), null)
  assert.equal(hashTerm("#comp done", 10), null) // caret past the word
})

test("hashTerm only looks left of the caret", () => {
  assert.deepEqual(hashTerm("#comp tail", 3), { start: 0, query: "co" })
})

test("mentionFor quotes paths with spaces", () => {
  assert.equal(mentionFor("src/a.ts"), "@src/a.ts")
  assert.equal(mentionFor("docs/My Notes.md"), '@"docs/My Notes.md"')
})

test("applyMention swaps the #word and keeps the rest", () => {
  const t = "see #comp now"
  const r = applyMention(t, hashTerm(t, 9)!, 9, "web/Composer.tsx")
  assert.equal(r.text, "see @web/Composer.tsx now")
  assert.equal(r.caret, "see @web/Composer.tsx ".length)
  const e = applyMention("#no", { start: 0, query: "no" }, 3, "My Notes.md")
  assert.deepEqual(e, { text: '@"My Notes.md" ', caret: 15 })
})
