/** Realtime invalidation events (server: viewer/live.py, /api/live/ws).
 *  An event only says "rows in this table changed" — the client refetches
 *  through the ordinary GET routes. These are the pure decisions; the socket
 *  lives in components/useLive.ts (watchLive for the store, useLive for views). */

export type LiveEvent =
  | { t: "hello" | "ping" | "resync" }
  | { t: "change"; table: string; id: unknown; op: string; project_id: number | null }

/** Does this event concern a view of `tables` scoped to `projectId`?
 *  resync always matches; a change with no project (inbox rows, the
 *  in-memory approval registry) matches every project; a view with no
 *  project (null) wants every project's changes. */
export function matches(ev: LiveEvent, tables: readonly string[], projectId: number | null): boolean {
  if (ev.t === "resync") return true
  if (ev.t !== "change") return false
  if (!tables.includes(ev.table)) return false
  return projectId == null || ev.project_id == null || ev.project_id === projectId
}

export function parse(raw: string): LiveEvent | null {
  try {
    const ev = JSON.parse(raw)
    return ev && typeof ev.t === "string" ? (ev as LiveEvent) : null
  } catch {
    return null
  }
}

/** Every table an open decision is derived from (inbox.py open_decisions_items):
 *  durable questions and plans, the engine's tool approvals, cards parked in
 *  Review/Needs-info, org Red approvals, and the inbox rows that carry snoozes. */
export const DECISION_TABLES = [
  "pending_questions", "pending_plans", "tool_approvals", "approvals", "cards", "inbox_messages",
] as const
