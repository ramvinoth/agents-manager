import { groupExchanges, stepsLabel, type Exchange } from "./exchange.ts"
import type { AssistantTurn, Block, Turn } from "./types.ts"
import { SessionParser } from "./parser.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const text = (t: string): Block => ({ type: "text", text: t })
const tool = (name: string, result: unknown = "ok"): Block => ({ type: "tool_use", name, input: {}, id: name, result })
const a = (domId: string, blocks: Block[], model?: string): AssistantTurn => ({ type: "assistant", domId, blocks, model })
const u = (domId: string): Turn => ({ type: "user", domId, content: "hi" })

// --- grouping ---
eq("empty", groupExchanges([]), [])
const g = groupExchanges([u("u1"), a("a1", [text("looking"), tool("Read")], "m1"), a("a2", [tool("Bash")]), a("a3", [text("done")], "m2"), u("u2")])
eq("three assistant turns become one exchange", g.map((x) => x.type), ["user", "exchange", "user"])
const ex = g[1] as Exchange
eq("anchor is the first member", ex.domId, "a1")
eq("every member id kept for search", ex.memberIds, ["a1", "a2", "a3"])
eq("latest model wins", ex.model, "m2")
eq("steps are everything before the trailing text", ex.steps.map((b) => (b.type === "text" ? b.text : b.type === "tool_use" ? b.name : b.type)), ["looking", "Read", "Bash"])
eq("answer is the trailing text run", ex.answer, [text("done")])
eq("a system line splits runs", groupExchanges([a("a1", [text("x")]), { type: "system", domId: "s", content: "c" }, a("a2", [text("y")])]).length, 3)

// --- answer edge cases ---
const toolsOnly = groupExchanges([a("a1", [tool("Read")])])[0] as Exchange
eq("tool-only run has no answer", toolsOnly.answer, [])
const textOnly = groupExchanges([a("a1", [text("p1"), text("p2")])])[0] as Exchange
eq("text-only run is all answer", [textOnly.steps.length, textOnly.answer.length], [0, 2])

// --- surfaced cards ---
const s = groupExchanges([a("a1", [tool("ExitPlanMode"), tool("AskUserQuestion", null), tool("AskUserQuestion", "answered"), tool("Read")])])[0] as Exchange
eq("plan and open question surface", s.surfaced.map((b) => [b.name, b.result]), [["ExitPlanMode", "ok"], ["AskUserQuestion", null]])
eq("answered question stays a step", s.steps.map((b) => (b.type === "tool_use" ? b.name : "")), ["AskUserQuestion", "Read"])

// --- label ---
eq("label counts tools", stepsLabel([text("x"), tool("A"), tool("B")]), "2 steps")
eq("label singular", stepsLabel([tool("A")]), "1 step")
eq("label falls back to blocks", stepsLabel([text("x")]), "1 step")

// --- compaction folds into the reply it interrupted (records as Claude Code writes them) ---
const sp = new SessionParser()
const rec = (o: object) => sp.ingest(JSON.stringify(o))?.turn
const parsed = [
  rec({ type: "user", uuid: "1", message: { role: "user", content: "build it" } }),
  rec({ type: "assistant", uuid: "2", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] } }),
  rec({ type: "system", subtype: "compact_boundary", uuid: "3", content: "Conversation compacted", compactMetadata: { trigger: "auto" } }),
  rec({ type: "user", uuid: "4", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: "This session is being continued…" } }),
  rec({ type: "assistant", uuid: "5", message: { content: [{ type: "text", text: "done" }] } }),
].filter((t): t is Turn => !!t)
const folded = groupExchanges(parsed)
eq("boundary + summary leave one user message and one reply", folded.map((x) => x.type), ["user", "exchange"])
const fx = folded[1] as Exchange
eq("the summary is a compact step", fx.steps.map((b) => b.type), ["tool_use", "compact"])
eq("the compact step keeps the summary", (fx.steps[1] as { summary: string }).summary, "This session is being continued…")
eq("the answer survives the fold", fx.answer, [text("done")])
eq("the summary is not counted as a user message", sp.stats.userMessages, 1)
const arr = new SessionParser().ingest(JSON.stringify({ type: "user", uuid: "9", isCompactSummary: true, message: { content: [{ type: "text", text: "s" }] } }))?.turn
eq("array-content summary", arr?.type === "assistant" && arr.blocks[0], { type: "compact", summary: "s" })

console.log(`exchange: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
