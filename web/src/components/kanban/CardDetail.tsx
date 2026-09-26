import { useCallback, useEffect, useRef, useState } from "react"
import { Check, ExternalLink, Loader2, Trash2, X } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Markdown } from "@/components/Markdown"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { fmtAgo } from "@/lib/format"
import { decisionActions, formatActor, nextPosition, type ActorKind, type DecisionAction } from "@/lib/board"
import type { BoardColumn, Card, CardComment, CardDep, Employee } from "@/lib/types"

const UNASSIGNED = "__unassigned__"
const POLL_MS = 5000

/**
 * CardDetail — one card in the open. This is where the owner and the card's
 * agent session actually talk, so it is built like an issue page, not a form:
 *
 *  - The decision is the first thing on screen. A card in Review shows
 *    Approve / Decline / Needs info; other columns show the one move that is
 *    a human call from there (Start, Resume, Mark done, Reopen). The full
 *    status picker is in the sidebar for everything else.
 *  - Title and description save on blur — there is no Save/Cancel; what you
 *    see is what the board has, and a failed write says so where it failed.
 *  - The thread polls while open: the agent answers asynchronously, and the
 *    owner should see the reply land without reopening the card. The card's
 *    column and assignee refresh the same way, so an agent's move is visible.
 *  - Every author is shown as a person or an agent by name, never as the raw
 *    `user:` / `session:` principal string.
 *
 * Writes go straight to /api/org/*; the parent receives `onChange` so the
 * board behind the dialog stays in step, and `onDelete` so the Red-gated
 * delete keeps its one implementation.
 */
export function CardDetail({
  card: initial,
  employees,
  allCards,
  columns,
  selfUsername,
  sessionTitle,
  onOpenSession,
  onChange,
  onDelete,
  onClose,
}: {
  card: Card
  employees: Employee[]
  allCards: Card[]
  columns: BoardColumn[]
  selfUsername?: string
  /** Title of the session that owns the card, when it is on this host's list. */
  sessionTitle?: string
  onOpenSession?: () => void
  onChange: (card: Card) => void
  onDelete: (id: number) => void
  onClose: () => void
}) {
  const [card, setCard] = useState<Card>(initial)
  const [comments, setComments] = useState<CardComment[] | null>(null)
  const [deps, setDeps] = useState<CardDep[]>(initial.dependencies ?? [])
  const [busy, setBusy] = useState<string | null>(null) // which write is in flight
  const [error, setError] = useState("")
  const [confirmDelete, setConfirmDelete] = useState(false)

  const apply = useCallback(
    (updated: Card) => {
      setCard((c) => ({ ...c, ...updated }))
      onChange(updated)
    },
    [onChange]
  )

  // Live read: the thread, the dependency state and the card's own row. A
  // write in flight is not overwritten by a poll — the poll simply skips.
  const refresh = useCallback(async () => {
    const r = await api.orgCard(card.id)
    setComments(r.comments || [])
    setDeps(r.dependencies || [])
    if (r.card) setCard((c) => (busy ? c : { ...c, ...r.card }))
  }, [card.id, busy])

  useEffect(() => {
    let alive = true
    refresh().catch(() => alive && setError("Could not load this card's thread."))
    const t = setInterval(() => refresh().catch(() => {}), POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [refresh])

  async function write<T>(label: string, fn: () => Promise<T>, onOk: (r: T) => void, failMsg: string) {
    setBusy(label)
    setError("")
    try {
      onOk(await fn())
    } catch {
      setError(failMsg)
    } finally {
      setBusy(null)
    }
  }

  function move(columnId: number) {
    if (columnId === card.column_id) return
    const inCol = allCards.filter((c) => c.column_id === columnId && c.id !== card.id)
    const position = nextPosition(inCol, inCol.length)
    write("move", () => api.orgMoveCard({ card_id: card.id, column_id: columnId, position }), apply,
      "The move did not land. The card is still where it was.")
  }

  function saveTitle(title: string) {
    const next = title.trim()
    if (!next || next === card.title) return
    write("title", () => api.orgUpdateCard({ card_id: card.id, title: next }), apply, "The title was not saved.")
  }

  function saveBody(body: string) {
    if (body === card.body) return
    write("body", () => api.orgUpdateCard({ card_id: card.id, body }), apply, "The description was not saved.")
  }

  function assign(value: string) {
    const assignee = value === UNASSIGNED ? null : Number(value)
    if (assignee === card.assignee) return
    write("assignee", () => api.orgUpdateCard({ card_id: card.id, assignee: assignee as number }), apply,
      "The assignee was not changed.")
  }

  async function post(text: string) {
    await write("comment", () => api.orgAddCardComment({ card_id: card.id, body: text }),
      (c) => setComments((cs) => [...(cs || []), c]), "Your comment was not posted. It is still in the box.")
  }

  function addDep(id: number) {
    write("dep", async () => { await api.orgAddCardDep({ card_id: card.id, depends_on: id }); return (await api.orgCard(card.id)).dependencies || [] },
      setDeps, "The dependency was not added.")
  }
  function removeDep(id: number) {
    write("dep", async () => { await api.orgRemoveCardDep({ card_id: card.id, depends_on: id }); return (await api.orgCard(card.id)).dependencies || [] },
      setDeps, "The dependency was not removed.")
  }

  const column = columns.find((c) => c.id === card.column_id)
  const actions = decisionActions(columns, card.column_id)
  const creator = formatActor(card.created_by, selfUsername)
  const openDeps = deps.filter((d) => !d.done)
  const depChoices = allCards.filter((c) => c.project_id === card.project_id && c.id !== card.id && !deps.some((d) => d.id === c.id))

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        onOpenAutoFocus={(e) => e.preventDefault()} // focusing the title would select it as if to rename
      >
        <DialogHeader className="border-b border-border px-5 pt-4 pb-3 pr-12">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">#{card.id}</span>
            <StatusBadge name={column?.name} />
            <span>
              opened by <ActorName {...creator} /> {fmtAgo(card.created_at)}
              {card.updated_at > card.created_at + 60 && <> · updated {fmtAgo(card.updated_at)}</>}
            </span>
          </div>
          <DialogTitle asChild>
            <EditableTitle value={card.title} saving={busy === "title"} onSave={saveTitle} />
          </DialogTitle>
          <DialogDescription className="sr-only">Card details, decision actions and discussion thread.</DialogDescription>
        </DialogHeader>

        {actions.length > 0 && (
          <DecisionBar actions={actions} columnName={column?.name} sessionTitle={sessionTitle} busy={busy === "move"} onPick={move} />
        )}

        {error && (
          <div className="flex items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-5 py-2 text-xs text-destructive">
            <span>{error}</span>
            <button className="shrink-0 hover:underline" onClick={() => setError("")}>Dismiss</button>
          </div>
        )}

        <div className="grid min-h-0 flex-1 overflow-y-auto sm:grid-cols-[minmax(0,1fr)_15rem] sm:overflow-hidden">
          {/* ── Main: description + thread ── */}
          <div className="flex min-w-0 flex-col gap-5 px-5 py-4 sm:min-h-0 sm:overflow-y-auto">
            <section>
              <SectionLabel>Description</SectionLabel>
              <EditableBody value={card.body} saving={busy === "body"} onSave={saveBody} />
            </section>

            <section className="flex flex-col gap-3">
              <SectionLabel>
                Activity{comments && comments.length > 0 && <span className="ml-1 tabular-nums text-muted-foreground/70">{comments.length}</span>}
              </SectionLabel>
              {comments === null ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading the thread…</div>
              ) : comments.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No discussion yet.{sessionTitle ? ` A comment here reaches ${sessionTitle} directly.` : ""}
                </p>
              ) : (
                <ol className="flex flex-col gap-3">
                  {comments.map((c) => <CommentRow key={c.id} comment={c} selfUsername={selfUsername} />)}
                </ol>
              )}
              <Composer disabled={busy === "comment"} hint={sessionTitle ? `Posting wakes ${sessionTitle}. ⌘↵ to send.` : "⌘↵ to send."} onPost={post} />
            </section>
          </div>

          {/* ── Sidebar: the card's facts ── */}
          <aside className="flex flex-col gap-4 border-t border-border bg-card/40 px-4 py-4 text-xs sm:min-h-0 sm:overflow-y-auto sm:border-t-0 sm:border-l">
            <Field label="Status">
              <Select value={card.column_id != null ? String(card.column_id) : ""} onValueChange={(v) => move(Number(v))} disabled={busy === "move" || !columns.length}>
                <SelectTrigger size="sm" className="w-full"><SelectValue placeholder={columns.length ? "No column" : "Not on a board"} /></SelectTrigger>
                <SelectContent>
                  {columns.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Assignee">
              <Select value={card.assignee != null ? String(card.assignee) : UNASSIGNED} onValueChange={assign} disabled={busy === "assignee"}>
                <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                  {employees.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>{e.name}{e.role ? ` · ${e.role}` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Session">
              {card.session_id ? (
                onOpenSession ? (
                  <button className="flex items-center gap-1 text-left text-foreground hover:underline" onClick={onOpenSession}>
                    <span className="truncate">{sessionTitle}</span>
                    <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                  </button>
                ) : (
                  <span className="text-muted-foreground" title={card.session_id}>Not on this host</span>
                )
              ) : (
                <span className="text-muted-foreground">None — created on the board</span>
              )}
            </Field>

            <Field label={openDeps.length ? `Blocked by ${openDeps.length}` : "Blocked by"}>
              {deps.length === 0 && <span className="text-muted-foreground">Nothing — free to move</span>}
              {deps.map((d) => (
                <div key={d.id} className="flex items-center gap-1.5">
                  <span className={cn("size-1.5 shrink-0 rounded-full", d.done ? "bg-emerald-600" : "bg-red-600")} />
                  <span className={cn("min-w-0 flex-1 truncate", d.done && "text-muted-foreground line-through")} title={`#${d.id} · ${d.column_name || "no column"}`}>{d.title}</span>
                  <button className="text-muted-foreground hover:text-destructive" onClick={() => removeDep(d.id)} title="Remove dependency" disabled={busy === "dep"}>
                    <X className="size-3" />
                  </button>
                </div>
              ))}
              {depChoices.length > 0 && (
                <Select value="" onValueChange={(v) => addDep(Number(v))} disabled={busy === "dep"}>
                  <SelectTrigger size="sm" className="mt-1 w-full text-muted-foreground"><SelectValue placeholder="Add a blocker…" /></SelectTrigger>
                  <SelectContent>
                    {depChoices.map((c) => <SelectItem key={c.id} value={String(c.id)}>#{c.id} {c.title}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </Field>

            <div className="mt-auto border-t border-border pt-3">
              {confirmDelete ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground">Delete this card and its thread?</span>
                  <div className="flex gap-1.5">
                    <Button size="xs" variant="destructive" onClick={() => { onDelete(card.id); onClose() }}>Delete</Button>
                    <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button>
                  </div>
                </div>
              ) : (
                <button className="flex items-center gap-1 text-muted-foreground hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="size-3" /> Delete card
                </button>
              )}
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</h3>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}

const STATUS_TONE: Record<string, string> = {
  review: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  declined: "bg-red-500/15 text-red-700 dark:text-red-400",
  blocked: "bg-red-500/15 text-red-700 dark:text-red-400",
  "needs-info": "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  doing: "bg-primary/15 text-primary",
}

function StatusBadge({ name }: { name?: string }) {
  if (!name) return <Badge variant="outline" className="h-5">No column</Badge>
  return <Badge className={cn("h-5 border-transparent", STATUS_TONE[name.trim().toLowerCase()] || "bg-secondary text-secondary-foreground")}>{name}</Badge>
}

/**
 * The decision bar: the card's real next moves, worded as the owner's call.
 * A card in Review is waiting on exactly this; it sits above the fold so the
 * owner never has to find "Move to" in a dropdown to answer an agent.
 */
function DecisionBar({ actions, columnName, sessionTitle, busy, onPick }: {
  actions: DecisionAction[]; columnName?: string; sessionTitle?: string; busy: boolean; onPick: (columnId: number) => void
}) {
  const waiting = columnName?.trim().toLowerCase() === "review"
  const who = sessionTitle || "the card's session"
  return (
    <div className={cn("flex flex-wrap items-center gap-2 border-b border-border px-5 py-2.5", waiting && "bg-amber-500/5")}>
      <span className="mr-1 text-xs text-muted-foreground">
        {waiting ? `${who} is waiting for your decision.` : "Next:"}
      </span>
      {actions.map((a) => (
        <Button
          key={a.columnId}
          size="sm"
          disabled={busy}
          variant={a.tone === "approve" ? "default" : a.tone === "decline" ? "destructive" : "outline"}
          onClick={() => onPick(a.columnId)}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : a.tone === "approve" ? <Check className="size-3.5" /> : a.tone === "decline" ? <X className="size-3.5" /> : null}
          {a.label}
        </Button>
      ))}
    </div>
  )
}

function ActorName({ name, kind }: { name: string; kind: ActorKind }) {
  return (
    <span className="inline-flex items-center gap-1 font-medium text-foreground">
      {kind === "you" ? "you" : name}
      {kind === "agent" && <span className="rounded bg-primary/10 px-1 text-[10px] font-medium text-primary">agent</span>}
    </span>
  )
}

function CommentRow({ comment, selfUsername }: { comment: CardComment; selfUsername?: string }) {
  const who = formatActor(comment.author, selfUsername)
  const at = new Date(comment.created_at * 1000)
  return (
    <li className={cn("rounded-md border px-3 py-2", who.kind === "agent" ? "border-primary/20 bg-primary/5" : "border-border bg-background")}>
      <div className="mb-1 flex items-baseline gap-2 text-xs">
        <ActorName {...who} />
        <time dateTime={at.toISOString()} title={at.toLocaleString()} className="text-muted-foreground">{fmtAgo(comment.created_at)}</time>
      </div>
      <Markdown text={comment.body} />
    </li>
  )
}

/** Title as a heading you can type into. Wraps like a heading (a card title is
 *  often a whole sentence); Enter or blur saves, Escape reverts. */
function EditableTitle({ value, saving, onSave }: { value: string; saving: boolean; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <div className="relative">
      <textarea
        value={draft}
        rows={1}
        onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
        onBlur={() => (draft.trim() ? onSave(draft) : setDraft(value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur() }
          if (e.key === "Escape") { setDraft(value); e.currentTarget.blur() }
        }}
        aria-label="Title"
        className="field-sizing-content w-full resize-none bg-transparent pr-5 text-base font-semibold leading-snug outline-none placeholder:text-muted-foreground focus:underline focus:decoration-border focus:underline-offset-4"
        placeholder="Untitled"
      />
      {saving && <Loader2 className="absolute top-1 right-0 size-3.5 animate-spin text-muted-foreground" />}
    </div>
  )
}

/** Description: rendered Markdown at rest, a textarea while editing. Blur saves. */
function EditableBody({ value, saving, onSave }: { value: string; saving: boolean; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (!editing) setDraft(value) }, [value, editing])
  useEffect(() => { if (editing) ref.current?.focus() }, [editing])

  if (editing) {
    return (
      <Textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); onSave(draft.trim()) }}
        onKeyDown={(e) => { if (e.key === "Escape") { setDraft(value); setEditing(false) } }}
        placeholder="What is this card about? Markdown works."
        className="min-h-28 resize-y text-sm"
      />
    )
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={cn("group relative w-full rounded-md text-left transition hover:bg-muted/40", !value && "text-muted-foreground")}
      title="Click to edit"
    >
      {value ? <Markdown text={value} /> : <span className="text-sm">No description. Click to add one.</span>}
      {saving && <Loader2 className="absolute top-0 right-0 size-3.5 animate-spin text-muted-foreground" />}
    </button>
  )
}

function Composer({ disabled, hint, onPost }: { disabled: boolean; hint: string; onPost: (text: string) => Promise<void> }) {
  const [draft, setDraft] = useState("")
  async function send() {
    const text = draft.trim()
    if (!text || disabled) return
    await onPost(text)
    setDraft("") // only cleared after the write returned; a failure leaves it in the box
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }}
        placeholder="Write a comment…"
        className="min-h-20 resize-y text-sm"
        disabled={disabled}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{hint}</span>
        <Button size="sm" disabled={disabled || !draft.trim()} onClick={send}>
          {disabled ? <Loader2 className="size-3.5 animate-spin" /> : null} Comment
        </Button>
      </div>
    </div>
  )
}
