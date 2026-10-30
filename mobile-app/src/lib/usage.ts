// usage.ts — which screens the owner opens on the phone, which buttons they
// tap there, plus in-app feedback, reported to the owner's own server
// (POST /api/usage; report: viewer/usage.py, MCP usage_report).
// Pure rules here; App.tsx feeds screen changes, components/Tracked.tsx feeds
// taps, lib/usageReporter.ts holds the queue and flushes it.

export type UsageKind = "view" | "tap" | "feedback"
export type UsageEvent = { kind: UsageKind; surface: string; element?: string; detail?: string; ts: number }

export const QUEUE_MAX = 300
export const NAME_MAX = 60
export const LABEL_MAX = 32
const SEGMENT = /^[A-Za-z]{1,20}$/
const SEGMENTS_MAX = 5

/** The props a pressable carries that may name it. Never its visible text:
 *  that is the owner's content (a session title, a prompt, a file name). */
export type TapFacts = { testID?: string | null; accessibilityLabel?: string | null }

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
export function tapName(f: TapFacts): string {
  const name = (f.testID && testIdName(f.testID)) || (f.accessibilityLabel && labelName(f.accessibilityLabel)) || ""
  return name.slice(0, NAME_MAX)
}

/** A tap on the screen the owner is on, or null when it cannot be reported
 *  (no screen yet, or a control with no name). */
export function tapEvent(surface: string | undefined, f: TapFacts, ts: number): UsageEvent | null {
  const element = tapName(f)
  if (!surface || !element) return null
  return { kind: "tap", surface, element, ts }
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
