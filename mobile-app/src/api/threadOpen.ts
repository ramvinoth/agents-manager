/**
 * Opening a chat: the first read is a short tail (older pages load as the
 * user scrolls up), shared between the press-in prefetch on the Chats list and
 * the thread screen's own first load (lib/prefetch).
 */
import { api, type SessionPage } from "./client"
import { Prefetcher } from "../lib/prefetch"
import { activeServerId } from "../state/config"

// About 60 lines measured ~190 KB and under 50 ms on the server; 400 lines was
// 1.4 MB and ~350 ms. 80 keeps a screenful of turns in a tool-heavy chat.
export const OPEN_LINES = 80

const opens = new Prefetcher<SessionPage>()

export function openThreadPage(host: string, path: string): Promise<SessionPage> {
  return opens.get(`${activeServerId()}|${host}|${path}`, () => api.sessionReadPage(host, path, OPEN_LINES))
}

/** Start the read early (a finger is on the row); errors surface on the screen's own get. */
export function prefetchThread(host: string, path: string): void {
  openThreadPage(host, path).catch(() => {})
}
