import { splitThinking } from "./thinking.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

eq("no think", splitThinking("Hey there"), { thinking: "", body: "Hey there" })
eq("empty", splitThinking(""), { thinking: "", body: "" })
eq("basic", splitThinking("<think>reasoning here</think>\nHey."), { thinking: "reasoning here", body: "Hey." })
eq("leading ws + think", splitThinking("\n  <think>mid</think>Body"), { thinking: "mid", body: "Body" })
eq("unterminated (streaming)", splitThinking("<think>still thinking"), { thinking: "still thinking", body: "" })
eq("orphan close (stripped opener)", splitThinking("reasoning here</think>\nHey!"), { thinking: "reasoning here", body: "Hey!" })
eq("orphan close leading ws", splitThinking("\nA while has passed</think>\n\nHey! Yeah."), { thinking: "A while has passed", body: "Hey! Yeah." })
// Prefix-only: an inline <think> mention in prose/code must NOT be treated as a
// reasoning block (regression: messages containing the literal token got hollowed).
eq("inline mention untouched", splitThinking("There is no `<think>` machinery running so this stays."), { thinking: "", body: "There is no `<think>` machinery running so this stays." })
eq("inline pair mid-prose untouched", splitThinking("A<think>mid</think>B"), { thinking: "", body: "A<think>mid</think>B" })
eq("stray close mid-prose untouched", splitThinking("done the fix</think> later text with <think> too"), { thinking: "", body: "done the fix</think> later text with <think> too" })

console.log(`${pass} passing${fail ? `, ${fail} FAILING` : ""}`)
if (fail) process.exit(1)
