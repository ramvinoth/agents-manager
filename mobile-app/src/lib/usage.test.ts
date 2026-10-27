import { enqueue, screenChange, type UsageEvent } from "./usage.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const ev = (n: number): UsageEvent => ({ kind: "view", surface: "S" + n, ts: n })
let q: UsageEvent[] = []
for (let i = 0; i < 5; i++) q = enqueue(q, ev(i), 3)
eq("bounded, oldest dropped", q.map((e) => e.ts), [2, 3, 4])
const orig: UsageEvent[] = []
enqueue(orig, ev(1))
eq("does not mutate", orig.length, 0)

eq("first screen", screenChange(undefined, "Inbox", 5), { kind: "view", surface: "Inbox", ts: 5 })
eq("same screen ignored", screenChange("Inbox", "Inbox", 6), null)
eq("no route ignored", screenChange("Inbox", undefined, 6), null)
eq("changed", screenChange("Inbox", "CardDetail", 7)?.surface, "CardDetail")

console.log(`usage: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
