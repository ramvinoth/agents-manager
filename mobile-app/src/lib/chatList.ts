/**
 * chatList.ts — pure ordering for the Chats tab. No RN imports: unit-tested under node.
 */
import type { Session } from "../api/client"

/** When the chat last had a message; `modified` from a server that predates it. */
export const activity = (s: Session) => s.last_message ?? s.modified ?? 0

/** The Chats tab's order: favorites first (a star pins a chat, as in any chat
 *  app), then the newest message first. */
export function orderChats(chats: Session[]): Session[] {
  return [...chats].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || activity(b) - activity(a))
}

export type ChatRow = { kind: "chat"; s: Session } | { kind: "header"; project: string; count: number }

/** The list's rows. Flat, or grouped by project: a header per project (the one
 *  with the newest message first, "No project" last-named bucket by activity),
 *  its chats under it unless collapsed. The archive view is always flat. */
export function chatRows(chats: Session[], grouped: boolean, collapsed: ReadonlySet<string>): ChatRow[] {
  if (!grouped) return chats.map((s) => ({ kind: "chat", s }))
  const groups = new Map<string, Session[]>()
  for (const s of chats) {
    const key = s.project || NO_PROJECT
    ;(groups.get(key) || groups.set(key, []).get(key)!).push(s)
  }
  const out: ChatRow[] = []
  for (const [project, list] of groups) {
    out.push({ kind: "header", project, count: list.length })
    if (!collapsed.has(project)) for (const s of list) out.push({ kind: "chat", s })
  }
  return out
}

export const NO_PROJECT = "No project"

/** The Chats search box's filter: one at a time, like a chat app's filter menu. */
export type ChatFilter = { kind: "unread" } | { kind: "starred" } | { kind: "project"; project: string } | null

/** A project's display name: the last folder of its path. */
export function projectName(p: string): string {
  const parts = p.split("/").filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

export function filterLabel(f: ChatFilter): string {
  if (!f) return ""
  return f.kind === "unread" ? "Unread" : f.kind === "starred" ? "Starred" : projectName(f.project)
}

/** The projects the filter menu offers: those with chats, the most recently active first. */
export function chatProjects(chats: Session[]): string[] {
  const seen = new Set<string>()
  for (const s of [...chats].sort((a, b) => activity(b) - activity(a))) if (s.project) seen.add(s.project)
  return [...seen]
}

/** What the Chats list shows: the archive or the main view, matching the search
 *  (title or project) and the filter, favorites first, then newest. */
export function visibleChats(chats: Session[], opts: { archived: boolean; query: string; filter: ChatFilter }): Session[] {
  const q = opts.query.trim().toLowerCase()
  const f = opts.filter
  return orderChats(chats.filter((s) =>
    !!s.archived === opts.archived &&
    (!q || (s.title || s.id).toLowerCase().includes(q) || (s.project || "").toLowerCase().includes(q)) &&
    (!f || (f.kind === "unread" ? !!s.unread : f.kind === "starred" ? !!s.favorite : s.project === f.project))))
}

/** The filter the Chats tab remembers per server and host. "all" is the owner's
 *  explicit "Show all chats", kept apart from "never chose" (undefined). */
export type StoredFilter = { kind: "unread" } | { kind: "starred" } | { kind: "project"; project: string } | { kind: "all" }

export function toStored(f: ChatFilter): StoredFilter {
  return f ?? { kind: "all" }
}

function isStored(v: unknown): v is StoredFilter {
  const k = (v as { kind?: unknown } | null)?.kind
  return k === "all" || k === "unread" || k === "starred" ||
    (k === "project" && typeof (v as { project?: unknown }).project === "string")
}

/** The filter the Chats tab opens with: the owner's remembered choice, else
 *  none, which shows every chat grouped by project. A remembered project that
 *  no longer has live chats falls back to all. */
export function defaultFilter(stored: unknown, chats: Session[]): ChatFilter {
  if (!isStored(stored) || stored.kind === "all") return null
  if (stored.kind !== "project") return stored
  return chats.some((s) => !s.archived && s.project === stored.project) ? stored : null
}

/** Grouping by project is the default; only an explicit `false` turns it off. */
export function isGrouped(stored: unknown): boolean {
  return stored !== false
}
