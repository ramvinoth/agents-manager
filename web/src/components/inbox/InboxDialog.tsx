import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { BellOff, Check, FolderOpen, Loader2, Send, Zap } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { fmtAgo, projectName } from "@/lib/format"
import {
  INBOX_FILTERS, INBOX_KIND_LABEL, inboxStateBadge, messagePreview, messageTitle,
  orderInbox, replyTo, searchInbox, SNOOZE_OPTIONS, type InboxMessage,
} from "@/lib/inbox"
import { useStore } from "@/store"
import type { OrgProject } from "@/lib/types"

const POLL_MS = 10000

/**
 * InboxDialog — the message ledger (viewer/inbox) as a two-pane modal: the
 * list on the left (kind chips, unread toggle), one row in full on the right
 * with the actions that row allows. Opened two ways, exactly like the board:
 * a project row opens the project's inbox (every session in it, both
 * directions), a session's header opens that session's mailbox.
 *
 * The decision contract: a row may carry a decision (question | plan |
 * approval | card) whose open state the server derives at read time. The
 * deciding tap stays on the per-session routes — here the owner gets
 * "Open chat" (the decision surface) for decisions and a plain reply for
 * messages; snooze skips a decision without dropping it (it resurfaces when
 * the snooze lapses). The "needs you" band lists the open, unsnoozed ones
 * with the total, oldest first.
 */
export function InboxDialog({
  host, cwd, name, session, sessionTitle, onClose,
}: {
  host: string
  cwd: string
  name: string
  /** Set → this is a session-scoped mailbox (opened from a session), not a project's. */
  session?: string
  sessionTitle?: string
  onClose: () => void
}) {
  const [project, setProject] = useState<OrgProject | null>(null)
  const [messages, setMessages] = useState<InboxMessage[]>([])
  const [queue, setQueue] = useState<{ count: number; items: InboxMessage[] } | null>(null)
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState("")
  const [kind, setKind] = useState<"all" | InboxMessage["kind"]>("all")
  const [q, setQ] = useState("")
  const [openId, setOpenId] = useState<number | null>(null)
  const reads = useRef({ issued: 0, applied: 0 })

  const sessions = useStore((s) => s.sessions)
  const loadSession = useStore((s) => s.loadSession)
  // Row labels: the session's own title, resolved from the live session list
  // (the row carries only the raw id — names live where the sessions live).
  const labels = useMemo(() => {
    const out: Record<string, string> = {}
    for (const s of sessions) {
      const id = (s as { id?: string }).id
      if (id) out[id] = s.title || id.slice(0, 8)
    }
    return out
  }, [sessions])

  const load = useCallback(async () => {
    if (session === undefined && !project) return
    const request = ++reads.current.issued
    try {
      const kindFilter = kind === "all" ? undefined : kind
      const f = session
        ? { session, kind: kindFilter }
        : { project: project?.id, kind: kindFilter }
      const r = await api.inboxList(f)
      if (request < reads.current.applied) return
      reads.current.applied = request
      setMessages(r.messages || [])
      setQueue(r.queue || null)
      setUnread(r.unread ?? 0)
      setErr("")
    } catch (ex: any) {
      if (request < reads.current.applied) return
      reads.current.applied = request
      setErr(String(ex?.message || ex))
    } finally {
      if (request === reads.current.applied) setLoading(false)
    }
  }, [session, project, kind])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        if (session) setProject(null)
        else {
          const proj = await api.orgProjectForCwd({ host, cwd, name })
          if (!alive) return
          setProject(proj)
        }
        setErr("")
      } catch (ex: any) {
        if (alive) setErr(String(ex?.message || ex))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [host, cwd, name, session])

  // First paint: once the scope exists (a session, or a resolved project),
  // load; the interval below only keeps it fresh afterwards.
  useEffect(() => {
    if (session || project) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, project?.id])

  // Poll while open (a live channel: a peer's message appears without a
  // manual refresh), and stop when the tab is hidden.
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) load()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const shown = useMemo(() => orderInbox(searchInbox(messages, q)), [messages, q])
  const open = openId != null ? messages.find((m) => m.id === openId) || null : null

  function patchLocal(m: InboxMessage) {
    setMessages((all) => all.map((x) => (x.id === m.id ? m : x)))
  }

  /** The decision surface: open the owning chat. Enabled only when the
   *  session is in the live list on this host (a remote session's chat can't
   *  be opened from here — its row still shows the full context). */
  function openChat(m: InboxMessage) {
    // The decision's session: the mailbox owner (the row's session_id) is the
    // asker for every decision kind; fall back to the party fields if absent.
    const sid = m.session_id || (m.sender_type === "session" ? m.sender_id : m.recipient_id)
    const s = sessions.find((x) => (x as { id?: string }).id === sid)
    if (!s) return
    onClose()
    loadSession(s.path)
  }

  function markRead(m: InboxMessage) {
    // `open` is server-derived (the decision may still be open — read only
    // clears "needs a look"), so it is not touched locally.
    api.inboxRead(m.id).then(() => patchLocal({ ...m, status: "read" }))
  }

  function snooze(m: InboxMessage, hours: number) {
    api.inboxSnooze(m.id, hours)
      .then((r) => patchLocal({ ...m, status: "snoozed", snoozed_until: r.snoozed_until ?? null }))
  }

  // A decision row the owner chose to skip: it leaves the list's urgency but
  // the snooze's lapse brings it back (the server re-reads it as 'sent').

  const queueItems = useMemo(() => (queue?.items || []).filter((i) => i.session_id), [queue])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[92vh] max-w-[95vw] flex-col sm:max-w-[95vw]">
        <DialogHeader>
          <DialogTitle>
            Inbox · {session ? sessionTitle || "session" : project?.name || name}
            {unread > 0 ? <span className="ml-2 text-sm font-normal text-muted-foreground">{unread} unread</span> : null}
          </DialogTitle>
          <DialogDescription>
            {session
              ? "This chat's mailbox — messages to it and from it, plus the decisions it left for you."
              : "This project's inbox — every message between you and its sessions, and the decisions waiting on you."}
          </DialogDescription>
        </DialogHeader>

        {err && <div className="text-sm text-destructive">{err}</div>}

        {/* The action queue: what actually needs the owner, one glance, with
            the total. Open + unsnoozed, oldest first — waiting time is the
            only order before a human ranks anything. */}
        {queue && queue.count > 0 && !loading && (
          <div className="rounded-md border border-border bg-muted/40 p-2">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Zap className="size-3.5" /> Needs you · {queue.count}
            </div>
            <div className="flex flex-col gap-0.5">
              {queueItems.map((m) => (
                <button
                  key={m.id}
                  onClick={() => { setKind("all"); setQ(""); setOpenId(m.id) }}
                  className="flex items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-accent"
                >
                  <span className="w-16 shrink-0 text-xs uppercase text-muted-foreground">{INBOX_KIND_LABEL[m.kind]}</span>
                  <span className="flex-1 truncate">{messageTitle(m, 110)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{fmtAgo(m.created_at)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex flex-1 items-center justify-center"><Loader2 className="size-5 animate-spin" /></div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-4">
            <aside className="flex min-h-0 w-80 shrink-0 flex-col gap-2 border-r border-border pr-3">
              {/* kind chips: decisions first, then free messages */}
              <div className="flex flex-wrap gap-1">
                {INBOX_FILTERS.map((k) => (
                  <button
                    key={k}
                    onClick={() => { setKind(k); setOpenId(null) }}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs",
                      kind === k ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground",
                    )}
                  >
                    {k === "all" ? "All" : INBOX_KIND_LABEL[k]}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-8" />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {shown.length === 0 && (
                  <div className="p-3 text-sm text-muted-foreground">
                    {q ? "No matches." : "Nothing here yet."}
                  </div>
                )}
                {shown.map((m) => {
                  const badge = inboxStateBadge(m)
                  const eff = m.effective_status ?? m.status
                  return (
                    <button
                      key={m.id}
                      onClick={() => { setOpenId(m.id); if (eff === "sent") markRead(m) }}
                      className={cn("flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left hover:bg-accent", openId === m.id && "bg-accent")}
                    >
                      <div className="flex items-center gap-1.5">
                        {m.open && eff !== "snoozed" && (
                          <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" aria-label="waiting on you" />
                        )}
                        <span className="flex-1 truncate text-sm font-medium">{messageTitle(m) || INBOX_KIND_LABEL[m.kind]}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{fmtAgo(m.created_at)}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span>{m.sender_type === "user" ? "You" : labels[m.sender_id] || m.sender_id.slice(0, 8)}</span>
                        <span className="rounded bg-muted px-1 py-px text-[10px] font-medium">{INBOX_KIND_LABEL[m.kind]}</span>
                        {badge && (
                          <span className={cn("rounded px-1 py-px text-[10px] font-medium",
                            badge === "needs you" ? "bg-primary/15 text-primary" : "text-muted-foreground")}>
                            {badge}
                          </span>
                        )}
                      </div>
                      {messagePreview(m) && (
                        <div className="truncate text-xs text-muted-foreground">{messagePreview(m)}</div>
                      )}
                    </button>
                  )
                })}
              </div>
              <Composer
                scope={session || (project ? { project: project.id } : null)}
                name={session ? sessionTitle || "session" : project?.name || name}
                onSent={(m) => setMessages((all) => [m, ...all])}
              />
            </aside>

            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              {open ? (
                <RowDetail
                  key={open.id}
                  msg={open}
                  label={labels[open.sender_id] || ""}
                  onOpenChat={() => openChat(open)}
                  onRead={() => markRead(open)}
                  onSnooze={(h) => snooze(open, h)}
                  canReply={replyTo(open) !== null}
                />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
                  <span>Pick a message.</span>
                  <span className="text-xs">Decisions can be snoozed or opened in their chat; messages can be replied to.</span>
                </div>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** One message in full. The body is plain text written first-line-forward
 *  (the ask, then the context) — rendered as pre-wrap text, not markdown:
 *  the delivery formatters own the shape. Actions are the row's own:
 *  decisions open their chat (the deciding surface) and can be snoozed;
 *  messages can be replied to, in place. */
function RowDetail({
  msg, label, onOpenChat, onRead, onSnooze, canReply,
}: {
  msg: InboxMessage
  label: string
  onOpenChat: () => void
  onRead: () => void
  onSnooze: (hours: number) => void
  canReply: boolean
}) {
  const [reply, setReply] = useState("")
  const [sending, setSending] = useState(false)
  const [snoozeMenu, setSnoozeMenu] = useState(false)
  const isDecision = msg.kind !== "message"
  const eff = msg.effective_status ?? msg.status
  const effLabel = eff === "snoozed"
    ? `snoozed until ${new Date((msg.snoozed_until ?? 0) * 1000).toLocaleString()}`
    : eff

  async function sendReply() {
    const to = replyTo(msg)
    if (!to || !reply.trim()) return
    setSending(true)
    try {
      await api.inboxSend({ to, body: reply.trim(), in_reply_to: msg.id })
      setReply("")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="uppercase">{INBOX_KIND_LABEL[msg.kind]}</Badge>
        <span className="text-sm font-medium">{msg.sender_type === "user" ? "You" : label || msg.sender_id.slice(0, 8)}</span>
        <span className="text-xs text-muted-foreground">{fmtAgo(msg.created_at)}</span>
        <span className="ml-auto text-xs text-muted-foreground">{isDecision ? (msg.open ? "decision still open" : "decision resolved") : `status: ${effLabel}`}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border p-3">
        <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{msg.body}</pre>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {isDecision && (
          <Button size="sm" variant="default" onClick={onOpenChat}>
            <FolderOpen className="size-3.5" /> Open chat
          </Button>
        )}
        {isDecision && (
          <div className="relative">
            <Button size="sm" variant="outline" onClick={() => setSnoozeMenu((v) => !v)}>
              <BellOff className="size-3.5" /> Snooze
            </Button>
            {snoozeMenu && (
              <div className="absolute bottom-full z-10 mb-1 w-44 rounded-md border border-border bg-popover p-1 shadow-md">
                {SNOOZE_OPTIONS.map((o) => (
                  <button
                    key={o.label}
                    onClick={() => { setSnoozeMenu(false); onSnooze(o.hours) }}
                    className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    {o.label}
                  </button>
                ))}
                <div className="border-t border-border px-2 pb-1 pt-1 text-[11px] text-muted-foreground">
                  Skipped, not dropped — it resurfaces when the snooze lapses.
                </div>
              </div>
            )}
          </div>
        )}
        {eff === "sent" && (
          <Button size="sm" variant="ghost" onClick={onRead}>
            <Check className="size-3.5" /> Mark read
          </Button>
        )}
        {canReply && (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={isDecision ? "Reply in words (a follow-up)…" : "Reply…"}
              rows={1}
              className="min-h-[34px] flex-1"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendReply() } }}
            />
            <Button size="sm" onClick={sendReply} disabled={sending || !reply.trim()}>
              <Send className="size-3.5" />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** The composer at the bottom of the list. Session-scoped: one field, it
 *  goes to that session. Project-scoped: a field + a destination picker over
 *  the project's sessions (their ids come from the live session list). */
function Composer({
  scope, name, onSent,
}: {
  scope: string | { project?: number } | null
  name: string
  onSent: (m: InboxMessage) => void
}) {
  const sessions = useStore((s) => s.sessions)
  const [to, setTo] = useState<string>("")
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)

  const targets = useMemo(() => {
    const withId = (s: { path: string } & { title?: string; id?: string }) => {
      const id = s.id
      return id ? { id, title: s.title || id.slice(0, 8) } : null
    }
    if (typeof scope === "string") return []  // session-scoped: the field targets it directly
    if (!scope) return sessions.map(withId).filter(Boolean) as { id: string; title: string }[]
    // Same grouping key the SessionList uses: the project's display name.
    return sessions
      .filter((s) => {
        const id = (s as { id?: string }).id
        return !!id && projectName(s.project || s.path.split("/").slice(0, -1).join("/")) === name
      })
      .map(withId)
      .filter(Boolean) as { id: string; title: string }[]
  }, [sessions, scope, name])

  async function send() {
    const dest = typeof scope === "string" ? scope : to
    if (!dest || !text.trim()) return
    setBusy(true)
    try {
      const m = await api.inboxSend({ to: `session:${dest}`, body: text.trim() })
      setText("")
      onSent(m)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      {typeof scope !== "string" && (
        <select
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="h-8 max-w-[130px] rounded-md border border-border bg-background px-1 text-xs"
        >
          <option value="">To…</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>{t.title}</option>
          ))}
        </select>
      )}
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") send() }}
        placeholder={typeof scope === "string" ? `Message ${name}` : "Message a session…"}
        className="h-8 text-sm"
      />
      <Button size="icon" variant="ghost" className="shrink-0" onClick={send} disabled={busy || !text.trim()}>
        <Send className="size-4" />
      </Button>
    </div>
  )
}
