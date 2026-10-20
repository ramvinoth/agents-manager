import { canvasShows, latestShow, replyDraft, showSucceeded, splitSlides, themedHtml, CANVAS_SHOW_TOOL } from "./canvas.ts"
import type { Turn } from "./types.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const call = (id: string, title: string, result: unknown, isError = false) =>
  ({ type: "tool_use", name: CANVAS_SHOW_TOOL, id, input: { title, kind: "markdown", content: "x" }, result, isError })
const turn = (...blocks: unknown[]) => ({ type: "assistant", domId: "d", blocks }) as unknown as Turn
const OK = '{"shown": true, "title": "Flow", "version": 1}'

// --- showSucceeded ---
eq("in flight", showSucceeded(null), false)
eq("tool error", showSucceeded(OK, true), false)
eq("server refusal", showSucceeded('{"error": "content required"}'), false)
eq("shown", showSucceeded(OK), true)
eq("shown as content array", showSucceeded([{ type: "text", text: OK }]), true)

// --- canvasShows / latestShow ---
const turns = [
  { type: "user", domId: "u", content: "hi" } as Turn,
  turn({ type: "text", text: "drawing" }, call("t1", "Flow", OK)),
  turn(call("t2", " Plan ", OK), { type: "tool_use", name: "Bash", id: "b", input: {}, result: "" }),
  turn(call("t3", "Broken", '{"error": "x"}')),
]
eq("all shows in order, titles trimmed", canvasShows(turns).map((s) => [s.id, s.title, s.ok]),
  [["t1", "Flow", true], ["t2", "Plan", true], ["t3", "Broken", false]])
eq("latest skips the refused one", latestShow(turns)?.id, "t2")
eq("no shows", latestShow([turns[0]]), null)

// --- splitSlides ---
eq("single slide", splitSlides("# A\ntext"), ["# A\ntext"])
eq("three slides", splitSlides("# A\n---\n# B\n  ---  \n# C"), ["# A", "# B", "# C"])
eq("--- inside a code fence stays", splitSlides("# A\n```yaml\n---\nk: v\n```\n---\n# B"), ["# A\n```yaml\n---\nk: v\n```", "# B"])
eq("empty slides dropped", splitSlides("---\n# A\n---\n---\n"), ["# A"])
eq("empty content keeps one slide", splitSlides(""), [""])

// --- replyDraft ---
eq("plain", replyDraft({ title: "Flow", version: 3 }), 'About the canvas "Flow" (v3): ')
eq("slide", replyDraft({ title: "Tour", version: 1 }, { index: 1, count: 4 }), 'About the canvas "Tour" (v1, slide 2 of 4): ')
eq("single slide omits position", replyDraft({ title: "T", version: 1 }, { index: 0, count: 1 }), 'About the canvas "T" (v1): ')

// --- themedHtml ---
const T = { bg: "black", fg: "white", dark: true }
const th = (s: string) => themedHtml(s, T)
eq("fragment gets defaults first", th("<p>hi</p>").startsWith('<meta name="viewport"'), true)
eq("fragment content kept", th("<p>hi</p>").endsWith("<p>hi</p>"), true)
eq("doctype stays first", th("<!DOCTYPE html><html><head><title>x</title></head></html>").startsWith("<!DOCTYPE html><html><head><meta"), true)
eq("no head: after <html>", th('<html lang="en"><body>x</body></html>').startsWith('<html lang="en"><meta'), true)
eq("doctype only: after it", th("<!doctype html><p>x</p>").startsWith("<!doctype html><meta"), true)
eq("agent's viewport kept, none added", (th('<head><meta name="viewport" content="width=500"></head>').match(/viewport/g) || []).length, 1)
eq("agent's style comes after ours", th("<head><style>body{background:red}</style></head>").indexOf("background:black") < th("<head><style>body{background:red}</style></head>").indexOf("background:red"), true)
eq("dark scheme", th("x").includes("color-scheme:dark"), true)
eq("light scheme", themedHtml("x", { ...T, dark: false }).includes("color-scheme:light"), true)
eq("<header> is not <head>", th("<header>h</header>").startsWith('<meta name="viewport"'), true)

console.log(`canvas: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
