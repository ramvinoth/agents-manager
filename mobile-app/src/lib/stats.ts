/**
 * Formatting for the session-info screen. Pure, so the number formatting and
 * ranking are unit-tested rather than eyeballed on a phone.
 */

/** Compact counts: 1234 → "1.2k", 1500000 → "1.5M". */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return "0"
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n))
  if (abs < 1_000_000) {
    const v = n / 1000
    return `${abs < 10_000 ? v.toFixed(1) : Math.round(v)}k`
  }
  const v = n / 1_000_000
  return `${abs < 10_000_000 ? v.toFixed(1) : Math.round(v)}M`
}

/** Tools sorted by use, most-used first — the useful ordering for a summary. */
export function topTools(tools: Record<string, number>, limit = 8): { name: string; count: number }[] {
  return Object.entries(tools || {})
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/** Human duration between two ISO timestamps. */
export function durationBetween(start?: string, end?: string): string {
  if (!start || !end) return ""
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ""
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/** Strip the vendor prefix so model names fit on a phone. */
export function shortModel(m: string): string {
  return (m || "").replace(/^claude-/, "").replace(/-\d{8}$/, "")
}
