/**
 * The Projects rail as a tree: which projects show, which are open, and which
 * of their chats are listed. Pure, so the filter rules are tested without a browser.
 */
import type { Group } from "./projectGroups.ts"
import type { SessionListItem } from "./types.ts"

export interface TreeNode {
  group: Group
  /** Its sub-projects and chats are listed beneath it. */
  open: boolean
  /** The chats to list (empty when shut). */
  sessions: SessionListItem[]
  /** Chats held back behind "Show N more" (only when unfiltered). */
  more: number
  /** Projects in folders under this one (unfiltered only; a filter lists matches flat). */
  children: TreeNode[]
  /** Running chats and unread replies in the sub-projects, so a shut parent still shows activity. */
  subRunning: number
  subUnread: boolean
}

/** An open project lists this many chats before "Show N more". */
export const CHAT_LIMIT = 8

// A home folder holds every project under it; nesting them all there would
// only add a level, so it never acts as a parent.
const HOME = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|~)$/

/**
 * Each project's parent: the nearest other project whose folder contains it
 * (a home folder excepted). Missing = a root.
 */
export function projectParents(groups: readonly Group[]): Map<string, string> {
  const dirs = new Set(groups.map((g) => g.dir))
  const out = new Map<string, string>()
  for (const g of groups) {
    for (let d = g.dir.slice(0, g.dir.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) {
      if (dirs.has(d)) {
        if (!HOME.test(d)) out.set(g.dir, d)
        break
      }
    }
  }
  return out
}

/**
 * With no filter: projects nest under the project whose folder holds them,
 * in `groups` order; an open project lists its sub-projects, then its chats,
 * capped at CHAT_LIMIT unless `showAll` holds it. With a filter: a flat list —
 * a project shows when its name or any chat title matches; chat matches open
 * it to just those chats, a name-only match keeps its open state and lists all
 * its chats.
 */
export function projectTree(
  groups: Group[],
  filter: string,
  open: ReadonlySet<string>,
  showAll: ReadonlySet<string> = new Set(),
  name: (g: Group) => string = (g) => g.project,
): TreeNode[] {
  const f = filter.trim().toLowerCase()
  const leaf = (g: Group, isOpen: boolean, sessions: SessionListItem[], more = 0): TreeNode =>
    ({ group: g, open: isOpen, sessions, more, children: [], subRunning: 0, subUnread: false })
  if (f) {
    const out: TreeNode[] = []
    for (const g of groups) {
      const hits = g.sessions.filter((s) => (s.title || "").toLowerCase().includes(f))
      if (hits.length) out.push(leaf(g, true, hits))
      else if (name(g).toLowerCase().includes(f)) {
        const isOpen = open.has(g.dir)
        out.push(leaf(g, isOpen, isOpen ? g.sessions : []))
      }
    }
    return out
  }
  const parents = projectParents(groups)
  const kids = new Map<string, Group[]>()
  for (const g of groups) {
    const p = parents.get(g.dir) ?? ""
    kids.set(p, [...(kids.get(p) ?? []), g])
  }
  const build = (g: Group): TreeNode => {
    const isOpen = open.has(g.dir)
    const cap = isOpen && !showAll.has(g.dir) ? CHAT_LIMIT : Infinity
    const sessions = isOpen ? g.sessions.slice(0, cap) : []
    const node = leaf(g, isOpen, sessions, isOpen ? g.sessions.length - sessions.length : 0)
    for (const c of (kids.get(g.dir) ?? []).map(build)) {
      node.subRunning += c.group.running + c.subRunning
      node.subUnread ||= c.group.unread || c.subUnread
      if (isOpen) node.children.push(c)
    }
    return node
  }
  return (kids.get("") ?? []).map(build)
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
