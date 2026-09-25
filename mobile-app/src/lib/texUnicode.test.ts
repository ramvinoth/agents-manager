import assert from "node:assert/strict"
import { test } from "node:test"
import { texToUnicode } from "./texUnicode.ts"
import { buildMathHtml } from "./mathHtml.ts"
import { parseInline, parseMarkdown } from "./markdown.ts"

test("simple TeX maps to Unicode; unsupported structure stays source", () => {
  for (const [tex, expected] of [["A_k", "Aₖ"], ["\\omega_k", "ωₖ"], ["\\phi_k", "φₖ"], ["x^2", "x²"], ["E=mc^2", "E=mc²"], ["\\alpha + \\beta", "α + β"], ["A_{1}", "A₁"], ["a \\leq b", "a ≤ b"], ["\\int_{0}^{1} x", "∫₀¹ x"]]) assert.equal(texToUnicode(tex), expected)
  for (const tex of ["\\frac{a}{b}", "A_{ij}", "\\foobar x", "\\sqrt{x+1}", "{x}"]) assert.equal(texToUnicode(tex), null)
})
test("math parsing preserves code, currency, following prose and incomplete blocks", () => {
  assert.deepEqual(parseInline("`$x$`"), [{ t: "code", s: "$x$" }])
  assert.deepEqual(parseInline("$5 and $6"), [{ t: "text", s: "$5 and $6" }])
  assert.deepEqual(parseInline("price $5 then $x^2$"), [{ t: "text", s: "price $5 then " }, { t: "math", s: "x^2" }])
  assert.deepEqual(parseInline("\\(A_k\\)"), [{ t: "math", s: "A_k" }])
  assert.deepEqual(parseMarkdown("$$x$$ trailing"), [{ t: "mathblock", text: "x" }, { t: "p", spans: [{ t: "text", s: "trailing" }] }])
  assert.deepEqual(parseMarkdown("\\[\nx^2\n\\]"), [{ t: "mathblock", text: "x^2" }])
  assert.deepEqual(parseMarkdown("$$\nunfinished\n# Still a heading").map((b) => b.t), ["p", "h"])
  assert.deepEqual(parseMarkdown("```tex\n$$x$$\n```"), [{ t: "code", lang: "tex", text: "$$x$$" }])
})
test("math HTML cannot break out of its script or inject error markup", () => {
  const html = buildMathHtml('</script><script>alert(1)</script><img onerror="boom">', "red;bad:css")
  assert.ok(!html.includes("<script>alert"))
  assert.ok(html.includes("\\u003c/script>"))
  assert.ok(!html.includes("innerHTML"))
  assert.ok(!html.includes("red;bad"))
  assert.ok(html.includes("trust:false"))
})
