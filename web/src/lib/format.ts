// Small formatting helpers — ported from the vanilla viewer-format.js.

export function fmtAgo(sec?: number): string {
  if (!sec) return ""
  const d = Date.now() / 1000 - sec
  if (d < 60) return "just now"
  if (d < 3600) return Math.floor(d / 60) + "m ago"
  if (d < 86400) return Math.floor(d / 3600) + "h ago"
  if (d < 7 * 86400) return Math.floor(d / 86400) + "d ago"
  return new Date(sec * 1000).toLocaleDateString()
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"
  return n + ""
}

export function fmtBytes(b: number): string {
  return (b / 1048576).toFixed(1) + " MB"
}

export function fmtDuration(ms: number): string {
  if (!ms) return ""
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

export function fmtInterval(s: number): string {
  if (s % 3600 === 0) return s / 3600 + "h"
  if (s % 60 === 0) return s / 60 + "m"
  return s + "s"
}

export function parseInterval(text: string): number {
  const t = String(text).trim().toLowerCase()
  const m = t.match(/^(\d+)\s*([smh]?)$/)
  let secs = 3600
  if (m) {
    const n = parseInt(m[1], 10)
    secs = m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : m[2] === "s" ? n : n
  }
  return Math.min(86400, Math.max(30, secs))
}

/** Final path segment (the project/dir name) from a full directory path. */
export function projectName(p: string): string {
  const parts = String(p).split("/").filter(Boolean)
  return parts[parts.length - 1] || p
}
