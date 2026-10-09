/**
 * decisions.ts — pure walking logic for the decision cockpit (mirrors
 * mobile-app/src/lib/decisions.ts). The cockpit walks a FROZEN snapshot of
 * GET /api/decisions/open so the live poll never reshuffles the item under the
 * reader; resolved items are marked and never landed on again.
 */

/** Scan from `from` in `dir` for the first index NOT in `resolved`. No wrap:
 *  a worklist has an end. Nothing open that way → stay put. */
export function stepDecision(len: number, from: number, dir: 1 | -1, resolved: Set<number>): number {
  for (let i = from + dir; i >= 0 && i < len; i += dir) {
    if (!resolved.has(i)) return i
  }
  return from
}

/** The first unresolved index at or after `from`, falling back to searching
 *  backward. -1 only when EVERY item is resolved. */
export function firstOpen(len: number, from: number, resolved: Set<number>): number {
  if (from >= 0 && from < len && !resolved.has(from)) return from
  for (let i = from + 1; i < len; i++) if (!resolved.has(i)) return i
  for (let i = Math.min(from, len) - 1; i >= 0; i--) if (!resolved.has(i)) return i
  return -1
}

/** Open the cockpit from one inbox row: the queue re-ordered so that row's
 *  session comes first (so "next" stays in the conversation being read), and
 *  the row's index — -1 when the queue does not list it right now (snoozed or
 *  decided elsewhere). */
export function queueFrom<T extends { session: string; inbox_id: number }>(
  queue: T[], inboxId: number, session: string,
): { ordered: T[]; at: number } {
  const ordered = [...queue.filter((d) => d.session === session), ...queue.filter((d) => d.session !== session)]
  return { ordered, at: inboxId ? ordered.findIndex((d) => d.inbox_id === inboxId) : -1 }
}
