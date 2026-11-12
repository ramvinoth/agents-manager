import test from "node:test"
import assert from "node:assert/strict"
import { splitCardMentions } from "./cardMention.ts"

test("plain text stays one piece", () => {
  assert.deepEqual(splitCardMentions("nothing here"), [{ text: "nothing here" }])
})
test("finds Card N, card #N and several in one line", () => {
  assert.deepEqual(splitCardMentions("See Card 460 and card #12."), [
    { text: "See " }, { text: "Card 460", id: 460 }, { text: " and " }, { text: "card #12", id: 12 }, { text: "." },
  ])
})
test("ignores words that only contain card", () => {
  assert.deepEqual(splitCardMentions("discard 5 cardinal 3"), [{ text: "discard 5 cardinal 3" }])
})
