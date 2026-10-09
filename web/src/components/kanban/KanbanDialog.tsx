import { useEffect, useMemo, useState } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
  useDroppable,
} from "@dnd-kit/core"
import { useDraggable } from "@dnd-kit/core"
import { Plus, Trash2, Pencil, Loader2, GripVertical, Check, X, MessageSquare, History, Search } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { groupByColumn, orderColumn, nextPosition, findCardSession, matchesQuery } from "@/lib/board"
import { useStore } from "@/store"
import { CardDetail } from "./CardDetail"
import { DecisionsBand } from "./DecisionsBand"
import { AuditDialog } from "../AuditDialog"
import { isQueued } from "@/lib/types"
import type { BoardColumn, Card, OpenDecision, OrgProject } from "@/lib/types"

/**
 * KanbanDialog — the project's task board in a big modal. Resolves which org
 * project a session-directory (host + cwd) maps to (find-or-create), then loads
 * that project's columns + cards. Full CRUD: drag cards between/within columns
 * (dnd-kit + fractional positions), add/edit/delete cards, and add/rename/delete
 * columns. Every write goes to
 * /api/org/* — the same board an agent chat session sees through its kanban MCP.
 */
export function KanbanDialog({
  host,
  cwd,
  name,
  onClose,
}: {
  host: string
  cwd: string
  name: string
  onClose: () => void
}) {
  const [project, setProject] = useState<OrgProject | null>(null)
  const [columns, setColumns] = useState<BoardColumn[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState("")
  const [activeId, setActiveId] = useState<number | null>(null)
  const [editing, setEditing] = useState<Card | null>(null) // card editor (null = closed)
  // The columns of the editing card's board when it is NOT this board (a card
  // opened from the org-wide decision queue); null = this board's columns.
  const [editingColumns, setEditingColumns] = useState<BoardColumn[] | null>(null)
  const [addingCol, setAddingCol] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [newColName, setNewColName] = useState("")
  const [query, setQuery] = useState("") // find box: "#107" or words
  // Confirmation gate for the two deletions that touch more than one row:
  // deleting a card removes its comment thread, and deleting a column with
  // cards re-parents them. The dialog holds the target, not a boolean, so the
  // confirm is the single place the consequences are worded.
  const [confirm, setConfirm] = useState<
    | null
    | { kind: "card"; card: Card }
    | { kind: "column"; column: BoardColumn; count: number }
  >(null)
  const authUser = useStore((s) => s.authUser)
  const sessions = useStore((s) => s.sessions)
  const loadSession = useStore((s) => s.loadSession)
  const editingSession = useMemo(() => findCardSession(sessions, editing?.session_id), [sessions, editing?.session_id])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const proj = await api.orgProjectForCwd({ host, cwd, name })
        if (!alive) return
        setProject(proj)
        const [b, c] = await Promise.all([
          api.orgBoard(proj.id),
          api.orgCards({ project: proj.id }),
        ])
        if (!alive) return
        setColumns(b.columns || [])
        setCards(c.cards || [])
      } catch (ex: any) {
        if (alive) setErr(String(ex?.message || ex))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [host, cwd, name])

  // The find box narrows what is SHOWN; moves and positions still use the full
  // card list, so dropping into a filtered column lands after its hidden cards.
  const shown = useMemo(() => cards.filter((c) => matchesQuery(c, query)), [cards, query])
  const grouped = useMemo(() => groupByColumn(shown, columns), [shown, columns])
  const activeCard = activeId != null ? cards.find((c) => c.id === activeId) || null : null

  async function reload() {
    if (!project) return
    const c = await api.orgCards({ project: project.id })
    setCards(c.cards || [])
  }

  /** Open a decision-queue item in the thread of the session that owns it (its
   *  thread renders the actual decision card). Resolves the session from the
   *  loaded list when it is on this host; a decision on another host is
   *  shown, not opened, until a cross-host session lookup exists. */
  function openDecision(d: OpenDecision): boolean {
    const s = findCardSession(sessions, d.session)
    const sameHost = s && (s.host === d.host || (d.host === "local" && s.host === "local"))
    if (!sameHost) return false
    onClose()
    loadSession(s.path)
    return true
  }

  function onDragEnd(ev: DragEndEvent) {
    setActiveId(null)
    const cardId = Number(ev.active.id)
    const overId = ev.over?.id
    if (overId == null) return
    const targetCol = Number(String(overId).replace(/^col:/, ""))
    const card = cards.find((c) => c.id === cardId)
    if (!card || card.column_id === targetCol) return
    // Drop at the end of the target column.
    const inTarget = orderColumn(cards.filter((c) => c.column_id === targetCol && c.id !== cardId))
    const position = nextPosition(inTarget, inTarget.length)
    // Optimistic move, then persist.
    setCards((cs) => cs.map((c) => (c.id === cardId ? { ...c, column_id: targetCol, position } : c)))
    api.orgMoveCard({ card_id: cardId, column_id: targetCol, position }).catch(() => reload())
  }

  async function addCard(columnId: number, title: string) {
    if (!project || !title.trim()) return
    const inCol = cards.filter((c) => c.column_id === columnId)
    const created = await api.orgCreateCard({
      title: title.trim(),
      column_id: columnId,
      project_id: project.id,
      position: nextPosition(inCol, inCol.length),
    })
    setCards((cs) => [...cs, created])
  }

  async function deleteCard(id: number) {
    setCards((cs) => cs.filter((c) => c.id !== id))
    // `card_delete` is Red: a caller who can't self-approve gets an approval
    // back, not a deletion. Reload so the card reappears — otherwise it looks
    // deleted while it still exists on the board.
    await api
      .orgDeleteCard(id)
      .then((r) => { if (isQueued(r)) reload() })
      .catch(() => reload())
  }

  async function addColumn() {
    if (!project || !newColName.trim()) return
    const created = await api.orgCreateColumn({
      project_id: project.id,
      name: newColName.trim(),
      position: columns.length,
    })
    setColumns((cs) => [...cs, created])
    setNewColName("")
    setAddingCol(false)
  }

  async function renameColumn(id: number, nm: string) {
    const updated = await api.orgUpdateColumn({ id, name: nm })
    setColumns((cs) => cs.map((c) => (c.id === id ? { ...c, ...updated } : c)))
  }

  async function deleteColumn(id: number) {
    setColumns((cs) => cs.filter((c) => c.id !== id))
    await api.orgDeleteColumn(id).catch(() => {})
    reload()
  }

  // Card delete always confirms: it removes the card AND its comment thread.
  // Column delete confirms only when the column holds cards — an empty column
  // is free to drop (adding one back is one click, nothing is at stake).
  function requestDeleteCard(card: Card) {
    setConfirm({ kind: "card", card })
  }
  function requestDeleteColumn(column: BoardColumn) {
    const count = cards.filter((c) => c.column_id === column.id).length
    if (count === 0) {
      deleteColumn(column.id)
      return
    }
    setConfirm({ kind: "column", column, count })
  }
  function confirmDelete() {
    if (!confirm) return
    if (confirm.kind === "card") deleteCard(confirm.card.id)
    else deleteColumn(confirm.column.id)
    setConfirm(null)
  }

  /** Open a card's detail by id. A card on another project's board (the
   *  decision queue is org-wide) is read from the server with ITS board's
   *  columns, so its moves are that board's moves. False = unreadable. */
  async function openCard(id: number): Promise<boolean> {
    const here = cards.find((x) => x.id === id)
    if (here) { setEditingColumns(null); setEditing(here); return true }
    try {
      const r = await api.orgCard(id)
      if (!r.card) return false
      setEditingColumns(r.columns || [])
      setEditing(r.card)
      return true
    } catch {
      return false
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col sm:max-w-[95vw]">
        <DialogHeader className="pr-10">
          <div className="flex items-center gap-3">
            <DialogTitle className="flex-1">Tasks · {name}</DialogTitle>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Enter on a single hit opens it — "#107" + Enter jumps straight to the card.
                  if (e.key === "Enter" && shown.length === 1) setEditing(shown[0])
                  if (e.key === "Escape" && query) { e.stopPropagation(); setQuery("") }
                }}
                placeholder="Find #107 or words"
                className="h-8 w-52 pl-7 text-sm"
                aria-label="Find a task"
              />
            </div>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAuditOpen(true)} title="Who did what, and when">
              <History className="size-3.5" /> Activity
            </Button>
          </div>
          <DialogDescription>
            The project board. Every chat session working in this project shares these tasks.
          </DialogDescription>
        </DialogHeader>

        <DecisionsBand
          onOpenSession={openDecision}
          onOpenCard={openCard}
        />

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : err ? (
          <div className="flex flex-1 items-center justify-center text-sm text-destructive">{err}</div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={(e: DragStartEvent) => setActiveId(Number(e.active.id))}
            onDragEnd={onDragEnd}
          >
            <div className="flex flex-1 gap-3 overflow-x-auto pb-2">
              {grouped.map(({ column, cards: colCards }) => (
                <ColumnView
                  key={column.id}
                  column={column}
                  cards={colCards}
                  onAddCard={(t) => addCard(column.id, t)}
                  onEditCard={setEditing}
                  onDeleteCard={(id) => {
                    const c = cards.find((x) => x.id === id)
                    if (c) requestDeleteCard(c)
                  }}
                  onRename={(nm) => renameColumn(column.id, nm)}
                  onDelete={() => requestDeleteColumn(column)}
                />
              ))}
              {/* Add column */}
              <div className="w-72 shrink-0">
                {addingCol ? (
                  <div className="flex items-center gap-1.5 rounded-md border border-border p-2">
                    <Input
                      autoFocus
                      value={newColName}
                      onChange={(e) => setNewColName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addColumn()}
                      placeholder="Column name"
                      className="h-8 text-sm"
                    />
                    <Button size="icon" className="size-8" onClick={addColumn}><Check className="size-4" /></Button>
                    <Button size="icon" variant="ghost" className="size-8" onClick={() => setAddingCol(false)}><X className="size-4" /></Button>
                  </div>
                ) : (
                  <Button variant="outline" className="w-full gap-1" onClick={() => setAddingCol(true)}>
                    <Plus className="size-4" /> Add column
                  </Button>
                )}
              </div>
            </div>

            <DragOverlay>
              {activeCard ? <CardFace card={activeCard} dragging /> : null}
            </DragOverlay>
          </DndContext>
        )}
      </DialogContent>

      {editing && (
        <CardDetail
          card={editing}
          allCards={cards}
          columns={editingColumns ?? columns}
          selfUsername={authUser?.username}
          sessionTitle={editingSession?.title}
          onOpenSession={editingSession ? () => { onClose(); loadSession(editingSession.path) } : undefined}
          onChange={(updated) => {
            setCards((cs) => cs.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)))
            setEditing((e) => (e && e.id === updated.id ? { ...e, ...updated } : e))
          }}
          onDelete={(id) => {
            const c = editing || cards.find((x) => x.id === id)
            if (c) requestDeleteCard(c)
          }}
          onClose={() => { setEditing(null); setEditingColumns(null) }}
        />
      )}

      {auditOpen && (
        <AuditDialog
          selfUsername={authUser?.username}
          onOpenCard={(id) => { setAuditOpen(false); return openCard(id) }}
          onClose={() => setAuditOpen(false)}
        />
      )}

      {confirm && (
        <Dialog open onOpenChange={(o) => !o && setConfirm(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {confirm.kind === "card"
                  ? `Delete card “${confirm.card.title}”?`
                  : `Delete column “${confirm.column.name}”?`}
              </DialogTitle>
              <DialogDescription>
                {confirm.kind === "card"
                  ? "The card and its comment thread are removed from the board. This can't be undone."
                  : `Its ${confirm.count} card${confirm.count === 1 ? "" : "s"} move to Unsorted with their comments intact; only the column itself is removed.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button variant="destructive" onClick={confirmDelete}>Delete</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  )
}

// ── One column: droppable, its cards, add-card input, rename/delete ──────────
function ColumnView({
  column,
  cards,
  onAddCard,
  onEditCard,
  onDeleteCard,
  onRename,
  onDelete,
}: {
  column: BoardColumn
  cards: Card[]
  onAddCard: (title: string) => void
  onEditCard: (c: Card) => void
  onDeleteCard: (id: number) => void
  onRename: (name: string) => void
  onDelete: () => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${column.id}` })
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState("")
  const [renaming, setRenaming] = useState(false)
  const [nm, setNm] = useState(column.name)
  const isSynthetic = column.id === 0 // "Unsorted" bucket — not a real column

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-md border border-border bg-card/40",
        isOver && "ring-2 ring-primary/40"
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-2">
        {renaming ? (
          <>
            <Input autoFocus value={nm} onChange={(e) => setNm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (onRename(nm), setRenaming(false))}
              className="h-7 text-sm" />
            <Button size="icon" variant="ghost" className="size-6" onClick={() => { onRename(nm); setRenaming(false) }}><Check className="size-3.5" /></Button>
          </>
        ) : (
          <>
            <span className="flex-1 truncate text-sm font-semibold">{column.name}</span>
            <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1.5 text-[10px] tabular-nums">{cards.length}</Badge>
            {!isSynthetic && (
              <>
                <Button size="icon" variant="ghost" className="size-6" onClick={() => setRenaming(true)} title="Rename"><Pencil className="size-3" /></Button>
                <Button size="icon" variant="ghost" className="size-6 text-muted-foreground hover:text-destructive" onClick={onDelete} title="Delete column"><Trash2 className="size-3" /></Button>
              </>
            )}
          </>
        )}
      </div>

      <div className="flex min-h-12 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
        {cards.map((c) => (
          <DraggableCard key={c.id} card={c} onEdit={() => onEditCard(c)} onDelete={() => onDeleteCard(c.id)} />
        ))}
      </div>

      {!isSynthetic && (
        <div className="border-t border-border p-2">
          {adding ? (
            <div className="flex items-center gap-1.5">
              <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && title.trim()) { onAddCard(title); setTitle("") } if (e.key === "Escape") setAdding(false) }}
                placeholder="Task title" className="h-8 text-sm" />
              <Button size="icon" className="size-8" disabled={!title.trim()} onClick={() => { onAddCard(title); setTitle("") }}><Check className="size-4" /></Button>
              <Button size="icon" variant="ghost" className="size-8" onClick={() => setAdding(false)}><X className="size-4" /></Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" className="w-full justify-start gap-1 text-muted-foreground" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" /> Add task
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

// ── A draggable card ─────────────────────────────────────────────────────────
function DraggableCard({ card, onEdit, onDelete }: { card: Card; onEdit: () => void; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.id })
  return (
    <div ref={setNodeRef} className={cn(isDragging && "opacity-40")}>
      <CardFace card={card} onEdit={onEdit} onDelete={onDelete} handleProps={{ ...attributes, ...listeners }} />
    </div>
  )
}

function CardFace({
  card,
  dragging,
  onEdit,
  onDelete,
  handleProps,
}: {
  card: Card
  dragging?: boolean
  onEdit?: () => void
  onDelete?: () => void
  handleProps?: Record<string, unknown>
}) {
  return (
    <div className={cn("group rounded-md border border-border bg-background p-2 text-xs shadow-sm", dragging && "rotate-2 shadow-md")}>
      <div className="flex items-start gap-1">
        <button className="mt-0.5 cursor-grab text-muted-foreground/50 active:cursor-grabbing" {...handleProps} title="Drag">
          <GripVertical className="size-3.5" />
        </button>
        <button className="min-w-0 flex-1 text-left" onClick={onEdit} data-track="card row">
          <div className="font-medium leading-snug">
            <span className="mr-1 font-normal tabular-nums text-muted-foreground">#{card.id}</span>
            {card.title}
          </div>
          {card.body && <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{card.body}</div>}
        </button>
        {onDelete && (
          <button className="text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100" onClick={onDelete} title="Delete task">
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      {(card.comment_count ?? 0) > 0 && (
        <div className="mt-1.5 flex items-center gap-1 pl-5 text-[10px] text-muted-foreground">
          <MessageSquare className="size-3" /> {card.comment_count}
        </div>
      )}
    </div>
  )
}

// ── Card editor modal (title / body / the discussion thread) ──────
// The thread is the card's decision surface: the owner and the card's session
// talk here. A move to Review/Approved/Declined (this dialog, a drag, or the
// phone) wakes the card's session server-side (boardwatch); a comment from an
// agent pushes the owner. Posting a comment here is what reaches the session.
