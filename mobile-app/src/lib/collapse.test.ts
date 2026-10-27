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

// ── Short messages are never collapsed ──────────────────────────────────────
eq("empty", collapsePreview(""), { collapsed: false, preview: "", hiddenLines: 0 })
eq("one line", collapsePreview("Hey there"), { collapsed: false, preview: "Hey there", hiddenLines: 0 })

const short = Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n")
ok("exactly at the line limit stays open", !collapsePreview(short).collapsed)

// A message just over the line limit isn't worth a tap — MIN_HIDDEN_LINES guards it.
ok("two lines over stays open", !collapsePreview(short + "\nx\ny").collapsed)

// ── Long messages collapse ──────────────────────────────────────────────────
const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")
const c = collapsePreview(long)
ok("40 lines collapses", c.collapsed)
eq("preview keeps maxLines", c.preview.split("\n").length, 14)
eq("hidden count is the remainder", c.hiddenLines, 26)
ok("preview is a prefix of the source", long.startsWith(c.preview))

// ── Char limit trips independently of the line limit ────────────────────────
const wide = "w".repeat(2000)
const w = collapsePreview(wide)
ok("one very long line collapses", w.collapsed)
ok("no word boundary → cut at the char limit", w.preview.length === 900)
ok("unbroken run is not gutted", w.preview.length > 700)

const words = (" word".repeat(400)).trim()
const ww = collapsePreview(words)
ok("wordy text collapses", ww.collapsed)
ok("cut lands on a word boundary", !ww.preview.endsWith("wor"))
ok("word-boundary cut stays near the limit", ww.preview.length > 900 * 0.8)

// ── Fence repair: a cut inside ``` must not leave the parser hanging ────────
const fenced = "intro\n```js\n" + Array.from({ length: 40 }, (_, i) => `const x${i} = ${i}`).join("\n") + "\n```\ntail"
const f = collapsePreview(fenced)
ok("fenced block collapses", f.collapsed)
const fences = f.preview.split("\n").filter((l) => /^\s*```/.test(l)).length
eq("preview has balanced fences", fences % 2, 0)
ok("repair appends a closing fence", f.preview.endsWith("```"))

// A cut that lands OUTSIDE a fence must not gain a stray one.
const evenFence = "```\na\n```\n" + Array.from({ length: 30 }, (_, i) => `p${i}`).join("\n")
const ef = collapsePreview(evenFence)
eq("balanced fences left alone", ef.preview.split("\n").filter((l) => /^\s*```/.test(l)).length % 2, 0)

// ── Never claims to hide more than exists ───────────────────────────────────
for (const s of ["", "a", short, long, wide, words, fenced]) {
  const r = collapsePreview(s)
  ok(`hiddenLines >= 0 (${s.length})`, r.hiddenLines >= 0)
  ok(`collapsed implies shorter (${s.length})`, !r.collapsed || r.preview.length < s.length + 4)
  ok(`not collapsed implies identity (${s.length})`, r.collapsed || r.preview === s)
}

console.log(`collapse: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
