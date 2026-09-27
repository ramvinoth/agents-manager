/**
 * inbox.ts — pure logic for the mobile Inbox screen (mirrors the server's
 * viewer/inbox + routes/inbox contract and the web's lib/inbox.ts). The inbox
 * is a DELIVERY SURFACE over the existing decision system, not a second one:
 * a row can carry a decision (question | plan | approval | card) whose open
 * state the server DERIVES at read time; the deciding tap stays in the chat.
 * No server/React imports — unit-tested under node like notes.ts.
 */
import type { InboxFilter, InboxKind, InboxMessage } from "../api/client"
export type { InboxFilter, InboxKind, InboxMessage }

export const INBOX_KIND_LABEL: Record<InboxKind, string> = {
  message: "Message", question: "Question", plan: "Plan", approval: "Approval", card: "Card",
}

/** The kind chips a list view offers, in display order. "all" means no kind
 *  filter; the decision kinds come first — the inbox exists to get decisions
 *  to a human, free messages are the secondary channel. */
export const INBOX_FILTERS: ("all" | InboxKind)[] =
  ["all", "question", "plan", "approval", "card", "message"]

/** Snooze choices, in hours, matching the server's clamp (0–168). */
export const SNOOZE_OPTIONS: { label: string; hours: number }[] = [
  { label: "30 minutes", hours: 0.5 },
  { label: "1 hour", hours: 1 },
  { label: "Until tomorrow", hours: 24 },
]

/** The one chip a row wears. Priority: a live snooze (the owner said "later"
 *  — never show it as urgent while it holds) > an open decision ("needs you"
 *  — seen or not, the call is still theirs) > a resolved-but-unread decision
 *  ("answered") > read (no chip). A lapsed snooze re-reads as 'sent' on the
 *  server, so it falls through to "needs you" — skipped is never dropped. */
export function inboxStateBadge(m: InboxMessage): string | null {
  const eff = m.effective_status ?? m.status
  if (eff === "snoozed") return "snoozed"
  if (m.open) return "needs you"
  if (eff === "read") return null
  return "answered"
}

/** The row's title: the first non-empty body line, markers stripped, clipped.
 *  Delivery bodies are written first-line-forward (the ask before the
 *  context), so the first line IS the ask — what the owner should see. */
export function messageTitle(m: InboxMessage, max = 90): string {
  const line = (m.body || "").split("\n").map((l) => l.trim()).find(Boolean) || ""
  const clean = line.replace(/^[#>\-*\s]+/, "")
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean
}

/** One-line preview under the title: the first body line that is not the
 *  title itself, clipped. */
export function messagePreview(m: InboxMessage, max = 90): string {
  const title = messageTitle(m, 200)
  const line = (m.body || "").split("\n").map((l) => l.trim())
    .find((l) => l && l !== title) || ""
  return line.length > max ? line.slice(0, max - 1) + "…" : line
}

/** Who a row is about, as a short label. For a decision row the session is
 *  the actor asking; for a free message it is the sender (the owner's own
 *  rows say "You"). `labels` maps session id → display name, resolved by the
 *  caller from the sessions list (the row carries only the raw id). */
export function rowActor(m: InboxMessage, labels: Record<string, string> = {}): string {
  if (m.sender_type === "session") return labels[m.sender_id] || (m.sender_id || "").slice(0, 8)
  return "You"
}

/** Case-insensitive search over title + body (the same contract as notes). */
export function searchInbox(messages: InboxMessage[], q: string): InboxMessage[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return messages
  return messages.filter((m) => (messageTitle(m) + "\n" + (m.body || "")).toLowerCase().includes(needle))
}

/** Newest first — the ledger's order, re-applied after local edits so the
 *  list never jumps out of order. The "needs you" items are NOT re-ordered
 *  into the list: they keep waiting-time order in the action-queue band. */
export function orderInbox(messages: InboxMessage[]): InboxMessage[] {
  return [...messages].sort((a, b) => b.created_at - a.created_at || b.id - a.id)
}

/** The other side of a row, as an inbox_send `to` value — a reply is
 *  addressed to the session whose mailbox the row lives in (the row's
 *  session_id: recipient-preferred, sender otherwise — the single
 *  mailbox-ownership rule). null when no session is a party (the owner is
 *  reading it, so there is nowhere to send). */
export function replyTo(m: InboxMessage): string | null {
  if (m.session_id) return `session:${m.session_id}`
  return null
}

/** The scope of an inbox VIEW: one chat's mailbox, a project's, or (the
 *  Inbox tab) everything. Unlike notes, an UNSCOPED view is legitimate — the
 *  inbox is a channel, not a project artifact. A malformed scope is refused,
 *  never silently widened. */
export function inboxScopeFilter(input: InboxFilter = {}): InboxFilter | null {
  const { session, project, kind, unread_only, archived } = input
  if (session !== undefined && (typeof session !== "string" || !session.trim())) return null
  if (project !== undefined && (!Number.isSafeInteger(project) || project <= 0)) return null
  if (kind !== undefined && !((INBOX_FILTERS as string[]).includes(kind))) return null
  return { session, project, kind, unread_only: !!unread_only, archived: !!archived }
}
