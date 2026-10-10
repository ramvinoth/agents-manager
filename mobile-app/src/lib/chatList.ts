/**
 * chatList.ts — pure ordering for the Chats tab. No RN imports: unit-tested under node.
 */
import type { Session } from "../api/client"

/** When the chat last had a message; `modified` from a server that predates it. */
export const activity = (s: Session) => s.last_message ?? s.modified ?? 0

export type ProjectGroup = { project: string; chats: Session[] }

/** Group chats by project (none → "No project"), the way any chat app orders
 *  folders: the group with the newest message first, newest chat first inside. */
export function groupByProject(chats: Session[]): ProjectGroup[] {
  const groups = new Map<string, Session[]>()
  for (const s of [...chats].sort((a, b) => activity(b) - activity(a))) {
    const key = s.project || "No project"
    ;(groups.get(key) || groups.set(key, []).get(key)!).push(s)
  }
  // Insertion order is newest-chat-first, so each group already sits by its newest message.
  return Array.from(groups, ([project, list]) => ({ project, chats: list }))
}
