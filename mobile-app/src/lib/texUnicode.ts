/** Best-effort simple inline TeX. Complex formulas fall back to source text. */
const SYM: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ",
  tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", leq: "≤", geq: "≥",
  neq: "≠", approx: "≈", equiv: "≡", infty: "∞", partial: "∂", nabla: "∇",
  sum: "∑", prod: "∏", int: "∫", to: "→", rightarrow: "→",
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
export function texToUnicode(tex: string): string | null {
  if (/\\(frac|begin|end|left|right|matrix|sqrt)\b|\\\\|(?:_|\^)\{[^}]{2,}\}/.test(tex)) return null
  let s = tex.replace(/\\([A-Za-z]+)/g, (_m, name) => SYM[name] ?? `\\${name}`)
  if (s.includes("\\")) return null
  s = s.replace(/_\{([^}]+)\}|_(\S)/g, (m, braced, single) => mapSeq(braced ?? single, SUB) ?? m)
  s = s.replace(/\^\{([^}]+)\}|\^(\S)/g, (m, braced, single) => mapSeq(braced ?? single, SUP) ?? m)
  if (/[_^{}]/.test(s)) return null
  return s
}
