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

/** The filter the Chats tab opens with. Project filtering is the default: the
 *  project the owner last picked, while it still has chats, else the project
 *  with the newest message. An explicit "all", unread or starred choice stands. */
export function defaultFilter(stored: unknown, chats: Session[]): ChatFilter {
  const live = chats.filter((s) => !s.archived)
  if (isStored(stored)) {
    if (stored.kind === "all") return null
    if (stored.kind !== "project") return stored
    if (live.some((s) => s.project === stored.project)) return stored
  }
  const newest = chatProjects(live)[0]
  return newest ? { kind: "project", project: newest } : null
}
