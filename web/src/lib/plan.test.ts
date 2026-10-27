import { planText, planDecision, planStateLabel } from "./plan.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}
function ok(label: string, cond: boolean) {
  if (cond) pass++
  else { fail++; console.log(`FAIL ${label}`) }
}

// ── planText: the shapes an ExitPlanMode input actually arrives in ───────────
eq("object input", planText({ plan: "# Step 1" }), "# Step 1")
eq("JSON string input", planText('{"plan":"# Step 1"}'), "# Step 1")
eq("bare string is the plan itself", planText("just do it"), "just do it")
eq("empty object", planText({}), "")
eq("null", planText(null), "")
eq("undefined", planText(undefined), "")
eq("number", planText(42), "")
eq("plan of wrong type", planText({ plan: 5 }), "")
eq("empty string", planText(""), "")
// Malformed JSON falls back to the raw string rather than throwing.
eq("malformed JSON", planText('{"plan": '), '{"plan": ')
eq("JSON array", planText("[1,2]"), "")
// Multi-line markdown must survive verbatim — it is rendered, not re-parsed.
const md = "# Title\n\n- a\n- b\n\n```ts\nconst x = 1\n```"
eq("markdown survives", planText({ plan: md }), md)
eq("markdown via JSON string", planText(JSON.stringify({ plan: md })), md)

// ── planDecision: pending ────────────────────────────────────────────────────
eq("null result is pending", planDecision(null), "pending")
eq("undefined result is pending", planDecision(undefined), "pending")

// ── planDecision: approved. The exact CLI string, verified against 12 real
//    ExitPlanMode tool_results in this machine's transcripts. ────────────────
const APPROVED =
  "User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\nYour plan has been saved to: /Users/x/.claude/plans/foo.md"
eq("real approved result", planDecision(APPROVED), "approved")
eq("approved, short form", planDecision("User has approved your plan."), "approved")
// Anthropic content-part shapes — the same string wrapped three different ways.
eq("approved as content parts", planDecision([{ type: "text", text: APPROVED }]), "approved")
eq("approved as {text}", planDecision({ text: APPROVED }), "approved")
eq("approved as {content: string}", planDecision({ content: APPROVED }), "approved")
eq("approved as {content: parts}", planDecision({ content: [{ type: "text", text: APPROVED }] }), "approved")
eq("approved split across parts", planDecision([{ text: "User has approved " }, { text: "your plan." }]), "approved")
// Leading whitespace must not defeat the prefix.
eq("approved with leading newline", planDecision("\n  " + APPROVED), "approved")

// ── planDecision: declined. The result is the user's own feedback text
//    (viewer/engine.py, _await_plan_decision), so it can be anything. ────────
eq("feedback is a revision", planDecision("Use Postgres, not SQLite"), "revised")
eq("server default deny message", planDecision("The user did not approve the plan. Revise and re-present it."), "revised")
eq("feedback as content parts", planDecision([{ type: "text", text: "too broad" }]), "revised")
// A mention of approval that isn't the prefix must not read as approved.
eq("not a prefix match", planDecision("I would have approved your plan but no"), "revised")

// ── planDecision: unrecognised shapes degrade to neutral, never to pending ──
eq("empty string is decided", planDecision(""), "decided")
eq("whitespace is decided", planDecision("   \n "), "decided")
eq("empty parts array is decided", planDecision([]), "decided")
eq("unknown object is decided", planDecision({ foo: 1 }), "decided")
eq("number result is decided", planDecision(7), "decided")
eq("true result is decided", planDecision(true), "decided")
eq("nested empty parts is decided", planDecision({ content: [] }), "decided")

// The load-bearing invariant: a present result NEVER reads as pending. Collapse
// keys off this, so a CLI wording change may cost the badge but never the fold.
for (const r of ["", "  ", [], {}, 0, false, "anything", [{ text: "" }], { content: [] }, { text: "" }]) {
  ok(`non-null result is never pending: ${JSON.stringify(r)}`, planDecision(r) !== "pending")
}
// And nothing but null/undefined reads as pending.
ok("only nullish is pending", planDecision(null) === "pending" && planDecision(undefined) === "pending")

// ── labels ──────────────────────────────────────────────────────────────────
eq("pending has no label", planStateLabel("pending"), "")
eq("approved label", planStateLabel("approved"), "approved")
eq("revised label", planStateLabel("revised"), "changes requested")
eq("decided label", planStateLabel("decided"), "decided")
for (const s of ["pending", "approved", "revised", "decided"] as const) {
  ok(`label is a string: ${s}`, typeof planStateLabel(s) === "string")
}

console.log(`${pass} passing${fail ? `, ${fail} FAILING` : ""}`)
if (fail) process.exit(1)
