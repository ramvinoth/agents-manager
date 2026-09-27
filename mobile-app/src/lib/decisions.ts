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

/**
 * The cockpit walks a FROZEN snapshot of the queue (the live poll must not
 * reshuffle the item under the reader's thumb mid-decision). As items are
 * resolved they're marked in `resolved` and must never be landed on again —
 * neither by auto-advance after a decision, nor by the reader tapping ‹ / ›.
 *
 * Scan from `from` in `dir` for the first index NOT in `resolved`. No wrap: a
 * worklist has an end. If nothing remains that way, stay put (the caller reads
 * "you're at the last open item"). Pure and total — unit-tested without a
 * simulator, per the lib/ boundary.
 */
export function stepDecision(len: number, from: number, dir: 1 | -1, resolved: Set<number>): number {
  for (let i = from + dir; i >= 0 && i < len; i += dir) {
    if (!resolved.has(i)) return i
  }
  return from
}

/** The first unresolved index at or after `from` (used when the current item
 *  is resolved and we must land on the next live one, staying if `from` itself
 *  is still open). Falls back to searching backward so a resolved tail still
 *  lands somewhere open. Returns -1 only when EVERY item is resolved. */
export function firstOpen(len: number, from: number, resolved: Set<number>): number {
  if (from >= 0 && from < len && !resolved.has(from)) return from
  for (let i = from + 1; i < len; i++) if (!resolved.has(i)) return i
  for (let i = Math.min(from, len) - 1; i >= 0; i--) if (!resolved.has(i)) return i
  return -1
}
