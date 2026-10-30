import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { enqueue, screenChange, tapEvent, tapName, type UsageEvent } from "./usage.ts"

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

// -- tap naming: testID first, the data tail cut off, never visible text -------
eq("static testID", tapName({ testID: "agent-save" }), "agent-save")
eq("uuid tail cut", tapName({ testID: "chat-board-3f2a9c1e-77d0-4b1e" }), "chat-board")
eq("numeric id cut", tapName({ testID: "vote-up-126" }), "vote-up")
eq("path tail cut", tapName({ testID: "file-mention-src/lib/a.ts" }), "file-mention")
eq("label tail cut", tapName({ testID: "auq-option-Yes, proceed" }), "auq-option")
eq("file name cut", tapName({ testID: "filestab-README.md" }), "filestab")
eq("segments capped", tapName({ testID: "a-b-c-d-e-f-g" }), "a-b-c-d-e")
eq("testID beats label", tapName({ testID: "send", accessibilityLabel: "Send message" }), "send")
eq("all-data testID falls back to label", tapName({ testID: "126", accessibilityLabel: "Open" }), "Open")
eq("label count stripped", tapName({ accessibilityLabel: "Inbox 3" }), "Inbox")
eq("long label is content", tapName({ accessibilityLabel: "Open Quarterly planning with the whole team" }), "")
eq("email label is content", tapName({ accessibilityLabel: "Mail ram@x.io" }), "")
eq("nothing names it", tapName({}), "")
eq("tap event", tapEvent("Inbox", { testID: "chat-9" }, 4), { kind: "tap", surface: "Inbox", element: "chat", ts: 4 })
eq("no screen yet", tapEvent(undefined, { testID: "send" }, 4), null)
eq("unnamed control", tapEvent("Inbox", { testID: "42" }, 4), null)

// -- wiring: every press goes through components/Tracked ----------------------
// A direct react-native import would silently drop that control's taps.
const here = dirname(process.argv[1])
const appRoot = resolve(here, "../..")
const direct: string[] = []
function check(p: string) {
  const src = readFileSync(p, "utf8")
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']react-native["']/g))
    if (/(^|[\s,])(TouchableOpacity|Pressable)\s*(,|$)/.test(m[1])) direct.push(p.slice(appRoot.length + 1))
}
function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts") && name !== "Tracked.tsx") check(p)
  }
}
walk(join(appRoot, "src"))
check(join(appRoot, "App.tsx"))
eq("no direct react-native pressables", [...new Set(direct)], [])
const tracked = readFileSync(join(appRoot, "src/components/Tracked.tsx"), "utf8")
eq("Tracked counts before the handler", /recordTap\([^)]*\)[^]*?onPress\(e\)/.test(tracked), true)

console.log(`usage: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
