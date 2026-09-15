/**
 * Job scheduling utilities. Two orthogonal axes, matching the server
 * (viewer/loops.py):
 *
 *   • interval — "every N seconds", a sliding cadence. Supports ANY value,
 *     including fractional units: 7.5 min → 450s, 7.5 h → 27000s. Clamped to
 *     [30s, 24h]. Cron cannot express a fractional-minute cadence (its finest
 *     grain is one integer minute, and a step like "every 7" resets at the top
 *     of each hour), so arbitrary cadences MUST use interval, never cron.
 *   • cron — a wall-clock anchor ("daily at 09:00"), 5-field (min hour dom
 *     month dow), evaluated in the server's local timezone. No drift.
 *
 * When both are present the server ignores interval; these helpers only ever
 * emit one or the other.
 */

// ---------------------------------------------------------------------------
// Interval (every N units)
// ---------------------------------------------------------------------------

/** The interval units the picker offers, with their second multipliers. */
export const INTERVAL_UNITS = [
  { value: "s", label: "Sec", secs: 1 },
  { value: "m", label: "Min", secs: 60 },
  { value: "h", label: "Hr", secs: 3600 },
] as const

export type IntervalUnit = (typeof INTERVAL_UNITS)[number]["value"]

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Seconds → the largest unit that yields a value ≥ 1, with up to two decimals.
 * 3600 → "1h", 1800 → "30m", 450 → "7.5m", 27000 → "7.5h", 45 → "45s".
 */
export function fmtInterval(s: number): string {
  const { value, unit } = splitInterval(s)
  return `${value}${unit}`
}

/**
 * Seconds → { value, unit } for pre-filling the picker: the largest unit whose
 * value is ≥ 1, rounded to two decimals. 3600 → 1h, 1800 → 30m, 27000 → 7.5h,
 * 450 → 7.5m, 45 → 45s. fmtInterval renders the same choice, so a value shown
 * as "7.5h" edits back into 7.5 + Hr.
 */
export function splitInterval(s: number): { value: number; unit: IntervalUnit } {
  if (s >= 3600) return { value: round2(s / 3600), unit: "h" }
  if (s >= 60) return { value: round2(s / 60), unit: "m" }
  return { value: round2(s), unit: "s" }
}

/**
 * Human string → seconds, clamped to [30, 86400]. Accepts decimals and an
 * optional unit suffix ("7.5m", "2h", "90"); bare numbers are seconds. Mirrors
 * the server's parse_interval so the client and server agree on every value.
 */
export function parseInterval(text: string): number {
  const t = String(text).trim().toLowerCase()
  const m = t.match(/^(\d+(?:\.\d+)?)\s*([smh]?)$/)
  let secs = 3600
  if (m) {
    const n = parseFloat(m[1])
    secs = m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : n
  }
  return Math.min(86400, Math.max(30, Math.round(secs)))
}

// ---------------------------------------------------------------------------
// Cron (at set times)
// ---------------------------------------------------------------------------

/** The wall-clock schedule kinds the calendar offers. */
export const CRON_KINDS = [
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
] as const

export type CronKind = (typeof CRON_KINDS)[number]["value"]

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

/**
 * Build a 5-field cron from the calendar selection.
 *
 * @param kind   - daily | weekdays | weekly | monthly
 * @param hour   - hour of day (0-23)
 * @param minute - minute (0-59)
 * @param dow    - day of week (0=Sun..6=Sat), used by "weekly"
 * @param dom    - day of month (1-28), used by "monthly"
 */
export function buildCron(kind: CronKind, hour: number, minute: number, dow: number, dom: number): string {
  switch (kind) {
    case "daily":
      return `${minute} ${hour} * * *`
    case "weekdays":
      return `${minute} ${hour} * * 1-5`
    case "weekly":
      return `${minute} ${hour} * * ${dow}`
    case "monthly":
      return `${minute} ${hour} ${dom} * *`
  }
}

/**
 * Parse a cron expression back into the calendar selection. Returns null if the
 * cron isn't one this picker can round-trip (e.g. a step or list expression).
 */
export function parseCron(cron: string): { kind: CronKind; hour: number; minute: number; dow: number; dom: number } | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length < 5) return null
  const [min, hr, dom, , dow] = parts
  const minute = parseInt(min, 10)
  const hour = parseInt(hr, 10)
  if (isNaN(minute) || isNaN(hour)) return null

  if (dow === "1-5" && dom === "*") return { kind: "weekdays", hour, minute, dow: 1, dom: 1 }
  if (dow !== "*" && dom === "*") return { kind: "weekly", hour, minute, dow: parseInt(dow, 10), dom: 1 }
  if (dom !== "*" && dow === "*") return { kind: "monthly", hour, minute, dow: 0, dom: parseInt(dom, 10) }
  if (dom === "*" && dow === "*") return { kind: "daily", hour, minute, dow: 0, dom: 1 }
  return null
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Human-readable description of a schedule (interval or cron). */
export function describeSchedule(job: { cron?: string; interval: number }): string {
  if (job.cron) return describeCron(job.cron)
  return `Every ${fmtInterval(job.interval)}`
}

/** Human-readable description of a cron expression. */
function describeCron(cron: string): string {
  const [min, hr, dom, , dow] = cron.split(" ")
  if (dow === "1-5") return `Weekdays at ${fmtTime12(+hr, +min)}`
  if (dow !== "*") return `${WEEKDAYS[+dow]}s at ${fmtTime12(+hr, +min)}`
  if (dom !== "*") return `${ordinal(+dom)} of month at ${fmtTime12(+hr, +min)}`
  return `Daily at ${fmtTime12(+hr, +min)}`
}

function fmtTime12(h: number, m: number): string {
  const ampm = h >= 12 ? "PM" : "AM"
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`
}

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return n + "th"
  switch (n % 10) {
    case 1: return n + "st"
    case 2: return n + "nd"
    case 3: return n + "rd"
    default: return n + "th"
  }
}

/** Format a nextRun epoch as a short local time string. */
export function fmtNextRun(epoch: number): string {
  const d = new Date(epoch * 1000)
  const now = new Date()
  const time = fmtTime12(d.getHours(), d.getMinutes())
  // Same day → just the time
  if (d.toDateString() === now.toDateString()) return time
  // Tomorrow
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`
  // Otherwise → short date
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`
}
