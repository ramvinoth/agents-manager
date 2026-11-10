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
