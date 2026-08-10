/**
 * texToUnicode — a best-effort, dependency-free renderer for SIMPLE inline TeX
 * (the `$A_k$`, `$\omega_k$`, `$x^2$` kind) into Unicode, so the fast native text
 * renderer can show it without spinning up a WebView per symbol. Complex inline
 * math (fractions, integrals, matrices) can't be expressed in Unicode — for those
 * `renderable()` returns false and the caller falls back to monospace source.
 *
 * Pure + unit-tested. Display equations ($$…$$) do NOT use this — they go through
 * the KaTeX WebView (MathView) for full fidelity.
 */

// Greek + common symbol commands → Unicode.
const SYM: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ",
  tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", leq: "≤", geq: "≥",
  neq: "≠", approx: "≈", equiv: "≡", infty: "∞", partial: "∂", nabla: "∇",
  sum: "∑", prod: "∏", int: "∫", sqrt: "√", to: "→", rightarrow: "→",
  leftarrow: "←", Rightarrow: "⇒", in: "∈", notin: "∉", forall: "∀",
  exists: "∃", cdots: "⋯", ldots: "…", propto: "∝", angle: "∠", degree: "°",
}

const SUB: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆",
  "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍",
  ")": "₎", a: "ₐ", e: "ₑ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ",
  n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
}

const SUP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶",
  "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽",
  ")": "⁾", n: "ⁿ", i: "ⁱ", a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ",
  k: "ᵏ", m: "ᵐ", t: "ᵗ", x: "ˣ", y: "ʸ",
}

function mapSeq(chars: string, table: Record<string, string>): string | null {
  let out = ""
  for (const ch of chars) {
    const u = table[ch]
    if (!u) return null
    out += u
  }
  return out
}

/** Convert simple TeX to Unicode, or return null if it needs real typesetting
 *  (fractions, integrals with bounds, environments, multi-char sub/superscripts
 *  a Unicode table can't express). */
export function texToUnicode(tex: string): string | null {
  // Reject constructs Unicode can't fake — bail to WebView/source for these.
  if (/\\(frac|begin|end|left|right|matrix|sum|int|prod)\b|\\\\|_\{[^}]{2,}\}|\^\{[^}]{2,}\}/.test(tex)) {
    // \sum/\int alone are fine as a symbol; only reject when they carry bounds (_{}/^{}).
    if (/\\(frac|begin|end|left|right|matrix)\b|\\\\|(?:_|\^)\{[^}]{2,}\}/.test(tex)) return null
  }
  let s = tex
  // \command → symbol (longest names first so \varepsilon beats \eta etc.)
  s = s.replace(/\\([A-Za-z]+)/g, (_m, name) => SYM[name] ?? `\\${name}`)
  if (s.includes("\\")) return null   // an unmapped \command remains → not renderable
  // Subscripts: _{abc} or _a
  s = s.replace(/_\{([^}]+)\}|_(\S)/g, (m, braced, single) => {
    const seq = braced ?? single
    return mapSeq(seq, SUB) ?? m
  })
  // Superscripts: ^{abc} or ^a
  s = s.replace(/\^\{([^}]+)\}|\^(\S)/g, (m, braced, single) => {
    const seq = braced ?? single
    return mapSeq(seq, SUP) ?? m
  })
  // If any sub/sup marker survived (couldn't map), it's not cleanly renderable.
  if (/[_^]/.test(s)) return null
  return s
}

/** Whether inline TeX can render acceptably as Unicode text (else caller shows
 *  the raw source in monospace). */
export function renderable(tex: string): boolean {
  return texToUnicode(tex) !== null
}
