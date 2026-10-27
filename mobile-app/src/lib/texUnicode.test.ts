import { texToUnicode } from "./texUnicode.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++ }
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

// Simple subscripts / Greek — the reported case.
eq("A_k", texToUnicode("A_k"), "Aₖ")
eq("omega_k", texToUnicode("\\omega_k"), "ωₖ")
eq("phi_k", texToUnicode("\\phi_k"), "φₖ")
eq("x^2", texToUnicode("x^2"), "x²")
eq("E=mc^2", texToUnicode("E=mc^2"), "E=mc²")
eq("alpha+beta", texToUnicode("\\alpha + \\beta"), "α + β")
eq("braced sub single", texToUnicode("A_{1}"), "A₁")
eq("leq", texToUnicode("a \\leq b"), "a ≤ b")

// Not renderable → null (fall back to WebView/source).
eq("frac -> null", texToUnicode("\\frac{a}{b}"), null)
eq("multichar sub -> null", texToUnicode("A_{ij}"), null)
eq("unknown cmd -> null", texToUnicode("\\foobar x"), null)
// Single-digit braced bounds DO map (bonus): \int_{0}^{1} x -> ∫₀¹ x
eq("integral single-digit bounds", texToUnicode("\\int_{0}^{1} x"), "∫₀¹ x")

console.log(`${pass} passing${fail ? `, ${fail} FAILING` : ""}`)
if (fail) process.exit(1)
