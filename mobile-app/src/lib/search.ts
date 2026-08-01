/**
 * In-thread search: find which rendered items match a query so the list can
 * jump between them (WhatsApp-style chevrons, "2 of 7").
 */
import type { ThreadItem } from "./thread"

/** The searchable text of one thread item. Non-thread rows (e.g. the live
 *  "working" placeholder) have no searchable text. */
export function itemText(item: ThreadItem): string {
  if (item.kind === "user" || item.kind === "system") return item.text || ""
  if (item.kind === "exchange") {
    const steps = item.steps.map((b) => (b.kind === "text" ? b.text : b.name)).join(" ")
    return `${item.finalText} ${steps}`.trim()
  }
  return "" // unknown/sentinel rows are not searchable
}

/** Indices of items matching the query (case-insensitive substring). */
export function findMatches(items: ThreadItem[], query: string): number[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return [] // 1-char queries match everything and jump wildly
  const out: number[] = []
  items.forEach((it, i) => {
    if (itemText(it).toLowerCase().includes(q)) out.push(i)
  })
  return out
}

/** Step through matches; direction +1/-1, wraps around. */
export function stepMatch(matches: number[], current: number, dir: 1 | -1): number {
  if (!matches.length) return -1
  const pos = matches.indexOf(current)
  if (pos === -1) return dir === 1 ? matches[0] : matches[matches.length - 1]
  return matches[(pos + dir + matches.length) % matches.length]
}

/**
 * Unread bookkeeping for the chat list. The map is persisted as JSON in
 * SecureStore, which has small value limits — so it is trimmed to the most
 * recently seen entries rather than growing forever.
 */
export function trimSeen(seen: Record<string, number>, max = 80): Record<string, number> {
  const entries = Object.entries(seen)
  if (entries.length <= max) return seen
  entries.sort((a, b) => b[1] - a[1]) // keep the most recently seen
  return Object.fromEntries(entries.slice(0, max))
}

/** A chat is unread when it changed after we last opened it. Never-opened chats
 *  are NOT unread — flooding a fresh install with 90 green dots is noise. */
export function isUnread(seen: Record<string, number>, path: string, modified?: number): boolean {
  const last = seen[path]
  if (!last || !modified) return false
  return modified > last
}
