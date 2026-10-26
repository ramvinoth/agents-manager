/**
 * chatList.ts — pure ordering for the Chats tab. No RN imports: unit-tested under node.
 */
import type { Session } from "../api/client"

export type ProjectGroup = { project: string; chats: Session[] }

/** Group chats by project (none → "No project"), the way any chat app orders
 *  folders: the group with the newest chat first, newest chat first inside. */
export function groupByProject(chats: Session[]): ProjectGroup[] {
  const groups = new Map<string, Session[]>()
  for (const s of [...chats].sort((a, b) => (b.modified || 0) - (a.modified || 0))) {
    const key = s.project || "No project"
    ;(groups.get(key) || groups.set(key, []).get(key)!).push(s)
  }
  // Insertion order is newest-chat-first, so each group already sits by its newest chat.
  return Array.from(groups, ([project, list]) => ({ project, chats: list }))
}
