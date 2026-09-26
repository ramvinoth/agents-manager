/**
 * The cross-session decision queue (card #60) — pure display helpers for the
 * board's decisions band. The queue itself is the server's ONE read of the
 * existing sources (GET /api/decisions/open): durable questions, durable
 * plans, live tool approvals — oldest first. These helpers only format it.
 */

/** "waiting 3m" from a wait in seconds. Non-positive / unknown = "now". */
export function fmtWaiting(sec: number): string {
  if (!sec || sec < 0) return "now"
  if (sec < 60) return `${Math.floor(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}
