/**
 * Where a tapped push goes. The server sets the payload (orchestrator/inbox.py,
 * orchestrator/push.py); this maps it to one screen, synchronously, so the tap
 * navigates in the same frame instead of after a network read.
 *
 *   {card}            → that board card
 *   {note}            → that note
 *   {screen}          → Integrations (an account whose sign-in expired)
 *   {decision, ref}   → the decision deck, opened ON that item
 *   {inbox, session}  → that session's mailbox (a message it sent the owner)
 *   {session, host}   → that chat (the thread resolves id → path itself)
 */
export type NotificationTarget =
  | { to: "card"; id: number }
  | { to: "note"; id: number }
  | { to: "integrations" }
  | { to: "decision"; kind: string; ref: string; session: string }
  | { to: "inbox"; session: string }
  | { to: "thread"; session: string; host: string; title: string }

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "")
const posInt = (v: unknown) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** `title` is the push's own title: for a chat it is the chat's name, shown
 *  in the header until the thread's first read confirms it. */
export function notificationTarget(data: Record<string, unknown>, title = ""): NotificationTarget | null {
  const card = posInt(data.card)
  if (card) return { to: "card", id: card }
  const note = posInt(data.note)
  if (note) return { to: "note", id: note }
  if (data.screen === "Integrations") return { to: "integrations" }
  const session = str(data.session)
  const decision = str(data.decision)
  if (decision) return { to: "decision", kind: decision, ref: str(data.ref), session }
  if (data.inbox != null && session) return { to: "inbox", session }
  if (!session) return null
  // Push titles read "<chat> · <kind>" for asks; a turn's title is the chat name.
  const name = title.split(" · ")[0].trim()
  return { to: "thread", session, host: str(data.host) || "local", title: name }
}

type Decision = { kind: string; session: string; tool_use_id?: string; id?: string; card?: number }

/** The index of the tapped decision in the open queue: the exact item by its
 *  ref (tool_use_id, approval id, or card id — what the server delivered it
 *  under), else the first of the same kind from the same session (the item
 *  was re-asked under a new id), else -1. */
export function matchDecision(queue: Decision[], want: { kind: string; ref: string; session: string }): number {
  if (want.ref) {
    const exact = queue.findIndex((d) => d.kind === want.kind
      && (d.tool_use_id === want.ref || d.id === want.ref || (d.card != null && String(d.card) === want.ref)))
    if (exact >= 0) return exact
  }
  if (!want.session) return -1
  return queue.findIndex((d) => d.kind === want.kind && d.session === want.session)
}

/** Identity of a chat for the Thread route's `getId`. React Navigation's
 *  `navigate` reuses a mounted route with the same name and merges params, so a
 *  notification for chat B would re-point the open chat A's screen (keeping A's
 *  draft and polling). Keying on the chat makes B its own instance while a
 *  second tap on the SAME chat still reuses it. A transcript path
 *  (`projects/<dir>/<id>.jsonl`) and a bare session id name the same chat. */
export function threadInstanceId(p: { path?: string; session?: string; label?: string }): string {
  const fromPath = p.path ? (p.path.split("/").pop() || "").replace(/\.jsonl$/, "") : ""
  return fromPath || p.session || p.label || "thread"
}

/** A push about the chat already on screen is noise: the user sees the message
 *  arrive. Only a plain turn push (no card/decision/inbox payload) for the
 *  focused Thread is silenced; everything else still banners. */
export function suppressForeground(
  data: Record<string, unknown>,
  current: { name?: string; params?: { path?: string; session?: string; label?: string } } | undefined,
): boolean {
  if (current?.name !== "Thread" || !current.params) return false
  const t = notificationTarget(data)
  if (!t || t.to !== "thread") return false
  return threadInstanceId(current.params) === t.session
}
