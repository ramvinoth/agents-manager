/**
 * Colour tokens for light and dark. Kept as plain data (no react-native import)
 * so contrast rules stay unit-testable — a dark theme that silently renders
 * dark-grey text on a dark-grey bubble is the classic failure here.
 */
export type Scheme = "light" | "dark"

export type Theme = {
  bg: string            // screen background
  surface: string       // cards, sheets, composer
  thread: string        // chat wallpaper
  bubbleUser: string
  bubbleAgent: string
  text: string
  textMuted: string
  border: string
  accent: string
  danger: string
  dangerBg: string      // subtle danger-tinted surface (error tool chips/results)
  chipBg: string
  inputBg: string
  codeBg: string        // code blocks + tool result panels
  codeText: string
}

export const LIGHT: Theme = {
  bg: "#fbf7f3",
  surface: "#f4ece4",
  thread: "#efe4d8",
  bubbleUser: "#f7ddc4",
  bubbleAgent: "#ffffff",
  text: "#2f2a25",
  textMuted: "#8f847a",
  border: "#ece0d3",
  accent: "#c86a2c",
  danger: "#b5544b",
  dangerBg: "#f2ddd9",
  chipBg: "#f0e6db",
  inputBg: "#ffffff",
  codeBg: "#f3ebe1",
  codeText: "#4a423a",
}

export const DARK: Theme = {
  bg: "#1a1613",
  surface: "#241e19",
  thread: "#130f0c",
  bubbleUser: "#3c2c1d",
  bubbleAgent: "#261f19",
  text: "#ece4da",
  textMuted: "#a3968a",
  border: "#352c24",
  accent: "#e0965a",
  danger: "#d98a80",
  dangerBg: "#3a251f",
  chipBg: "#2c241d",
  inputBg: "#261f19",
  codeBg: "#161210",
  codeText: "#d3ccc2",
}

export function themeFor(scheme: Scheme | null | undefined): Theme {
  return scheme === "dark" ? DARK : LIGHT
}

/** Resolve the effective scheme from the user's preference and the OS setting.
 *  "system" defers to the OS (which may be null → treated as light). Kept pure
 *  so the precedence is unit-testable. */
export function effectiveScheme(
  pref: "system" | "light" | "dark",
  os: Scheme | null | undefined
): Scheme {
  if (pref === "light" || pref === "dark") return pref
  return os === "dark" ? "dark" : "light"
}

/** Relative luminance per WCAG. */
function luminance(hex: string): number {
  const h = hex.replace("#", "")
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** WCAG contrast ratio between two hex colours (1–21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}
