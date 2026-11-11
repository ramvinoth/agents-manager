import { test } from "node:test"
import assert from "node:assert/strict"
import { matchDecision, notificationTarget, threadInstanceId } from "./notificationRoute.ts"

test("card, note and screen win over a session", () => {
  assert.deepEqual(notificationTarget({ card: 12, session: "s" }), { to: "card", id: 12 })
  assert.deepEqual(notificationTarget({ note: "7" }), { to: "note", id: 7 })
  assert.deepEqual(notificationTarget({ screen: "Integrations" }), { to: "integrations" })
  assert.equal(notificationTarget({ card: -1 }), null)
})

test("a decision opens the deck, even with no session (an org approval)", () => {
  assert.deepEqual(notificationTarget({ session: "", decision: "red", ref: "41" }),
    { to: "decision", kind: "red", ref: "41", session: "" })
  assert.deepEqual(notificationTarget({ session: "abc", decision: "question", ref: "tu_1" }),
    { to: "decision", kind: "question", ref: "tu_1", session: "abc" })
})

test("an inbox message opens that session's mailbox", () => {
  assert.deepEqual(notificationTarget({ inbox: 9, session: "abc" }), { to: "inbox", session: "abc" })
})

test("a chat turn opens the thread at once, titled from the push", () => {
  assert.deepEqual(notificationTarget({ session: "abc" }, "Trader · inbox"),
    { to: "thread", session: "abc", host: "local", title: "Trader" })
  assert.deepEqual(notificationTarget({ session: "abc", host: "box" }, "Trader"),
    { to: "thread", session: "abc", host: "box", title: "Trader" })
  assert.equal(notificationTarget({}), null)
})

const queue = [
  { kind: "question", session: "a", tool_use_id: "tu_1" },
  { kind: "approval", session: "b", id: "p9", tool_use_id: "tu_2" },
  { kind: "card", session: "c", card: 53 },
  { kind: "red", session: "", id: "41" },
  { kind: "question", session: "b", tool_use_id: "tu_3" },
]

test("matchDecision finds the exact item by the ref it was delivered under", () => {
  assert.equal(matchDecision(queue, { kind: "approval", ref: "p9", session: "b" }), 1)
  assert.equal(matchDecision(queue, { kind: "card", ref: "53", session: "c" }), 2)
  assert.equal(matchDecision(queue, { kind: "red", ref: "41", session: "" }), 3)
  assert.equal(matchDecision(queue, { kind: "question", ref: "tu_3", session: "b" }), 4)
})

test("matchDecision falls back to the same session and kind, else -1", () => {
  assert.equal(matchDecision(queue, { kind: "question", ref: "gone", session: "b" }), 4)
  assert.equal(matchDecision(queue, { kind: "red", ref: "gone", session: "" }), -1)
  assert.equal(matchDecision(queue, { kind: "plan", ref: "x", session: "a" }), -1)
})

test("threadInstanceId: same chat by path or session id, different chats differ", () => {
  assert.equal(threadInstanceId({ path: "projects/-x/abc-123.jsonl" }), threadInstanceId({ session: "abc-123" }))
  assert.notEqual(threadInstanceId({ session: "a" }), threadInstanceId({ session: "b" }))
  assert.equal(threadInstanceId({ label: "Chat" }), "Chat")
})
