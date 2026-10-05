import { INBOX_FILTERS, INBOX_KIND_LABEL, conversationPreview, kindLabel, groupConversations, inboxScopeFilter, inboxStateBadge, messageTitle, searchConversations, searchInbox, threadTimeline, waitsOnOwner, type InboxMessage } from "./inbox.ts"

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
eq("kind label known", kindLabel("plan"), "Plan")
eq("kind label missing reads as message", kindLabel(undefined), "Message")
eq("kind label unknown reads as message", kindLabel("future-kind"), "Message")

// title: the first line is the ask
const q = M({ id: 1, kind: "question", body: "Question from Build — pick a model:\nOptions: a — cheap\nb — smart" })
eq("title is first line", messageTitle(q), "Question from Build — pick a model:")
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

// search
eq("search hits body", searchInbox([M({ id: 1, body: "hello world" }), M({ id: 2, body: "bye" })], "WORLD").map((m) => m.id), [1])
eq("empty query passes all", searchInbox([M({ id: 1 })], "   ").length, 1)

// scope validation: unscoped is legitimate (the tab); malformed is refused
eq("unscoped ok", inboxScopeFilter() && inboxScopeFilter()!.session === undefined, true)
eq("session scoped ok", inboxScopeFilter({ session: "abc" })?.session, "abc")
eq("empty session refused", inboxScopeFilter({ session: "  " }), null)
eq("bad project refused", inboxScopeFilter({ project: -3 }), null)
eq("bad kind refused", inboxScopeFilter({ kind: "bogus" as never }), null)
eq("kind kept", inboxScopeFilter({ kind: "question" })?.kind, "question")

// waitsOnOwner: the server's unread rule, per row
eq("agent message to owner, unread", waitsOnOwner(M({ id: 1, recipient_type: "user" })), true)
eq("read message", waitsOnOwner(M({ id: 2, recipient_type: "user", status: "read" })), false)
eq("lapsed snooze counts", waitsOnOwner(M({ id: 3, recipient_type: "user", status: "snoozed", effective_status: "sent", kind: "card", open: true })), true)
eq("answered decision does not", waitsOnOwner(M({ id: 4, recipient_type: "user", kind: "question", open: false })), false)
eq("owner's own message does not", waitsOnOwner(M({ id: 5, recipient_type: "session" })), false)

// conversations: one per mailbox; open decisions first, then recency
const rows = [
  M({ id: 1, session_id: "a", sender_type: "session", sender_id: "a", recipient_type: "user", body: "hi from a", created_at: 10 }),
  M({ id: 2, session_id: "a", sender_type: "user", recipient_type: "session", body: "thanks", created_at: 20, status: "read" }),
  M({ id: 3, session_id: "b", sender_type: "session", sender_id: "b", recipient_type: "user", kind: "question", open: true, body: "Pick one?", created_at: 5 }),
  M({ id: 4, session_id: "c", sender_type: "session", sender_id: "c", recipient_type: "user", kind: "card", open: true, snoozed: true, status: "snoozed", effective_status: "snoozed", body: "later", created_at: 30 }),
  M({ id: 5, session_id: "", body: "orphan", created_at: 40 }),
]
const convs = groupConversations(rows, { a: "Alpha" })
eq("one per mailbox, orphan skipped", convs.map((c) => c.session), ["b", "c", "a"])
eq("label applied", convs[2].name, "Alpha")
eq("fallback name is short id", convs[0].name, "b")
eq("last is newest", convs[2].last.id, 2)
eq("unread counts waiting rows", convs[2].unread, 1)
eq("open decision counted", convs[0].open, 1)
eq("snoozed decision not counted open", convs[1].open, 0)
eq("own last line says You", conversationPreview(convs[2]), "You: thanks")
eq("their last line plain", conversationPreview(convs[0]), "Pick one?")
eq("same-time tie: higher id is last", groupConversations([M({ id: 7, session_id: "z", created_at: 1 }), M({ id: 8, session_id: "z", created_at: 1 })])[0].last.id, 8)

// search conversations: by name or by message body
eq("search by name", searchConversations(convs, rows, "alp").map((c) => c.session), ["a"])
eq("search by body", searchConversations(convs, rows, "pick").map((c) => c.session), ["b"])
eq("blank search keeps all", searchConversations(convs, rows, " ").length, 3)

// thread timeline: oldest first, day separators on change, mine = owner wrote it
const tl = threadTimeline(rows.slice(0, 2).concat(M({ id: 9, session_id: "a", sender_type: "session", created_at: 100 })), (ts) => (ts < 50 ? "D1" : "D2"))
eq("timeline shape", tl.map((x) => (x.type === "day" ? x.label : `${x.m.id}${x.mine ? "R" : "L"}`)), ["D1", "1L", "2R", "D2", "9L"])

console.log(`\ninbox: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
