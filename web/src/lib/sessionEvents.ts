/** The session events channel (server: viewer/events.py, /api/events/ws) as
 *  the web's run engine (store/runtime.ts) uses it: which frames mean what,
 *  the watch frame naming the open transcript, and which polls the channel
 *  replaces right now. The events say WHEN to fetch; the data still comes
 *  from the ordinary GET routes. Pure, node-tested.
 *
 *  The phone reads the same channel (mobile-app/src/lib/liveEvents.ts). */

export type SessionEvent =
  | { type: "hello" | "ping" | "resync" | "list-changed" }
  | { type: "turn-start" | "turn-end" | "status-changed"; session: string }
  | { type: "transcript-changed"; session: string; size?: number; uuid?: string }
  | { type: "watching"; session: string; ok: boolean }

const PLAIN = new Set(["hello", "ping", "resync", "list-changed"])
const PER_SESSION = new Set(["turn-start", "turn-end", "status-changed", "transcript-changed", "watching"])

/** A frame, or null (garbage, or a type from a newer server — ignored). */
export function parseSessionEvent(raw: string): SessionEvent | null {
  let ev: any
  try {
    ev = JSON.parse(raw)
  } catch {
    return null
  }
  if (!ev || typeof ev.type !== "string") return null
  if (PLAIN.has(ev.type)) return ev as SessionEvent
  if (!PER_SESSION.has(ev.type) || typeof ev.session !== "string") return null
  if (ev.type === "watching" && typeof ev.ok !== "boolean") return null
  return ev as SessionEvent
}

export interface WatchSpec {
  session: string
  host: string
  agent: string
  /** The transcript's path as the session routes take it (projects/… for Claude). */
  path: string
}

/** The frame telling the server which transcripts this client has open
 *  (it replaces the last one; none = watch nothing). */
export function watchFrame(specs: WatchSpec[]): string {
  return JSON.stringify({ type: "watch", sessions: specs })
}

/** What the run engine does about one event, given the open session:
 *  "transcript" read the new lines, "status" re-check the run, "list"
 *  refetch the chat list, "catch-up" all of these (events were missed). */
export type Reaction = "transcript" | "status" | "list" | "catch-up" | null

export function reactTo(ev: SessionEvent, openSession: string): Reaction {
  switch (ev.type) {
    case "resync":
      return "catch-up"
    case "list-changed":
      return "list"
    case "transcript-changed":
      return openSession && ev.session === openSession ? "transcript" : null
    case "turn-start":
    case "turn-end":
    case "status-changed":
      return openSession && ev.session === openSession ? "status" : null
    default:
      return null // hello / ping prove the stream alive; watching updates coverage
  }
}

/** Fallback transcript reads happen on every poll tick during a run and on
 *  every IDLE_EVERY-th tick otherwise (an idle chat can still be written by a
 *  CLI in a terminal, but nobody is waiting on it). */
export const IDLE_EVERY = 5

/** Whether this poll tick must read the transcript itself: no, while the
 *  stream is live and the server said it sees this transcript (watching
 *  ok) — its transcript-changed events drive the reads then. */
export function pollTranscript(live: boolean, seen: boolean, running: boolean, tick: number): boolean {
  if (live && seen) return false
  return running || tick % IDLE_EVERY === 0
}

/** Whether the run watcher must ask /api/chat/status itself: only while the
 *  stream is down. Live, every run this server drives — on any host —
 *  reports turn-start / turn-end / status-changed. */
export function pollStatus(live: boolean): boolean {
  return !live
}
