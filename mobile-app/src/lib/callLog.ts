/**
 * callLog — pure logic for the Call log screen: merging pages of past calls,
 * and the labels shown for each call and transcript line. No React, no I/O.
 */

export type CallLine = { who: "caller" | "agent"; text: string; ts: number }
export type CallEntry = { call_id: string; started: number; duration: number; turns: number; transcript: CallLine[] }
export type CallLogPage = { calls: CallEntry[]; next: number | null }

/** Append an older page to what is loaded. A call already shown is kept once (a refresh can overlap). */
export function mergeCalls(loaded: CallEntry[], page: CallEntry[]): CallEntry[] {
  const seen = new Set(loaded.map(c => c.call_id))
  return [...loaded, ...page.filter(c => !seen.has(c.call_id))]
}

/** "Nov 14, 3:07 PM" in the phone's own zone (the owner's zone on the owner's phone). */
export function callWhen(startedSec: number, locale?: string): string {
  return new Date(startedSec * 1000).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

/** "45 s" under a minute, else "3 min 12 s". */
export function callLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return `${m} min ${s % 60} s`
}

/** One-line summary: the first thing the caller said, so rows are scannable. */
export function callPreview(call: CallEntry): string {
  const first = call.transcript.find(l => l.who === "caller") ?? call.transcript[0]
  return first ? first.text : "No words were recorded"
}

export function speakerLabel(who: CallLine["who"]): string {
  return who === "caller" ? "You" : "Agent"
}
