import { firstOpen, queueFrom, stepDecision } from "./decisions.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

eq("next skips resolved", stepDecision(4, 0, 1, new Set([1])), 2)
eq("prev skips resolved", stepDecision(4, 3, -1, new Set([2, 1])), 0)
eq("no wrap at the end", stepDecision(3, 2, 1, new Set()), 2)
eq("no wrap at the start", stepDecision(3, 0, -1, new Set()), 0)
eq("firstOpen stays when open", firstOpen(3, 1, new Set()), 1)
eq("firstOpen moves forward", firstOpen(3, 1, new Set([1])), 2)
eq("firstOpen falls back", firstOpen(3, 2, new Set([2])), 1)
eq("firstOpen all resolved", firstOpen(2, 0, new Set([0, 1])), -1)
eq("firstOpen empty", firstOpen(0, 0, new Set()), -1)

const q = [{ session: "a", inbox_id: 1 }, { session: "b", inbox_id: 2 }, { session: "a", inbox_id: 0 }, { session: "b", inbox_id: 4 }]
const r = queueFrom(q, 4, "b")
eq("tapped session first", r.ordered.map((d) => d.inbox_id), [2, 4, 1, 0])
eq("tapped index", r.at, 1)
eq("not listed", queueFrom(q, 9, "b").at, -1)
eq("no inbox row never matches", queueFrom(q, 0, "a").at, -1)

console.log(`decisions: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
