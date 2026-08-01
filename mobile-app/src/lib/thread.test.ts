/**
 * Tests for the transcript parser + exchange grouping.
 *
 * Runs in plain Node with no install and no simulator:
 *     node --experimental-strip-types src/lib/thread.test.ts
 *
 * thread.ts is deliberately free of react-native imports so this stays possible —
 * it is the module most likely to break on a server-shape change, and a native
 * build takes ~10 minutes to tell you the same thing.
 */
import assert from "node:assert"
import { groupThread, parseTranscript, resultToText, extractImages, fmtDate } from "./thread.ts"

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

const line = (o: unknown) => JSON.stringify(o)

test("parses a user message", () => {
  const t = parseTranscript([line({ type: "user", uuid: "u1", message: { content: "hello" } })])
  assert.equal(t.length, 1)
  assert.equal(t[0].role, "user")
  assert.equal((t[0] as any).text, "hello")
})

test("accepts the server's lines[] envelope AND a raw string", () => {
  const rec = line({ type: "user", uuid: "u1", message: { content: "hi" } })
  assert.equal(parseTranscript([rec]).length, 1)
  assert.equal(parseTranscript(rec).length, 1)
})

test("skips tool_result-only user turns", () => {
  const t = parseTranscript([
    line({ type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "out" }] } }),
  ])
  assert.equal(t.length, 0)
})

test("attaches tool results to their tool_use block", () => {
  const t = parseTranscript([
    line({ type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }] } }),
    line({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }] } }),
  ])
  const blk: any = (t[0] as any).blocks[0]
  assert.equal(blk.kind, "tool")
  assert.equal(resultToText(blk.result), "file.txt")
})

test("marks tool errors", () => {
  const t = parseTranscript([
    line({ type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
    line({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] } }),
  ])
  assert.equal(((t[0] as any).blocks[0] as any).isError, true)
})

test("renders task-notification as a system line, not raw XML", () => {
  const t = parseTranscript([
    line({ type: "user", uuid: "u1", message: { content: "<task-notification><task-id>abc</task-id><status>done</status></task-notification>" } }),
  ])
  assert.equal(t[0].role, "system")
  assert.match((t[0] as any).text, /abc/)
})

test("unwraps slash commands", () => {
  const t = parseTranscript([
    line({ type: "user", uuid: "u1", message: { content: "<command-message>loop</command-message><command-name>/loop</command-name><command-args>5m go</command-args>" } }),
  ])
  assert.equal((t[0] as any).text, "/loop 5m go")
})

test("extracts base64 images from tool results", () => {
  const imgs = extractImages([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }])
  assert.equal(imgs.length, 1)
  assert.equal(imgs[0].mime, "image/png")
})

test("dedupes by uuid", () => {
  const rec = line({ type: "user", uuid: "same", message: { content: "twice" } })
  assert.equal(parseTranscript([rec, rec]).length, 1)
})

test("groupThread puts the final text in finalText and tools in steps", () => {
  const turns = parseTranscript([
    line({ type: "user", uuid: "u1", message: { content: "do it" } }),
    line({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "thinking" }] } }),
    line({ type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
    line({ type: "assistant", uuid: "a3", message: { content: [{ type: "text", text: "done!" }] } }),
  ])
  const items = groupThread(turns)
  assert.equal(items.length, 2, "user turn + one grouped exchange")
  const ex: any = items[1]
  assert.equal(ex.kind, "exchange")
  assert.equal(ex.finalText, "done!", "trailing text is the answer")
  assert.equal(ex.steps.length, 2, "narration + tool collapse into steps")
})

test("groupThread keeps separate exchanges around a user message", () => {
  const turns = parseTranscript([
    line({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "one" }] } }),
    line({ type: "user", uuid: "u1", message: { content: "next" } }),
    line({ type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: "two" }] } }),
  ])
  const items = groupThread(turns)
  assert.deepEqual(items.map((i) => i.kind), ["exchange", "user", "exchange"])
})

test("resultToText flattens content arrays and skips images", () => {
  assert.equal(resultToText([{ type: "text", text: "a" }, { type: "image", source: {} }, { type: "text", text: "b" }]), "a\nb")
})

test("surfaces an UNANSWERED AskUserQuestion as exchange.question, out of steps", () => {
  const turns = parseTranscript([
    line({ type: "user", uuid: "u1", message: { content: "help" } }),
    line({
      type: "assistant",
      uuid: "a1",
      message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] } }] },
    }),
  ])
  const items = groupThread(turns)
  const ex: any = items[items.length - 1]
  assert.equal(ex.kind, "exchange")
  assert.ok(ex.question, "pending question is attached")
  assert.equal(ex.question.name, "AskUserQuestion")
  assert.ok(!ex.steps.some((b: any) => b.name === "AskUserQuestion"), "question is pulled out of steps")
})

test("an ANSWERED AskUserQuestion (has result) is NOT treated as pending", () => {
  const turns = parseTranscript([
    line({ type: "user", uuid: "u1", message: { content: "help" } }),
    line({ type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [] } }] } }),
    line({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "A" }] } }),
  ])
  const items = groupThread(turns)
  const ex: any = items[items.length - 1]
  assert.ok(!ex.question, "answered question is not surfaced as pending")
})

test("fmtDate labels today, yesterday, and older dates", () => {
  const now = new Date()
  const yst = new Date(now.getTime() - 86400000)
  assert.equal(fmtDate(now.toISOString()), "Today")
  assert.equal(fmtDate(yst.toISOString()), "Yesterday")
  assert.equal(fmtDate(""), "")
  assert.equal(fmtDate("not-a-date"), "")
  // An older date resolves to a non-empty absolute label (not Today/Yesterday).
  const old = fmtDate("2020-01-15T12:00:00Z")
  assert.ok(old && old !== "Today" && old !== "Yesterday")
})

console.log(`${passed} passing`)
