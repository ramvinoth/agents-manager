/**
 * Loop interval parsing/formatting. Mirrors web/src/lib/format.ts so a loop
 * created on mobile reads the same as one created on the web (e.g. "1h", "30m",
 * "45s"). Kept pure so the round-trip is unit-testable.
 */

/** Seconds → shortest human string ("1h" / "30m" / "45s"). */
export function fmtInterval(s: number): string {
  if (s % 3600 === 0) return s / 3600 + "h"
  if (s % 60 === 0) return s / 60 + "m"
  return s + "s"
}

/** Human string → seconds, clamped to [30, 86400]. Bare numbers = seconds. */
export function parseInterval(text: string): number {
  const t = String(text).trim().toLowerCase()
  const m = t.match(/^(\d+)\s*([smh]?)$/)
  let secs = 3600
  if (m) {
    const n = parseInt(m[1], 10)
    secs = m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : n
  }
  return Math.min(86400, Math.max(30, secs))
}
