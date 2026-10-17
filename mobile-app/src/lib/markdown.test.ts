/**
 * Markdown parser tests. Run: node --experimental-strip-types src/lib/markdown.test.ts
 * The "real agent reply" fixture is taken verbatim from a thread screenshot
 * where this content rendered as raw markdown — the bug this module fixes.
 */
import assert from "node:assert"
import { blockGap, parseInline, parseMarkdown } from "./markdown.ts"

let passed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
  } catch (e) {
    console.error(`✖ ${name}\n  ${(e as Error).message}`)
    process.exitCode = 1
  }
}

test("bold", () => {
  assert.deepEqual(parseInline("a **b** c"), [
    { t: "text", s: "a " },
    { t: "bold", s: "b" },
    { t: "text", s: " c" },
  ])
})

test("inline code keeps ** literal inside", () => {
  const spans = parseInline("run `a ** b` now")
  assert.equal(spans[1].t, "code")
  assert.equal((spans[1] as any).s, "a ** b")
})

test("italic with single asterisk, not mid-word", () => {
  assert.equal(parseInline("*hi*")[0].t, "italic")
  assert.deepEqual(parseInline("a*b*c"), [{ t: "text", s: "a*b*c" }])
})

test("links: markdown and bare url", () => {
  const md = parseInline("see [docs](https://x.dev/a)")
  assert.equal(md[1].t, "link")
  assert.equal((md[1] as any).href, "https://x.dev/a")
  const bare = parseInline("go https://y.dev now")
  assert.equal(bare[1].t, "link")
})

test("headings", () => {
  const b = parseMarkdown("## Title here")
  assert.equal(b[0].t, "h")
  assert.equal((b[0] as any).level, 2)
})

test("fenced code is verbatim, no inline parsing", () => {
  const b = parseMarkdown("```js\nconst a = **b**\n```")
  assert.equal(b[0].t, "code")
  assert.equal((b[0] as any).lang, "js")
  assert.equal((b[0] as any).text, "const a = **b**")
})

test("bullet and numbered lists", () => {
  const b = parseMarkdown("- one\n- two\n1. three")
  assert.equal(b.length, 3)
  assert.equal((b[0] as any).marker, "•")
  assert.equal((b[2] as any).ordered, true)
  assert.equal((b[2] as any).marker, "1.")
})

test("nested list depth", () => {
  const b = parseMarkdown("- top\n  - nested")
  assert.equal((b[0] as any).depth, 0)
  assert.equal((b[1] as any).depth, 1)
})

test("table with header + rows", () => {
  const b = parseMarkdown("| Item | Status |\n|---|---|\n| suha-ai | Back online |\n| UI | Healthy |")
  assert.equal(b[0].t, "table")
  assert.deepEqual((b[0] as any).header, ["Item", "Status"])
  assert.equal((b[0] as any).rows.length, 2)
  assert.deepEqual((b[0] as any).rows[0], ["suha-ai", "Back online"])
})

test("blockquote and hr", () => {
  const b = parseMarkdown("> quoted\n\n---")
  assert.equal(b[0].t, "quote")
  assert.equal(b[1].t, "hr")
})

test("paragraphs split on blank lines", () => {
  const b = parseMarkdown("one\n\ntwo")
  assert.equal(b.length, 2)
  assert.equal(b[0].t, "p")
})

test("real agent reply from the thread screenshot", () => {
  const src = [
    "🎉 **Run 002 is training** — step 10/600, loss 1.63, 540 tok/s, GPU at 100%.",
    "",
    "**Iteration report:**",
    "",
    "| Item | Status |",
    "|---|---|",
    "| suha-ai | ✅ Back online after ~1.5 h outage |",
    "| Observatory UI | ✅ Healthy and serving |",
    "",
    "- 600 steps, single GPU",
    "- ~5–6 h ETA",
  ].join("\n")
  const b = parseMarkdown(src)
  const kinds = b.map((x) => x.t)
  assert.ok(kinds.includes("table"), "table detected")
  assert.ok(kinds.includes("li"), "list detected")
  // The headline paragraph must expose a bold span rather than literal asterisks.
  const first: any = b[0]
  assert.equal(first.t, "p")
  assert.ok(first.spans.some((s: any) => s.t === "bold" && s.s === "Run 002 is training"))
  const table: any = b.find((x) => x.t === "table")
  assert.deepEqual(table.header, ["Item", "Status"])
  assert.equal(table.rows.length, 2)
})

test("plain text passes through unchanged", () => {
  const b = parseMarkdown("just a sentence")
  assert.deepEqual(b, [{ t: "p", spans: [{ t: "text", s: "just a sentence" }] }])
})

test("block gaps: sections open wide, lists stay tight, paragraphs separate", () => {
  const b = parseMarkdown("intro\n\n## Plan\n### Step\nfirst para\n\nsecond para\n\n- a\n- b\n\nafter\n\n### Next")
  assert.deepEqual(b.map((x, i) => [x.t, blockGap(b[i - 1], x)]), [
    ["p", 0], ["h", 24], ["h", 8], ["p", 6], ["p", 12], ["li", 12], ["li", 4], ["p", 12], ["h", 18],
  ])
})

test("notes: chat text never gets note syntax", () => {
  assert.deepEqual(parseInline("see [[Plan]] #work"), [{ t: "text", s: "see [[Plan]] #work" }])
})

test("notes: [[links]] with heading and alias", () => {
  assert.deepEqual(parseInline("a [[Plan]] b", true), [
    { t: "text", s: "a " }, { t: "wikilink", target: "Plan", s: "Plan" }, { t: "text", s: " b" },
  ])
  assert.deepEqual(parseInline("[[Plan#Risks]]", true), [{ t: "wikilink", target: "Plan", s: "Plan › Risks" }])
  assert.deepEqual(parseInline("[[Plan|the plan]]", true), [{ t: "wikilink", target: "Plan", s: "the plan" }])
  assert.deepEqual(parseInline("[[Alice's idea]]", true), [{ t: "wikilink", target: "Alice's idea", s: "Alice's idea" }])
  assert.deepEqual(parseInline("[[#Local]]", true), [{ t: "text", s: "[[#Local]]" }])
})

test("notes: links inside code stay literal", () => {
  assert.deepEqual(parseInline("`[[x]] #y`", true), [{ t: "code", s: "[[x]] #y" }])
  const b = parseMarkdown("```\n[[x]]\n```", true)
  assert.deepEqual(b, [{ t: "code", lang: "", text: "[[x]]" }])
})

test("notes: #tags — not numbers, not C#, nested lower-cased, trailing dash dropped", () => {
  assert.deepEqual(parseInline("#Work and (#q4)", true), [
    { t: "tag", s: "#Work", tag: "work" }, { t: "text", s: " and (" }, { t: "tag", s: "#q4", tag: "q4" }, { t: "text", s: ")" },
  ])
  assert.deepEqual(parseInline("issue #42 in C#", true), [{ t: "text", s: "issue #42 in C#" }])
  assert.deepEqual(parseInline("#Area/Sub-", true), [{ t: "tag", s: "#Area/Sub", tag: "area/sub" }, { t: "text", s: "-" }])
})

test("notes: a heading line is a heading, its tags still chips", () => {
  const b = parseMarkdown("# Title #idea", true)
  assert.deepEqual(b, [{ t: "h", level: 1, spans: [{ t: "text", s: "Title " }, { t: "tag", s: "#idea", tag: "idea" }] }])
})

console.log(`${passed} passing`)
