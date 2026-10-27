// Terminal-style composer history: Up/Down walk this chat's past messages,
// Ctrl+R searches them backwards. Pure so it is tested without a browser.
import type { Turn } from "./types.ts"

/** This chat's user messages, oldest first, with immediate repeats collapsed (like bash's ignoredups). */
export function userHistory(turns: Turn[]): string[] {
  const out: string[] = []
  for (const t of turns) {
    if (t.type !== "user") continue
    const s = t.content.trim()
    if (s && out[out.length - 1] !== s) out.push(s)
  }
  return out
}

/** Up only recalls when the caret sits on the first line; Down only on the last — otherwise the keys move the caret. */
export function onFirstLine(text: string, caret: number): boolean {
  return !text.slice(0, caret).includes("\n")
}
export function onLastLine(text: string, caret: number): boolean {
  return !text.slice(caret).includes("\n")
}

/**
 * Index of the next history entry in `dir` (-1 = older, +1 = newer) from `at`
 * (null = editing the draft). Returns null when stepping past the newest (back to
 * the draft); stays put at the oldest.
 */
export function stepHistory(len: number, at: number | null, dir: -1 | 1): number | null {
  if (!len) return null
  if (at === null) return dir < 0 ? len - 1 : null
  const next = at + dir
  if (next >= len) return null
  return Math.max(0, next)
}

/** Newest entry strictly older than `before` (default: all) containing `query`, case-insensitively. -1 when none. */
export function searchHistory(hist: string[], query: string, before = hist.length): number {
  const q = query.toLowerCase()
  for (let i = Math.min(before, hist.length) - 1; i >= 0; i--) {
    if (hist[i].toLowerCase().includes(q)) return i
  }
  return -1
}
