import { collapsePreview } from "./collapse.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}
function ok(label: string, cond: boolean) {
  if (cond) pass++
  else { fail++; console.log(`FAIL ${label}`) }
}

const lines = (n: number, w = "line") => Array.from({ length: n }, (_, i) => `${w}${i}`).join("\n")

// --- below the thresholds: never collapse ---
eq("empty", collapsePreview(""), { collapsed: false, preview: "", hiddenLines: 0 })
eq("one line", collapsePreview("hello"), { collapsed: false, preview: "hello", hiddenLines: 0 })
eq("exactly 14 lines stays open", collapsePreview(lines(14)).collapsed, false)
// 15 lines hides only 1 — below MIN_HIDDEN_LINES, so not worth a click.
eq("15 lines stays open (min-hidden)", collapsePreview(lines(15)).collapsed, false)
eq("16 lines stays open (min-hidden)", collapsePreview(lines(16)).collapsed, false)

// --- over the line threshold ---
const big = collapsePreview(lines(40))
eq("40 lines collapses", big.collapsed, true)
eq("40 lines hides 26", big.hiddenLines, 26)
ok("preview is a prefix of the source", lines(40).startsWith(big.preview))
ok("preview is shorter", big.preview.length < lines(40).length)

// --- over the char threshold, independently of line count ---
const wide = "x".repeat(2000)
const w = collapsePreview(wide)
eq("single 2000-char line collapses", w.collapsed, true)
// No space to break on: the preview must keep the full budget, not get gutted
// back to the last word boundary (there isn't one).
eq("unbroken run previews at full budget", w.preview.length, 900)

const withSpaces = ("word ".repeat(400)).trim()
const ws = collapsePreview(withSpaces)
eq("long prose collapses", ws.collapsed, true)
ok("cuts on a word boundary", !ws.preview.endsWith("wor") && !ws.preview.endsWith("wo"))
ok("word-boundary cut stays near budget", ws.preview.length > 900 * 0.8)

// --- fence repair: the reason the preview is a source slice, not rendered HTML ---
const fenced = "intro\n```js\n" + lines(40, "const a = ")
const f = collapsePreview(fenced)
eq("fenced block collapses", f.collapsed, true)
const fenceCount = (s: string) => s.split("\n").filter((l) => /^\s*```/.test(l)).length
eq("cut inside a fence is closed", fenceCount(f.preview) % 2, 0)
ok("repair appends a closing fence", f.preview.trimEnd().endsWith("```"))

// A preview that happens to land on balanced fences must not gain a stray one.
const balanced = "```\nshort\n```\n" + lines(30)
eq("balanced fences stay balanced", fenceCount(collapsePreview(balanced).preview) % 2, 0)

// --- custom thresholds ---
eq("respects custom maxLines", collapsePreview(lines(10), 4, 10_000).collapsed, true)
eq("custom maxLines hidden count", collapsePreview(lines(10), 4, 10_000).hiddenLines, 6)

// --- hostile / degenerate input ---
// The renderer hands us turn.content, which is typed string but arrives from JSON.
eq("undefined", collapsePreview(undefined as unknown as string).collapsed, false)
eq("null", collapsePreview(null as unknown as string).preview, "")
eq("whitespace only", collapsePreview("   \n  \n ").collapsed, false)
eq("CRLF counts lines", collapsePreview("a\r\n".repeat(40)).collapsed, true)

// --- invariants that must hold for every input ---
for (const t of ["", "hi", lines(3), lines(40), wide, withSpaces, fenced, balanced, "\n\n\n"]) {
  const r = collapsePreview(t)
  ok("hiddenLines never negative", r.hiddenLines >= 0)
  ok("collapsed implies a shorter preview", !r.collapsed || r.preview.length < t.length + 4)
  ok("not collapsed implies identity", r.collapsed || r.preview === (t ?? ""))
  ok("not collapsed implies zero hidden", r.collapsed || r.hiddenLines === 0)
}

console.log(`${pass} passing${fail ? `, ${fail} FAILING` : ""}`)
if (fail) process.exit(1)
