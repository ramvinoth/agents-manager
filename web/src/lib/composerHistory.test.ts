import { userHistory, walksHistory, onFirstLine, onLastLine, stepHistory, searchHistory } from "./composerHistory.ts"
import type { Turn } from "./types.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const u = (content: string): Turn => ({ type: "user", domId: content, content })
const turns: Turn[] = [
  u("build it"), { type: "assistant", domId: "a", blocks: [] }, u("  build it "), u("fix the Test"), u(""), u("deploy"),
]
const hist = userHistory(turns)
eq("user messages only, oldest first, repeats and blanks dropped", hist, ["build it", "fix the Test", "deploy"])

eq("first line", [onFirstLine("ab\ncd", 2), onFirstLine("ab\ncd", 3)], [true, false])
eq("last line", [onLastLine("ab\ncd", 3), onLastLine("ab\ncd", 2)], [true, false])

eq("up in an empty composer recalls", walksHistory("", 0, false, true), true)
eq("up in a whitespace-only composer recalls", walksHistory("  \n", 0, false, true), true)
eq("up in a typed draft moves the caret", walksHistory("fix the bug", 4, false, true), false)
eq("up at the start of a typed draft still moves the caret", walksHistory("fix the bug", 0, false, true), false)
eq("down in a typed draft moves the caret", walksHistory("fix the bug", 11, false, false), false)
eq("down in an empty composer does nothing", walksHistory("", 0, false, false), false)
eq("browsing: up on the first line goes older", walksHistory("a\nb", 1, true, true), true)
eq("browsing: up below the first line moves the caret", walksHistory("a\nb", 3, true, true), false)
eq("browsing: down on the last line goes newer", walksHistory("a\nb", 3, true, false), true)
eq("browsing: down above the last line moves the caret", walksHistory("a\nb", 0, true, false), false)

eq("up from the draft recalls the newest", stepHistory(3, null, -1), 2)
eq("up walks older", stepHistory(3, 2, -1), 1)
eq("up stays on the oldest", stepHistory(3, 0, -1), 0)
eq("down walks newer", stepHistory(3, 1, 1), 2)
eq("down past the newest returns to the draft", stepHistory(3, 2, 1), null)
eq("down on the draft stays on the draft", stepHistory(3, null, 1), null)
eq("no history, no recall", stepHistory(0, null, -1), null)

eq("search finds the newest match", searchHistory(hist, "BUILD"), 0)
eq("search is case-insensitive", searchHistory(hist, "test"), 1)
eq("repeat search goes older", searchHistory(["a x", "b", "c x"], "x", 2), 0)
eq("no older match", searchHistory(["a x", "b", "c x"], "x", 0), -1)
eq("empty query matches the newest", searchHistory(hist, ""), 2)

console.log(`composerHistory: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
