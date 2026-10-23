import { renderMarkdownSegments } from "./markdown.ts"

let pass = 0, fail = 0
function ok(label: string, cond: boolean, got?: unknown) {
  if (cond) pass++
  else { fail++; console.log(`FAIL ${label}: ${JSON.stringify(got)}`) }
}
const html = (t: string, known: string[] = ["plan", "tom's plan"]) =>
  renderMarkdownSegments(t, { resolves: (x) => known.includes(x.toLowerCase()) }).map((s) => s.type === "html" ? s.html : "").join("")

let h = html("see [[Plan]] and [[Nope]]")
ok("resolved link", h.includes('class="wikilink" data-note="Plan"'), h)
ok("ghost link", h.includes('class="wikilink ghost" data-note="Nope"'), h)
h = html("[[Plan#Goals|the goals]] and [[Plan#Risks]]")
ok("alias shown", h.includes(">the goals</a>"), h)
ok("heading shown", h.includes(">Plan › Risks</a>"), h)
h = html("[[Tom's plan]]")
ok("apostrophe target", h.includes('data-note="Tom&#39;s plan"') && !h.includes("ghost"), h)
h = html("<b>[[x\" onclick=\"y]]</b>", [])
ok("no attribute breakout", !h.includes('onclick="') && !h.includes("<b>"), h)
h = html("`[[Plan]] #code` and #real-tag, issue #42 and C#")
ok("code untouched", h.includes("<code>[[Plan]] #code</code>"), h)
ok("tag chip", h.includes('<span class="note-tag" data-tag="real-tag">#real-tag</span>,'), h)
ok("numbers and C# not tags", !h.includes('data-tag="42"') && !h.includes('data-tag="c"'), h)
h = html("# Heading\n#Work/Q4- done")
ok("heading not a tag", h.includes("<h1>Heading</h1>"), h)
ok("nested tag lowercased, trailing - kept as text", h.includes('data-tag="work/q4">#Work/Q4</span>-'), h)
h = html("[[Plan|see #x]]")
ok("tag inside link text left alone", !h.includes("note-tag"), h)
h = html("```\n[[Plan]]\n```")
ok("fenced code untouched", !h.includes("wikilink"), h)

h = html("[R](docs/a.md) [W](https://x.y) [J](javascript:x) [P](//evil.com) [F](file:///a.md)")
ok("relative link is a file link", h.includes('class="file-link" data-file="docs/a.md"'), h)
ok("file url is a file link", h.includes('data-file="file:///a.md"'), h)
ok("web link opens a tab", h.includes('href="https://x.y" target="_blank"'), h)
ok("javascript and protocol-relative inert", !h.includes("javascript:") && !h.includes("evil.com\""), h)

console.log(`markdown: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
