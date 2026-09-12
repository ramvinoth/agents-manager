/**
 * Job scheduling utilities. Generates cron expressions from a user-friendly
 * frequency + time/day selection, and formats them for display.
 *
 * The server (viewer/loops.py) evaluates the cron expression on each scheduler
 * tick to compute `nextRun`. All cron expressions are 5-field (minute hour dom
 * month dow), evaluated in the server's local timezone.
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

// ---------------------------------------------------------------------------
// Scheduling: frequency types + cron generation
// ---------------------------------------------------------------------------

export type Frequency =
  | "every_30m"
  | "hourly"
  | "every_2h"
  | "every_4h"
  | "every_6h"
  | "every_12h"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"

export const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "every_30m", label: "Every 30 min" },
  { value: "hourly", label: "Hourly" },
  { value: "every_2h", label: "Every 2 hours" },
  { value: "every_4h", label: "Every 4 hours" },
  { value: "every_6h", label: "Every 6 hours" },
  { value: "every_12h", label: "Every 12 hours" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
]

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

/** Whether a frequency needs a time-of-day picker. */
export function frequencyNeedsTime(freq: Frequency): boolean {
  return ["daily", "weekdays", "weekly", "monthly"].includes(freq)
}

/** Whether a frequency needs a day-of-week picker. */
export function frequencyNeedsDow(freq: Frequency): boolean {
  return freq === "weekly"
}

/** Whether a frequency needs a day-of-month picker. */
export function frequencyNeedsDom(freq: Frequency): boolean {
  return freq === "monthly"
}

/** Whether a frequency uses cron (vs plain interval). */
export function frequencyUsesCron(freq: Frequency): boolean {
  return !["every_30m", "hourly", "every_2h", "every_4h", "every_6h", "every_12h"].includes(freq)
}

/**
 * Build a cron expression or interval from the schedule parameters.
 *
 * @param freq - The frequency type
 * @param hour - Hour (0-23) for time-of-day frequencies
 * @param minute - Minute (0-59) for time-of-day frequencies
 * @param dow - Day of week (0=Sun..6=Sat) for weekly
 * @param dom - Day of month (1-31) for monthly
 *
 * Returns { cron } for cron-based or { interval } for interval-based.
 */
export function buildSchedule(
  freq: Frequency,
  hour: number,
  minute: number,
  dow: number,
  dom: number
): { cron?: string; interval?: number } {
  switch (freq) {
    case "every_30m":
      return { interval: 1800 }
    case "hourly":
      return { interval: 3600 }
    case "every_2h":
      return { interval: 7200 }
    case "every_4h":
      return { interval: 14400 }
    case "every_6h":
      return { interval: 21600 }
    case "every_12h":
      return { interval: 43200 }
    case "daily":
      return { cron: `${minute} ${hour} * * *` }
    case "weekdays":
      return { cron: `${minute} ${hour} * * 1-5` }
    case "weekly":
      return { cron: `${minute} ${hour} * * ${dow}` }
    case "monthly":
      return { cron: `${minute} ${hour} ${dom} * *` }
  }
}

/** Human-readable description of a schedule. */
export function describeSchedule(job: { cron?: string; interval: number }): string {
  if (job.cron) return describeCron(job.cron)
  return `Every ${fmtInterval(job.interval)}`
}

/** Human-readable description of a cron expression. */
function describeCron(cron: string): string {
  const [min, hr, dom, , dow] = cron.split(" ")
  const time = `${String(hr).padStart(2, "0")}:${String(min).padStart(2, "0")}`
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

/**
 * Parse a cron expression back into frequency + time + dow + dom.
 * Returns null if the cron can't be mapped to a known Frequency.
 */
export function parseCron(cron: string): { freq: Frequency; hour: number; minute: number; dow: number; dom: number } | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length < 5) return null
  const [min, hr, dom, , dow] = parts
  const minute = parseInt(min, 10)
  const hour = parseInt(hr, 10)
  if (isNaN(minute) || isNaN(hour)) return null

  if (dow === "1-5" && dom === "*") return { freq: "weekdays", hour, minute, dow: 1, dom: 1 }
  if (dow !== "*" && dom === "*") return { freq: "weekly", hour, minute, dow: parseInt(dow, 10), dom: 1 }
  if (dom !== "*" && dow === "*") return { freq: "monthly", hour, minute, dow: 0, dom: parseInt(dom, 10) }
  if (dom === "*" && dow === "*") return { freq: "daily", hour, minute, dow: 0, dom: 1 }
  return null
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
