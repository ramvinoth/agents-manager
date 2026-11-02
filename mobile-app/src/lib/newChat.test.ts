import assert from "node:assert/strict"
import { test } from "node:test"
import { chatLabel, folderName, modeOf, parseRepo, projectOptions, startBlocker, waitForClone, type CloneStatus } from "./newChat.ts"

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
  assert.equal(startBlocker({ title: "t", message: "", aiReady: true, aiError: "", busy: false }), "Write the first message to start")
  assert.equal(startBlocker({ title: "t", message: "hi", aiReady: false, aiError: "", busy: false }), "Loading AI settings…")
  assert.equal(startBlocker({ title: "t", message: "hi", aiReady: false, aiError: "x", busy: false }), "AI settings didn't load")
  assert.equal(startBlocker({ title: "t", message: "hi", aiReady: true, aiError: "", busy: false }), "")
  assert.equal(startBlocker({ title: " ", message: "hi", aiReady: true, aiError: "", busy: false }), "Name the chat to start")
  assert.equal(startBlocker({ title: "", message: "", aiReady: false, aiError: "", busy: false }), "Loading AI settings…")
  assert.equal(modeOf("nope").v, "acceptEdits")
})

test("parseRepo accepts the forms an owner pastes", () => {
  assert.equal(parseRepo("acme/app"), "acme/app")
  assert.equal(parseRepo(" https://github.com/acme/app.git/ "), "acme/app")
  assert.equal(parseRepo("git@github.com:acme/my.app.git"), "acme/my.app")
  assert.equal(parseRepo("https://gitlab.com/acme/app"), "")
  assert.equal(parseRepo("acme"), "")
  assert.equal(parseRepo("acme/app/tree/main"), "")
})

test("waitForClone reports progress, rides out blips, and surfaces failures", async () => {
  const noSleep = async () => {}
  const seq = (items: Array<CloneStatus | Error>) => {
    let i = 0
    return async () => { const x = items[i++]; if (x instanceof Error) throw x; return x }
  }
  const progress: string[] = []
  const dir = await waitForClone(seq([{ running: true, phase: "Receiving", percent: 40 }, new Error("net"), { running: false, dir: "/w/app" }]),
    (p) => progress.push(p), noSleep)
  assert.equal(dir, "/w/app")
  assert.deepEqual(progress, ["Receiving 40%"])
  await assert.rejects(waitForClone(seq([{ running: false, error: "auth failed" }]), () => {}, noSleep), /auth failed/)
  await assert.rejects(waitForClone(seq([new Error("a"), new Error("b")]), () => {}, noSleep, 2), /b/)
  await assert.rejects(waitForClone(seq([{ running: false }]), () => {}, noSleep), /without a folder/)
})
