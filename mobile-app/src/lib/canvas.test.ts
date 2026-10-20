import { CANVAS_SHOW_TOOL, noteBody, queueReply, replyDraft, showSucceeded, shownTitles, splitSlides, takeReply, withReply } from "./canvas.ts"
import type { Block } from "./thread.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.error(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`) }
}

const ok = '{"shown": true, "title": "Plan", "kind": "markdown", "version": 2}'
eq("string result shown", showSucceeded(ok), true)
eq("content-array result shown", showSucceeded([{ type: "text", text: ok }]), true)
eq("refusal", showSucceeded('{"error": "too big"}'), false)
eq("in flight", showSucceeded(null), false)
eq("tool error", showSucceeded(ok, true), false)

const tool = (title: string, result: unknown, name = CANVAS_SHOW_TOOL): Block =>
  ({ kind: "tool", name, id: title + name, input: { title, kind: "markdown", content: "x" }, result })
eq("shown titles: ok, deduped, failures and other tools skipped", shownTitles([
  tool("Plan", ok), { kind: "text", text: "hi" } as Block, tool("Plan", ok), tool("Bad", '{"error":"x"}'),
  tool("Other", ok, "Bash"), tool("Flow", [{ type: "text", text: ok }]), tool("  ", ok),
]), ["Plan", "Flow"])

eq("slides split on ---", splitSlides("# A\n---\n# B"), ["# A", "# B"])
eq("--- inside a fence stays", splitSlides("```\n---\n```\n---\nB"), ["```\n---\n```", "B"])
eq("empty slides dropped", splitSlides("---\n\n---\nA\n---"), ["A"])
eq("empty content is one blank slide", splitSlides(""), [""])

eq("reply names canvas", replyDraft({ title: "Plan", version: 3 }), 'About the canvas "Plan" (v3): ')
eq("reply names slide", replyDraft({ title: "Deck", version: 1 }, { index: 1, count: 4 }), 'About the canvas "Deck" (v1, slide 2 of 4): ')
eq("single slide not named", replyDraft({ title: "D", version: 1 }, { index: 0, count: 1 }), 'About the canvas "D" (v1): ')

eq("note body mermaid fenced", noteBody({ kind: "mermaid", content: "graph TD" }), "```mermaid\ngraph TD\n```")
eq("note body markdown as is", noteBody({ kind: "markdown", content: "# x" }), "# x")

eq("reply into empty draft", withReply("  ", "R: "), "R: ")
eq("reply appends to typed draft", withReply("hello  \n", "R: "), "hello\nR: ")

queueReply("s1", "R")
eq("other session takes nothing", takeReply("s2"), undefined)
eq("own session takes it", takeReply("s1"), "R")
eq("taken once", takeReply("s1"), undefined)
queueReply("", "R")
eq("no session, no queue", takeReply(""), undefined)

console.log(`canvas: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
