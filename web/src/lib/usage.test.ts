import { controlName, enqueue, seenEvents, NAME_MAX, type UsageEvent } from "./usage.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

eq("track wins", controlName({ track: "move-to", ariaLabel: "Move", text: "Move to" }), "move-to")
eq("aria before title", controlName({ ariaLabel: "Toggle theme", title: "x" }), "Toggle theme")
eq("long title is content", controlName({ title: "https://example.com/some/long/path", text: "Tab" }), "Tab")
eq("falls through blanks", controlName({ track: " ", ariaLabel: "", title: null, text: "  Send\n now " }), "Send now")
eq("counts stripped", controlName({ text: "Inbox 12" }), "Inbox")
eq("ids stripped", controlName({ text: "#126 Approve" }), "Approve")
eq("pure number → next source", controlName({ ariaLabel: "42", text: "Open" }), "Open")
eq("unlabeled", controlName({}), "")
eq("capped", controlName({ ariaLabel: "a".repeat(200) }).length, NAME_MAX)
eq("long text is content", controlName({ text: "Fix the inbox send delay on mobile" }), "")
eq("long text, labelled", controlName({ title: "Open session", text: "Fix the inbox send delay on mobile" }), "Open session")

const ev = (n: number): UsageEvent => ({ kind: "tap", surface: "main", element: String(n), ts: n })
let q: UsageEvent[] = []
for (let i = 0; i < 5; i++) q = enqueue(q, ev(i), 3)
eq("bounded, oldest dropped", q.map((e) => e.ts), [2, 3, 4])
const orig: UsageEvent[] = []
enqueue(orig, ev(1))
eq("does not mutate", orig.length, 0)

const seen = new Set<string>()
eq("seen first time", seenEvents("Inbox", ["Send", "", "Send", "Skip"], seen, 7).map((e) => e.element), ["Send", "Skip"])
eq("seen dedup across calls", seenEvents("Inbox", ["Send", "Next"], seen, 8).map((e) => e.element), ["Next"])

console.log(`usage: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
