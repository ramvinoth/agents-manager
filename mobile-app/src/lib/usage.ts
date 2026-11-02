// usage.ts — which screens the owner opens on the phone, which controls are on
// them, which they use there (tap, long-press, swipe), plus in-app feedback,
// reported to the owner's own server (POST /api/usage; report: viewer/usage.py,
// MCP usage_report — the same hot/dead/cold digest the web feeds).
// Pure rules here; App.tsx feeds screen changes, components/Tracked.tsx feeds
// presses and what is on screen, swipe sites call recordSwipe, and
// lib/usageReporter.ts holds the queue and flushes it.

export type UseKind = "tap" | "long_press" | "swipe"
export type UsageKind = "seen" | UseKind | "view" | "feedback"
export type UsageEvent = { kind: UsageKind; surface: string; element?: string; detail?: string; ts: number }

export const QUEUE_MAX = 300
export const NAME_MAX = 60
export const LABEL_MAX = 32
const SEGMENT = /^[A-Za-z]{1,20}$/
const SEGMENTS_MAX = 5

/** The props a control carries that may name it. Never its visible text:
 *  that is the owner's content (a session title, a prompt, a file name). */
export type ControlFacts = { testID?: string | null; accessibilityLabel?: string | null }

/** testIDs are kebab-case and often end in an interpolated id, path or label
 *  (`chat-board-<uuid>`, `file-mention-<path>`, `auq-option-<label>`). Keep the
 *  leading plain-word segments and stop at the first one that looks like data,
 *  so one control is one row and no data leaves the phone. A short all-letter
 *  item name (`skill-<name>`) still reads as a word: such lists report a row
 *  per item, which names the owner's own skills, never their content. */
function testIdName(id: string): string {
  const out: string[] = []
  for (const seg of id.trim().split(/[-_]/)) {
    if (!SEGMENT.test(seg) || out.length === SEGMENTS_MAX) break
    out.push(seg)
  }
  return out.join("-")
}

/** An accessibility label is a short phrase ("Send", "Attach file"). Counts
 *  are stripped ("Inbox 3"); a long one, or one holding an email, path or URL,
 *  is content read aloud (`Open ${title}`) and names nothing. */
function labelName(label: string): string {
  const clean = label.replace(/#?\d+/g, "").replace(/\s+/g, " ").trim()
  if (!clean || /[@/]/.test(clean) || clean.length > LABEL_MAX || clean.split(" ").length > 4) return ""
  return clean
}

/** A stable control name, or "" when the control has none worth reporting
 *  (an unnamed button is a finding in itself, not a row). testID first: it is
 *  the developer's name for the control and does not change with the copy. */
export function controlName(f: ControlFacts): string {
  const name = (f.testID && testIdName(f.testID)) || (f.accessibilityLabel && labelName(f.accessibilityLabel)) || ""
  return name.slice(0, NAME_MAX)
}

/** A use of a control on the screen the owner is on, or null when it cannot be
 *  reported (no screen yet, or a control with no name). */
export function gestureEvent(kind: UseKind, surface: string | undefined, f: ControlFacts, ts: number): UsageEvent | null {
  const element = controlName(f)
  if (!surface || !element) return null
  return { kind, surface, element, ts }
}

/** "seen" once per control per screen visit — the denominator for dead-control
 *  detection, the same rule as the web's (web/src/lib/usage.ts seenEvents).
 *  Returns the events for names not already in `seen` (which it updates). */
export function seenEvents(surface: string, names: string[], seen: Set<string>, ts: number): UsageEvent[] {
  const out: UsageEvent[] = []
  for (const n of names) {
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push({ kind: "seen", surface, element: n, ts })
  }
  return out
}

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
