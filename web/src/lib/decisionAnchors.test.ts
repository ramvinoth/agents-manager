import { anchorFor, findKey, callSaid, resultText } from "./decisionAnchors.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const call = (domId: string, id: string, name: string, input: unknown, result: unknown = null) =>
  ({ type: "assistant", domId, blocks: [{ type: "text", text: "x" }, { type: "tool_use", id, name, input, result }] }) as any
const turns = [
  { type: "user", domId: "u1", content: "hi" } as any,
  call("a1", "tu_ask", "AskUserQuestion", {}),
  call("a2", "tu_make", "mcp__viewer__card_create", { title: "t" }, [{ type: "text", text: '{"id": 12, "title": "t"}' }]),
  call("a3", "tu_make2", "mcp__viewer__card_create", { title: "u" }, '{"id": 120}'),
  call("a4", "tu_move", "mcp__viewer__card_move", { card_id: 120, column_id: 5 }),
  call("a5", "tu_red", "mcp__viewer__loop_delete", { id: "x" }, '{"queued": {"id": "apr_77"}}'),
]
const d = (o: object) => ({ session: "s", host: "local", label: "", waiting_s: 0, summary: "", inbox_id: 0, snoozed_until: null, ...o }) as any

eq("question by tool_use id", anchorFor(d({ kind: "question", tool_use_id: "tu_ask" }), turns), "a1")
eq("approval missing id", anchorFor(d({ kind: "approval", tool_use_id: "" }), turns), null)
eq("plan not loaded", anchorFor(d({ kind: "plan", tool_use_id: "tu_old" }), turns), null)
eq("card by create result", anchorFor(d({ kind: "card", card: 12 }), turns), "a2")
eq("card id prefix is not a match", anchorFor(d({ kind: "card", card: 1 }), turns), null)
eq("card prefers latest move", anchorFor(d({ kind: "card", card: 120 }), turns), "a4")
eq("user-made card", anchorFor(d({ kind: "card", card: 999 }), turns), null)
eq("red by quoted id", anchorFor(d({ kind: "red", id: "apr_77" }), turns), "a5")
eq("resultText array", resultText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\n\nb")
eq("resultText null", resultText(null), "")

eq("findKey card", findKey(d({ kind: "card", card: 121 })), "card:121")
eq("findKey question", findKey(d({ kind: "question", tool_use_id: "tu_x" })), "tool:tu_x")
eq("findKey no id", findKey(d({ kind: "plan", tool_use_id: "" })), null)
eq("findKey red stays client-side", findKey(d({ kind: "red", id: "apr_1" })), null)
eq("callSaid comment body", callSaid({ offset: 0, name: "mcp__viewer__card_comment", input: { body: " Need X? " } }), "Need X?")
eq("callSaid question", callSaid({ offset: 0, name: "AskUserQuestion", input: { questions: [{ question: "Which?" }] } }), "Which?")
eq("callSaid created card shows its title, not its body", callSaid({ offset: 0, name: "mcp__viewer__card_create", input: { title: "Ship it?", body: "Long context" } }), "Ship it?")
eq("callSaid bare move", callSaid({ offset: 0, name: "mcp__viewer__card_move", input: { card_id: 1, column_id: 2 } }), "Moved the card.")

console.log(`decisionAnchors: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
