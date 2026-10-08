import assert from "node:assert/strict"
import { test } from "node:test"
import { chatLabel, folderName, modeOf, projectOptions, startBlocker } from "./newChat.ts"

test("project labels widen only on a name clash", () => {
  const opts = projectOptions([{ cwd: "/u/a/api" }, { cwd: "/u/b/api" }, { cwd: "/u/web" }, { cwd: "~" }])
  assert.deepEqual(opts.map((o) => o.label), ["a/api", "b/api", "web", "~"])
  assert.equal(opts[0].v, "/u/a/api")
  assert.equal(projectOptions(Array.from({ length: 20 }, (_, i) => ({ cwd: `/p${i}` }))).length, 12)
})

test("folder name and chat label fall back sensibly", () => {
  assert.equal(folderName("/x/y/"), "y")
  assert.equal(chatLabel("  ", " /x/repo ", "abcdef123456"), "repo")
  assert.equal(chatLabel("", "", "abcdef123456"), "abcdef12")
  assert.equal(chatLabel(" Fix auth ", "/x", "s"), "Fix auth")
})

test("start blocker names the reason", () => {
  assert.equal(startBlocker({ message: "", aiReady: true, aiError: "", busy: false }), "Write the first message to start")
  assert.equal(startBlocker({ message: "hi", aiReady: false, aiError: "", busy: false }), "Loading AI settings…")
  assert.equal(startBlocker({ message: "hi", aiReady: false, aiError: "x", busy: false }), "AI settings didn't load")
  assert.equal(startBlocker({ message: "hi", aiReady: true, aiError: "", busy: false }), "")
  assert.equal(modeOf("nope").v, "acceptEdits")
})
