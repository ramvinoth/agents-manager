/**
 * The Projects rail as a tree: which projects show, which are open, and which
 * of their chats are listed. Pure, so the filter rules are tested without a browser.
 */
import type { Group } from "./projectGroups.ts"
import type { SessionListItem } from "./types.ts"

export interface TreeNode {
  group: Group
  /** Its chats are listed beneath it. */
  open: boolean
  /** The chats to list (empty when shut). */
  sessions: SessionListItem[]
  /** Chats held back behind "Show N more" (only when unfiltered). */
  more: number
}

/** An open project lists this many chats before "Show N more". */
export const CHAT_LIMIT = 8

/**
 * With no filter: every project, its chats listed when it is open, capped at
 * CHAT_LIMIT unless `showAll` holds it. With a filter: a project shows when its
 * name or any chat title matches; chat matches open it to just those chats,
 * a name-only match keeps its open state and lists all its chats.
 */
export function projectTree(
  groups: Group[],
  filter: string,
  open: ReadonlySet<string>,
  showAll: ReadonlySet<string> = new Set(),
  name: (g: Group) => string = (g) => g.project,
): TreeNode[] {
  const f = filter.trim().toLowerCase()
  const out: TreeNode[] = []
  for (const g of groups) {
    if (!f) {
      const isOpen = open.has(g.dir)
      const cap = isOpen && !showAll.has(g.dir) ? CHAT_LIMIT : Infinity
      const sessions = isOpen ? g.sessions.slice(0, cap) : []
      out.push({ group: g, open: isOpen, sessions, more: isOpen ? g.sessions.length - sessions.length : 0 })
      continue
    }
    const hits = g.sessions.filter((s) => (s.title || "").toLowerCase().includes(f))
    if (hits.length) out.push({ group: g, open: true, sessions: hits, more: 0 })
    else if (name(g).toLowerCase().includes(f)) {
      const isOpen = open.has(g.dir)
      out.push({ group: g, open: isOpen, sessions: isOpen ? g.sessions : [], more: 0 })
    }
  }
  return out
}

/**
 * Two projects can share a folder name ("web" under two repos). Each label is
 * the folder name; a colliding one also carries its parent folder as a hint,
 * so the rows can be told apart at a glance.
 */
export function projectLabels(paths: readonly string[]): Map<string, { name: string; hint: string }> {
  const seg = (p: string) => p.split("/").filter(Boolean)
  const count = new Map<string, number>()
  for (const p of paths) {
    const n = seg(p).at(-1) ?? p
    count.set(n, (count.get(n) ?? 0) + 1)
  }
  const out = new Map<string, { name: string; hint: string }>()
  for (const p of paths) {
    const parts = seg(p)
    const name = parts.at(-1) ?? p
    out.set(p, { name, hint: (count.get(name) ?? 0) > 1 ? parts.at(-2) ?? "" : "" })
  }
  return out
}
