// Tests for the markdown renderer.
//
// There were none before, which is why a renderer that wrapped every single
// line in its own <p> shipped and stayed. Every case below is a defect that was
// actually present, or a capability that must not regress while fixing them.
//
// Run: npm test  (node --test, TypeScript natively — no new dependency)

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { renderMarkdownSegments, esc, extractMath } from "./markdown.ts"

/** The whole message as one HTML string, for assertions that don't care about
 *  segment boundaries. Mermaid segments are marked so their absence is visible. */
function html(src: string): string {
  return renderMarkdownSegments(src)
    .map((s) => (s.type === "html" ? s.html : `<MERMAID>${s.source}</MERMAID>`))
    .join("")
}

/** How many times `needle` occurs — paragraph COUNT is the thing under test, so
 *  an assertion on it has to count rather than match. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe("paragraphs — the defect this file exists for", () => {
  test("consecutive lines are ONE paragraph, not one each", () => {
    const out = html("The first line.\nThe second line.\nThe third line.")
    assert.equal(count(out, "<p>"), 1)
  })

  test("a blank line starts a new paragraph", () => {
    const out = html("First thought.\n\nSecond thought.")
    assert.equal(count(out, "<p>"), 2)
    assert.match(out, /<p>First thought\.<\/p><p>Second thought\.<\/p>/)
  })

  test("several blank lines still produce exactly two paragraphs", () => {
    assert.equal(count(html("One.\n\n\n\nTwo."), "<p>"), 2)
  })

  test("a single newline REFLOWS — it does not force the model's wrap width", () => {
    // Models hard-wrap prose near 80 columns. If each of those newlines became
    // a <br>, every paragraph would break at the model's width regardless of
    // the reader's pane, and the CSS measure cap could never apply. A soft
    // break therefore joins with a space (CommonMark).
    const out = html("Line one.\nLine two.")
    assert.match(out, /<p>Line one\. Line two\.<\/p>/)
    assert.doesNotMatch(out, /<br>/)
  })

  test("two trailing spaces still force an explicit line break", () => {
    assert.match(html("Address line one.  \nAddress line two."), /<p>Address line one\.<br>Address line two\.<\/p>/)
  })

  test("a trailing backslash also forces a line break", () => {
    assert.match(html("First.\\\nSecond."), /<p>First\.<br>Second\.<\/p>/)
  })

  test("no empty paragraphs are emitted", () => {
    assert.equal(count(html("\n\n  \n\nText.\n\n  \n"), "<p></p>"), 0)
  })
})

describe("headings", () => {
  test("all six levels render", () => {
    for (let n = 1; n <= 6; n++) {
      const out = html(`${"#".repeat(n)} Title`)
      assert.match(out, new RegExp(`<h${n}>Title</h${n}>`), `h${n} missing`)
    }
  })

  test("a heading is not absorbed into the paragraph above it", () => {
    const out = html("Intro text.\n## Section\nBody text.")
    assert.match(out, /<p>Intro text\.<\/p><h2>Section<\/h2><p>Body text\.<\/p>/)
  })

  test("# without a space is not a heading", () => {
    assert.match(html("#hashtag"), /<p>#hashtag<\/p>/)
  })

  test("inline formatting works inside a heading", () => {
    assert.match(html("## A **bold** word"), /<h2>A <strong>bold<\/strong> word<\/h2>/)
  })
})

describe("lists", () => {
  test("an ordered list produces <ol>, not <ul>", () => {
    // The old renderer wrapped <ul> before ordered <li>s existed, so a numbered
    // list silently rendered with bullets.
    const out = html("1. first\n2. second\n3. third")
    assert.match(out, /<ol>/)
    assert.doesNotMatch(out, /<ul>/)
    assert.equal(count(out, "<li>"), 3)
  })

  test("an ordered list starting at n keeps its numbering", () => {
    assert.match(html("4. four\n5. five"), /<ol start="4">/)
  })

  test("a bullet list produces one <ul> wrapping all items", () => {
    const out = html("- a\n- b\n- c")
    assert.equal(count(out, "<ul>"), 1)
    assert.equal(count(out, "<li>"), 3)
  })

  test("a nested list is nested, not flattened", () => {
    const out = html("- outer\n  - inner\n- outer two")
    assert.equal(count(out, "<ul>"), 2)
    assert.match(out, /<li>outer<ul><li>inner<\/li><\/ul><\/li>/)
  })

  test("bullets then numbers are two separate lists", () => {
    const out = html("- a\n- b\n\n1. one\n2. two")
    assert.equal(count(out, "<ul>"), 1)
    assert.equal(count(out, "<ol>"), 1)
  })

  test("a task list renders real checkboxes", () => {
    const out = html("- [x] done\n- [ ] todo")
    assert.match(out, /class="task-list"/)
    assert.match(out, /<input type="checkbox" disabled checked>/)
    assert.match(out, /<input type="checkbox" disabled>/)
    assert.doesNotMatch(out, /\[x\]/)
  })

  test("a paragraph after a list is not swallowed by it", () => {
    const out = html("- a\n- b\n\nAfter the list.")
    assert.match(out, /<\/ul><p>After the list\.<\/p>/)
  })

  test("* and + are bullets too", () => {
    assert.equal(count(html("* a\n+ b"), "<li>"), 2)
  })
})

describe("blockquotes", () => {
  test("a multi-line quote is ONE blockquote", () => {
    // Previously each line became its own <blockquote>.
    const out = html("> line one\n> line two\n> line three")
    assert.equal(count(out, "<blockquote>"), 1)
  })

  test("a quote contains block structure, not raw text", () => {
    const out = html("> first para\n>\n> second para")
    assert.equal(count(out, "<blockquote>"), 1)
    assert.equal(count(out, "<p>"), 2)
  })

  test("a list inside a quote renders as a list", () => {
    assert.match(html("> - a\n> - b"), /<blockquote><ul><li>a<\/li><li>b<\/li><\/ul><\/blockquote>/)
  })
})

describe("tables", () => {
  test("a GFM table renders with a header and body", () => {
    const out = html("| A | B |\n| --- | --- |\n| 1 | 2 |")
    assert.match(out, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead>/)
    assert.match(out, /<tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody>/)
  })

  test("column alignment from the separator row is applied", () => {
    const out = html("| L | C | R |\n| :-- | :-: | --: |\n| a | b | c |")
    assert.match(out, /<th style="text-align:left">L<\/th>/)
    assert.match(out, /<th style="text-align:center">C<\/th>/)
    assert.match(out, /<th style="text-align:right">R<\/th>/)
  })

  test("a short row is padded to the header width", () => {
    const out = html("| A | B | C |\n| - | - | - |\n| 1 |")
    assert.equal(count(out, "<td"), 3)
  })

  test("text after a table is a paragraph, not another row", () => {
    const out = html("| A |\n| - |\n| 1 |\n\nAfter.")
    assert.match(out, /<\/table><p>After\.<\/p>/)
  })

  test("a pipe line with no separator row stays a paragraph", () => {
    assert.match(html("| not | a table |"), /<p>/)
  })
})

describe("code", () => {
  test("a fenced block is a <pre> and is never parsed as markdown", () => {
    const out = html("```js\nconst a = 1 // # not a heading\n```")
    assert.match(out, /<pre data-lang="js"><code class="language-js">/)
    assert.doesNotMatch(out, /<h1>/)
  })

  test("an unterminated fence still renders as code (streaming)", () => {
    const out = html("Here:\n```python\ndef f():\n    return 1")
    assert.match(out, /<code class="language-python">/)
    assert.doesNotMatch(out, /```/)
  })

  test("an inline code span is not touched by emphasis rules", () => {
    const out = html("Use `a_b_c` and `*not italic*`.")
    assert.match(out, /<code>a_b_c<\/code>/)
    assert.match(out, /<code>\*not italic\*<\/code>/)
    assert.doesNotMatch(out, /<em>/)
  })

  test("html inside a code span is escaped", () => {
    assert.match(html("`<script>`"), /<code>&lt;script&gt;<\/code>/)
  })

  test("markdown between two fences still renders", () => {
    const out = html("```\na\n```\n\n## Middle\n\n```\nb\n```")
    assert.match(out, /<h2>Middle<\/h2>/)
    assert.equal(count(out, "<pre"), 2)
  })
})

describe("mermaid", () => {
  test("a mermaid fence becomes its own segment, not HTML", () => {
    const segs = renderMarkdownSegments("Before.\n\n```mermaid\ngraph TD; A-->B;\n```\n\nAfter.")
    assert.equal(segs.length, 3)
    assert.equal(segs[0].type, "html")
    assert.equal(segs[1].type, "mermaid")
    assert.equal(segs[2].type, "html")
    assert.equal(segs[1].type === "mermaid" && segs[1].source, "graph TD; A-->B;")
  })

  test("the surrounding prose still renders as paragraphs", () => {
    const segs = renderMarkdownSegments("Before.\n\n```mermaid\ngraph TD;\n```\n\nAfter.")
    assert.match(segs[0].type === "html" ? segs[0].html : "", /<p>Before\.<\/p>/)
    assert.match(segs[2].type === "html" ? segs[2].html : "", /<p>After\.<\/p>/)
  })

  test("MERMAID in capitals is still a diagram", () => {
    const segs = renderMarkdownSegments("```MERMAID\ngraph TD;\n```")
    assert.equal(segs[0].type, "mermaid")
  })
})

describe("inline formatting", () => {
  test("bold, italic, bold-italic and strikethrough", () => {
    assert.match(html("**b**"), /<strong>b<\/strong>/)
    assert.match(html("*i*"), /<em>i<\/em>/)
    assert.match(html("***bi***"), /<strong><em>bi<\/em><\/strong>/)
    assert.match(html("~~s~~"), /<del>s<\/del>/)
  })

  test("snake_case is NOT italicised", () => {
    // The single most common false positive in technical writing.
    const out = html("Call user_name_field and file_name.py here.")
    assert.doesNotMatch(out, /<em>/)
  })

  test("underscore emphasis at word boundaries still works", () => {
    assert.match(html("_emphasis_ here"), /<em>emphasis<\/em>/)
    assert.match(html("__strong__ here"), /<strong>strong<\/strong>/)
  })

  test("a link gets a safe href and opens in a new tab", () => {
    const out = html("[docs](https://example.com/x)")
    assert.match(out, /<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer">docs<\/a>/)
  })

  test("a javascript: url is neutralised", () => {
    const out = html("[x](javascript:alert(1))")
    assert.match(out, /href="#"/)
    assert.doesNotMatch(out, /javascript:/)
  })

  test("an image renders as <img>, not as a link with a stray !", () => {
    const out = html("![alt text](https://example.com/i.png)")
    assert.match(out, /<img src="https:\/\/example\.com\/i\.png" alt="alt text" loading="lazy">/)
    assert.doesNotMatch(out, /!<a/)
  })
})

describe("security", () => {
  test("raw html in message text is escaped", () => {
    const out = html('<img src=x onerror="alert(1)">')
    assert.doesNotMatch(out, /<img src=x/)
    assert.match(out, /&lt;img/)
  })

  test("a script tag never survives", () => {
    assert.doesNotMatch(html("<script>alert(1)</script>"), /<script>/)
  })

  test("esc covers the five dangerous characters", () => {
    assert.equal(esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;")
  })

  test("a forged placeholder sentinel cannot substitute stashed html", () => {
    // The renderer lifts code spans and math out of the text and leaves a
    // private-use sentinel behind. A message that contains the sentinel itself
    // must not be able to impersonate one and have stashed HTML spliced in.
    const out = html("\uE000" + "0" + "\uE000" + " and `real code`")
    assert.match(out, /<code>real code<\/code>/)
    // The forged marker is gone, and exactly one <code> element exists.
    assert.doesNotMatch(out, /[\uE000-\uE002]/)
    assert.equal(count(out, "<code>"), 1)
  })
})

describe("math", () => {
  test("inline math renders through KaTeX", () => {
    assert.match(html("Let $E = mc^2$ hold."), /class="katex"/)
  })

  test("display math is a block, not wrapped in a paragraph", () => {
    const out = html("$$\n\\int_0^1 x\\,dx\n$$")
    assert.match(out, /katex-display|class="katex"/)
    assert.doesNotMatch(out, /<p><span class="katex/)
  })

  test("a price is not math", () => {
    const out = html("It cost $5 and $6 total.")
    assert.doesNotMatch(out, /class="katex"/)
    assert.match(out, /\$5/)
  })

  test("extractMath leaves an escaped dollar literal", () => {
    assert.equal(extractMath("\\$5", () => "X"), "$5")
  })

  test("underscores inside math are not italicised", () => {
    const out = html("$a_1 + a_2$")
    assert.doesNotMatch(out, /<em>/)
  })
})

describe("horizontal rules and edge cases", () => {
  test("--- is a rule, not an empty list or a heading", () => {
    const out = html("Above.\n\n---\n\nBelow.")
    assert.equal(count(out, "<hr>"), 1)
    assert.equal(count(out, "<p>"), 2)
  })

  test("empty and non-string input returns no segments", () => {
    assert.deepEqual(renderMarkdownSegments(""), [])
    assert.deepEqual(renderMarkdownSegments(null as unknown as string), [])
    assert.deepEqual(renderMarkdownSegments(undefined as unknown as string), [])
  })

  test("whitespace-only input produces no empty paragraph", () => {
    assert.equal(html("   \n\n  \n"), "")
  })

  test("a realistic structured answer keeps every block distinct", () => {
    const out = html(
      [
        "## Summary",
        "",
        "The first paragraph explains the situation",
        "across two source lines.",
        "",
        "The second paragraph is separate.",
        "",
        "### Steps",
        "",
        "1. Do the first thing",
        "2. Do the second thing",
        "",
        "> A caveat worth reading",
        "> before step three.",
        "",
        "| Option | Cost |",
        "| --- | ---: |",
        "| A | 1 |",
      ].join("\n")
    )
    assert.equal(count(out, "<h2>"), 1)
    assert.equal(count(out, "<h3>"), 1)
    assert.equal(count(out, "<ol>"), 1)
    assert.equal(count(out, "<blockquote>"), 1)
    assert.equal(count(out, "<table>"), 1)
    // Three paragraphs: the two prose ones, plus the one inside the blockquote.
    // The point of the count is that it is THREE and not SEVEN — the old
    // renderer emitted one <p> per source line, so the two-line paragraph and
    // the two-line quote each became two.
    assert.equal(count(out, "<p>"), 3)
    // The two source lines of the first paragraph REFLOW into one <p>, so the
    // paragraph breaks at the reader's width rather than at the model's.
    assert.match(out, /<p>The first paragraph explains the situation across two source lines\.<\/p>/)
  })
})
