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

/** A row's kind label. A missing or unknown kind reads as a plain message —
 *  the server's own default — so a newer server never crashes an older app. */
export function kindLabel(kind: string | null | undefined): string {
  return INBOX_KIND_LABEL[kind as InboxKind] ?? INBOX_KIND_LABEL.message
}

/** The kind filters the API accepts ("all" = no filter) — what
 *  inboxScopeFilter validates against. Decision kinds first. */
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

/** Case-insensitive search over title + body (the same contract as notes). */
export function searchInbox(messages: InboxMessage[], q: string): InboxMessage[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return messages
  return messages.filter((m) => (messageTitle(m) + "\n" + (m.body || "")).toLowerCase().includes(needle))
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

/** True when a row is still waiting on the owner's eye — the server's
 *  unread_count rule, per row: addressed to the owner, unread (a lapsed
 *  snooze counts) and, for a decision, still open. */
export function waitsOnOwner(m: InboxMessage): boolean {
  return m.recipient_type === "user" && (m.effective_status ?? m.status) === "sent" && m.open !== false
}

/** One chat's mailbox as the Inbox tab lists it — a conversation, like a
 *  WhatsApp/iMessage row: who, the last line, when, how many unread, and how
 *  many decisions are still open on it. */
export type Conversation = {
  session: string
  name: string
  last: InboxMessage
  at: number
  unread: number
  open: number
}

/** Group the ledger into conversations, one per session mailbox (every row
 *  has one: the mailbox-ownership rule). Order: conversations with an open,
 *  not-snoozed decision first — they wait on the owner, like a pinned chat —
 *  then most recent activity. `labels` maps session id → display name. */
export function groupConversations(messages: InboxMessage[], labels: Record<string, string> = {}): Conversation[] {
  const by = new Map<string, Conversation>()
  for (const m of messages) {
    const sid = m.session_id
    if (!sid) continue
    let c = by.get(sid)
    if (!c) {
      c = { session: sid, name: labels[sid] || sid.slice(0, 8), last: m, at: m.created_at, unread: 0, open: 0 }
      by.set(sid, c)
    }
    if (m.created_at > c.at || (m.created_at === c.at && m.id > c.last.id)) { c.last = m; c.at = m.created_at }
    if (waitsOnOwner(m)) c.unread++
    if (m.open && !m.snoozed) c.open++
  }
  return [...by.values()].sort((a, b) =>
    Number(b.open > 0) - Number(a.open > 0) || b.at - a.at || b.last.id - a.last.id)
}

/** The conversation row's second line: the last message's first line, with
 *  "You: " when the owner wrote it — the messaging-app convention. */
export function conversationPreview(c: Conversation): string {
  const line = messageTitle(c.last, 120) || kindLabel(c.last.kind)
  return c.last.sender_type === "user" ? `You: ${line}` : line
}

/** Search the conversation list: a chat matches by name or by any message in
 *  it (the same body search as searchInbox). */
export function searchConversations(convs: Conversation[], messages: InboxMessage[], q: string): Conversation[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return convs
  const hit = new Set(searchInbox(messages, q).map((m) => m.session_id))
  return convs.filter((c) => c.name.toLowerCase().includes(needle) || hit.has(c.session))
}

/** One row of a conversation's bubble thread. */
export type ThreadItem =
  | { type: "day"; key: string; label: string }
  | { type: "msg"; key: string; m: InboxMessage; mine: boolean }

/** A mailbox as a chat thread: oldest first, a day separator whenever the
 *  day changes, each message marked mine (the owner wrote it → right-hand
 *  bubble) or theirs. `dayOf` turns an epoch-seconds time into the day label
 *  ("Today", "Mon 5 Oct") — injected so this stays locale/clock free. */
export function threadTimeline(messages: InboxMessage[], dayOf: (ts: number) => string): ThreadItem[] {
  const out: ThreadItem[] = []
  let day = ""
  const sorted = [...messages].sort((a, b) => a.created_at - b.created_at || a.id - b.id)
  for (const m of sorted) {
    const d = dayOf(m.created_at)
    if (d !== day) { out.push({ type: "day", key: `day-${m.id}`, label: d }); day = d }
    out.push({ type: "msg", key: `m-${m.id}`, m, mine: m.sender_type === "user" })
  }
  return out
}
