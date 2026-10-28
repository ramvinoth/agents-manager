import { canvasDragWidth, storedCanvasWidth, showSucceeded, splitSlides, themedHtml } from "./canvas.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const OK = '{"shown": true, "title": "Flow", "version": 1}'

// --- showSucceeded ---
eq("in flight", showSucceeded(null), false)
eq("tool error", showSucceeded(OK, true), false)
eq("server refusal", showSucceeded('{"error": "content required"}'), false)
eq("shown", showSucceeded(OK), true)
eq("shown as content array", showSucceeded([{ type: "text", text: OK }]), true)

// --- splitSlides ---
eq("single slide", splitSlides("# A\ntext"), ["# A\ntext"])
eq("three slides", splitSlides("# A\n---\n# B\n  ---  \n# C"), ["# A", "# B", "# C"])
eq("--- inside a code fence stays", splitSlides("# A\n```yaml\n---\nk: v\n```\n---\n# B"), ["# A\n```yaml\n---\nk: v\n```", "# B"])
eq("empty slides dropped", splitSlides("---\n# A\n---\n---\n"), ["# A"])
eq("empty content keeps one slide", splitSlides(""), [""])

// --- themedHtml ---
const T = { bg: "black", fg: "white", dark: true }
const th = (s: string) => themedHtml(s, T)
eq("fragment gets defaults first", th("<p>hi</p>").startsWith('<meta name="viewport"'), true)
eq("fragment content kept", th("<p>hi</p>").endsWith("<p>hi</p>"), true)
eq("doctype stays first", th("<!DOCTYPE html><html><head><title>x</title></head></html>").startsWith("<!DOCTYPE html><html><head><meta"), true)
eq("no head: after <html>", th('<html lang="en"><body>x</body></html>').startsWith('<html lang="en"><meta'), true)
eq("doctype only: after it", th("<!doctype html><p>x</p>").startsWith("<!doctype html><meta"), true)
eq("agent's viewport kept, none added", (th('<head><meta name="viewport" content="width=500"></head>').match(/viewport/g) || []).length, 1)
eq("agent's style comes after ours", th("<head><style>body{background:red}</style></head>").indexOf("background:black") < th("<head><style>body{background:red}</style></head>").indexOf("background:red"), true)
eq("dark scheme", th("x").includes("color-scheme:dark"), true)
eq("light scheme", themedHtml("x", { ...T, dark: false }).includes("color-scheme:light"), true)
eq("<header> is not <head>", th("<header>h</header>").startsWith('<meta name="viewport"'), true)

// Divider drag: clamp to [min, viewport - chat room], close when dragged nearly shut.
eq("drag mid", canvasDragWidth(500.4, 1400), 500)
eq("drag below min clamps", canvasDragWidth(200, 1400), 280)
eq("drag nearly shut closes", canvasDragWidth(120, 1400), "close")
eq("drag past chat room clamps", canvasDragWidth(1300, 1400), 1040)
eq("stored ok", storedCanvasWidth("612"), 612)
eq("stored junk", storedCanvasWidth("abc"), null)
eq("stored missing", storedCanvasWidth(null), null)
eq("stored too small", storedCanvasWidth("100"), null)

console.log(`canvas: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
