// usage.ts — what the owner actually touches in the web app, for the hot/dead
// control report agents read (server: viewer/usage.py, MCP usage_report).
//
// One delegated listener, no per-button wiring: a control's name is the first
// of data-track, aria-label, title or its visible text; its surface is the open
// dialog's title (else "main"). Events batch in memory and flush every 15 s and
// when the page hides, to the owner's own server only.

export type UsageKind = "seen" | "tap" | "view" | "feedback"
export type UsageEvent = { kind: UsageKind; surface: string; element?: string; detail?: string; ts: number }

export const NAME_MAX = 60
export const QUEUE_MAX = 500
export const TEXT_LABEL_MAX = 32

/** The plain facts read off a DOM control, so naming is testable without a DOM. */
export type ControlFacts = { track?: string | null; ariaLabel?: string | null; title?: string | null; text?: string | null }

/** A stable, human-readable control name, or "" when the control has none
 *  worth reporting (an unlabeled icon is a finding in itself, not a name). */
export function controlName(f: ControlFacts): string {
  for (const v of [f.track, f.ariaLabel, f.title, f.text]) {
    // Strip counts and ids that would split one control into many rows
    // ("Inbox 3", "#126") — the report is about the control, not its data.
    const clean = (v || "").replace(/#?\d+/g, "").replace(/\s+/g, " ").trim()
    if (!clean) continue
    // A title or visible text longer than a label is CONTENT (a session
    // title, a URL, a prompt): it would make one row per item, so such a
    // control reports by its data-track (list rows set one) or not at all.
    if ((v === f.text || v === f.title) && (clean.length > TEXT_LABEL_MAX || clean.split(" ").length > 4)) continue
    return clean.slice(0, NAME_MAX)
  }
  return ""
}

/** Append with a hard cap: if the server is unreachable for a long time the
 *  oldest events go first, so memory stays bounded. */
export function enqueue(queue: UsageEvent[], ev: UsageEvent, max = QUEUE_MAX): UsageEvent[] {
  const next = queue.length >= max ? queue.slice(queue.length - max + 1) : queue.slice()
  next.push(ev)
  return next
}

/** "seen" once per control per surface visit — the denominator for dead-control
 *  detection. Returns the events for names not already in `seen` (which it
 *  updates). */
export function seenEvents(surface: string, names: string[], seen: Set<string>, ts: number): UsageEvent[] {
  const out: UsageEvent[] = []
  for (const n of names) {
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push({ kind: "seen", surface, element: n, ts })
  }
  return out
}
