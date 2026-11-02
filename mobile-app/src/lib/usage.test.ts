import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { controlName, enqueue, gestureEvent, screenChange, seenEvents, type UsageEvent } from "./usage.ts"

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
eq("static testID", controlName({ testID: "agent-save" }), "agent-save")
eq("uuid tail cut", controlName({ testID: "chat-board-3f2a9c1e-77d0-4b1e" }), "chat-board")
eq("numeric id cut", controlName({ testID: "vote-up-126" }), "vote-up")
eq("path tail cut", controlName({ testID: "file-mention-src/lib/a.ts" }), "file-mention")
eq("label tail cut", controlName({ testID: "auq-option-Yes, proceed" }), "auq-option")
eq("file name cut", controlName({ testID: "filestab-README.md" }), "filestab")
eq("segments capped", controlName({ testID: "a-b-c-d-e-f-g" }), "a-b-c-d-e")
eq("testID beats label", controlName({ testID: "send", accessibilityLabel: "Send message" }), "send")
eq("all-data testID falls back to label", controlName({ testID: "126", accessibilityLabel: "Open" }), "Open")
eq("label count stripped", controlName({ accessibilityLabel: "Inbox 3" }), "Inbox")
eq("long label is content", controlName({ accessibilityLabel: "Open Quarterly planning with the whole team" }), "")
eq("email label is content", controlName({ accessibilityLabel: "Mail ram@x.io" }), "")
eq("nothing names it", controlName({}), "")
eq("tap event", gestureEvent("tap", "Inbox", { testID: "chat-9" }, 4), { kind: "tap", surface: "Inbox", element: "chat", ts: 4 })
eq("no screen yet", gestureEvent("tap", undefined, { testID: "send" }, 4), null)
eq("unnamed control", gestureEvent("long_press", "Inbox", { testID: "42" }, 4), null)
eq("long-press event", gestureEvent("long_press", "Thread", { testID: "chat-message-9" }, 4)?.kind, "long_press")
eq("swipe named by its gesture", gestureEvent("swipe", "Thread", { testID: "swipe-board" }, 4),
  { kind: "swipe", surface: "Thread", element: "swipe-board", ts: 4 })

// -- seen: once per control per screen visit (the web's rule) ------------------
const visit = new Set<string>()
eq("first sight of each name", seenEvents("Inbox", ["send", "send", "", "attach"], visit, 9).map((e) => e.element), ["send", "attach"])
eq("seen events are kind seen on the surface", seenEvents("Inbox", ["menu"], visit, 9)[0], { kind: "seen", surface: "Inbox", element: "menu", ts: 9 })
eq("same visit never repeats", seenEvents("Inbox", ["send", "menu"], visit, 10), [])
eq("a fresh visit counts again", seenEvents("Inbox", ["send"], new Set(), 11).length, 1)

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
eq("Tracked counts before the handler", /recordUse\([^)]*\)[^]*?handler\(e\)/.test(tracked), true)
eq("Tracked counts long-presses", /onLongPress=\{counted\("long_press"/.test(tracked), true)
eq("Tracked counts what is on screen", /useSeen\(props\.testID/.test(tracked), true)
// Every swipe that reports a use also reports being on screen (else it can
// never be flagged dead), and the other way round — one name, both calls.
const swipes: Record<string, { used: number; seen: number }> = {}
function scanSwipes(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { scanSwipes(p); continue }
    if (!/\.tsx?$/.test(name) || name.endsWith(".test.ts")) continue
    const src = readFileSync(p, "utf8")
    for (const m of src.matchAll(/recordSwipe\("([^"]+)"\)/g)) (swipes[m[1]] ??= { used: 0, seen: 0 }).used++
    for (const m of src.matchAll(/useSeen\("([^"]+)"/g)) (swipes[m[1]] ??= { used: 0, seen: 0 }).seen++
  }
}
scanSwipes(join(appRoot, "src"))
eq("swipes are wired", Object.keys(swipes).length >= 5, true)
eq("every swipe is both used and seen", Object.entries(swipes).filter(([, v]) => !v.used || !v.seen).map(([k]) => k), [])

console.log(`usage: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
