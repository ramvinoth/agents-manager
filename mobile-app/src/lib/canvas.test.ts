import { CANVAS_SHOW_TOOL, showSucceeded, shownTitles } from "./canvas.ts"
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

console.log(`canvas: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
