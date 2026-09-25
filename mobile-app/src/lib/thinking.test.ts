import assert from "node:assert/strict"
import { test } from "node:test"
import { splitThinking } from "./thinking.ts"

test("leading, streaming and stripped-opener reasoning", () => {
  assert.deepEqual(splitThinking(""), { thinking: "", body: "" })
  assert.deepEqual(splitThinking("<think>reasoning here</think>\nHey."), { thinking: "reasoning here", body: "Hey." })
  assert.deepEqual(splitThinking("\n  <think>mid</think>Body"), { thinking: "mid", body: "Body" })
  assert.deepEqual(splitThinking("<think>still thinking"), { thinking: "still thinking", body: "" })
  assert.deepEqual(splitThinking("reasoning here</think>\nHey!"), { thinking: "reasoning here", body: "Hey!" })
})
test("prose, inline pairs and quoted/code closing tags remain visible", () => {
  for (const text of ["Hey there", "  plain", "There is no `<think>` machinery running", "A<think>mid</think>B", "done</think> later <think> too", "Use `</think>` to close the tag", "```xml\n</think>\n```", 'The tag "</think>" is literal']) assert.deepEqual(splitThinking(text), { thinking: "", body: text })
})
