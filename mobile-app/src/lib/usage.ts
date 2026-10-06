// usage.ts — which screens the owner opens on the phone, plus in-app feedback,
// reported to the owner's own server (POST /api/usage; report: viewer/usage.py).
// Pure queue rules here; App.tsx feeds screen changes, the API client flushes.

export type UsageKind = "view" | "feedback"
export type UsageEvent = { kind: UsageKind; surface: string; detail?: string; ts: number }

export const QUEUE_MAX = 300

/** Append with a hard cap — offline for days, the oldest go first. */
export function enqueue(queue: UsageEvent[], ev: UsageEvent, max = QUEUE_MAX): UsageEvent[] {
  const next = queue.length >= max ? queue.slice(queue.length - max + 1) : queue.slice()
  next.push(ev)
  return next
}

/** A screen view only when the focused screen actually changed — a re-render
 *  or param update on the same screen is not a new visit. */
export function screenChange(prev: string | undefined, next: string | undefined, ts: number): UsageEvent | null {
  if (!next || next === prev) return null
  return { kind: "view", surface: next, ts }
}
