import { INBOX_FILTERS, INBOX_KIND_LABEL, inboxScopeFilter, inboxStateBadge, messagePreview, messageTitle, orderInbox, replyTo, rowActor, searchInbox, type InboxMessage } from "./inbox.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const M = (o: Partial<InboxMessage> & { id: number }): InboxMessage => ({
  session_id: "", project_id: null, sender_type: "user", sender_id: "",
  recipient_type: "session", recipient_id: "s1", body: "", kind: "message",
  ref_id: "", in_reply_to: 0, status: "sent", snoozed_until: null, archived: false,
  created_at: 0, updated_at: 0, ...o,
})

// labels: the chip contract
eq("kind labels", INBOX_FILTERS, ["all", "question", "plan", "approval", "card", "message"])
eq("label set", INBOX_KIND_LABEL.question, "Question")

// title/preview: first line is the ask; preview is the second
const q = M({ id: 1, kind: "question", body: "Question from Build — pick a model:\nOptions: a — cheap\nb — smart" })
eq("title is first line", messageTitle(q), "Question from Build — pick a model:")
eq("preview is second line", messagePreview(q), "Options: a — cheap")
const long = M({ id: 2, body: "x".repeat(200) })
eq("title clipped", messageTitle(long).length, 90)
eq("clip has ellipsis", messageTitle(long).endsWith("…"), true)
const empty = M({ id: 3, body: "" })
eq("empty body title", messageTitle(empty), "")

// the state badge: needs-you > snoozed > answered, read shows nothing
eq("open decision", inboxStateBadge(M({ id: 4, kind: "card", open: true })), "needs you")
eq("lapsed snooze resurfaces", inboxStateBadge(M({ id: 5, kind: "card", open: true, status: "snoozed", effective_status: "sent", snoozed: true })), "needs you")
eq("snoozed while open", inboxStateBadge(M({ id: 6, kind: "question", open: true, status: "snoozed", effective_status: "snoozed", snoozed: true })), "snoozed")
eq("resolved but unread", inboxStateBadge(M({ id: 7, kind: "plan", open: false, status: "sent" })), "answered")
eq("read shows nothing", inboxStateBadge(M({ id: 8, kind: "plan", open: false, status: "read" })), null)
eq("open and read (saw it, still open)", inboxStateBadge(M({ id: 9, kind: "card", open: true, status: "read" })), "needs you")

// order: newest first; on the same timestamp the higher id (created later —
// autoincrement) comes first
eq("order newest first", orderInbox([M({ id: 1, created_at: 5 }), M({ id: 2, created_at: 9 }), M({ id: 3, created_at: 9 })]).map((m) => m.id), [3, 2, 1])

// search
eq("search hits body", searchInbox([M({ id: 1, body: "hello world" }), M({ id: 2, body: "bye" })], "WORLD").map((m) => m.id), [1])
eq("empty query passes all", searchInbox([M({ id: 1 })], "   ").length, 1)

// actor: a session's row is named by its label; the owner's rows say You
eq("agent row labelled", rowActor(M({ id: 1, sender_type: "session", sender_id: "abc" }), { abc: "Build" }), "Build")
eq("agent row unlabelled falls back to short id", rowActor(M({ id: 1, sender_type: "session", sender_id: "abcdef12" })), "abcdef12")
eq("own row says You", rowActor(M({ id: 1, sender_type: "user" })), "You")

// replyTo: the mailbox's session (recipient-preferred, sender otherwise)
eq("agent asked the owner — reply to the agent", replyTo(M({ id: 1, session_id: "abc", sender_type: "session", sender_id: "abc", recipient_type: "user", recipient_id: "" })), "session:abc")
eq("owner wrote to an agent — reply to the agent", replyTo(M({ id: 2, session_id: "abc", sender_type: "user", recipient_type: "session", recipient_id: "abc" })), "session:abc")
eq("peer row — reply to the recipient's mailbox", replyTo(M({ id: 3, session_id: "b", sender_type: "session", sender_id: "a", recipient_type: "session", recipient_id: "b" })), "session:b")
eq("no session party — nothing to reply to", replyTo(M({ id: 4, session_id: "", sender_type: "user", recipient_type: "user" })), null)

// scope validation: unscoped is legitimate (the tab); malformed is refused
eq("unscoped ok", inboxScopeFilter() && inboxScopeFilter()!.session === undefined, true)
eq("session scoped ok", inboxScopeFilter({ session: "abc" })?.session, "abc")
eq("empty session refused", inboxScopeFilter({ session: "  " }), null)
eq("bad project refused", inboxScopeFilter({ project: -3 }), null)
eq("bad kind refused", inboxScopeFilter({ kind: "bogus" as never }), null)
eq("kind kept", inboxScopeFilter({ kind: "question" })?.kind, "question")

console.log(`\ninbox: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
