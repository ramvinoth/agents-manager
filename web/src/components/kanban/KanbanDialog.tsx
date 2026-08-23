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
import { Plus, Trash2, Pencil, Loader2, GripVertical, Check, X, User } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { groupByColumn, orderColumn, nextPosition } from "@/lib/board"
import type { BoardColumn, Card, Employee, OrgProject } from "@/lib/types"

const UNASSIGNED = "__unassigned__"

/**
 * KanbanDialog — the project's task board in a big modal. Resolves which org
 * project a session-directory (host + cwd) maps to (find-or-create), then loads
 * that project's columns + cards + the employee roster. Full CRUD: drag cards
 * between/within columns (dnd-kit + fractional positions), add/edit/delete cards,
 * assign an employee, and add/rename/delete columns. Every write goes to
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
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState("")
  const [activeId, setActiveId] = useState<number | null>(null)
  const [editing, setEditing] = useState<Card | null>(null) // card editor (null = closed)
  const [addingCol, setAddingCol] = useState(false)
  const [newColName, setNewColName] = useState("")

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const proj = await api.orgProjectForCwd({ host, cwd, name })
        if (!alive) return
        setProject(proj)
        const [b, c, e] = await Promise.all([
          api.orgBoard(proj.id),
          api.orgCards({ project: proj.id }),
          api.orgEmployees(),
        ])
        if (!alive) return
        setColumns(b.columns || [])
        setCards(c.cards || [])
        setEmployees(e.employees || [])
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

  const grouped = useMemo(() => groupByColumn(cards, columns), [cards, columns])
  const activeCard = activeId != null ? cards.find((c) => c.id === activeId) || null : null

  async function reload() {
    if (!project) return
    const c = await api.orgCards({ project: project.id })
    setCards(c.cards || [])
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

  async function saveCardEdit(patch: { title: string; body: string; assignee: number | null }) {
    if (!editing) return
    const updated = await api.orgUpdateCard({
      card_id: editing.id,
      title: patch.title,
      body: patch.body,
      ...(patch.assignee != null ? { assignee: patch.assignee } : {}),
    })
    setCards((cs) => cs.map((c) => (c.id === editing.id ? { ...c, ...updated } : c)))
    setEditing(null)
  }

  async function deleteCard(id: number) {
    setCards((cs) => cs.filter((c) => c.id !== id))
    await api.orgDeleteCard(id).catch(() => reload())
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

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col sm:max-w-[95vw]">
        <DialogHeader>
          <DialogTitle>Tasks · {name}</DialogTitle>
          <DialogDescription>
            The project board. Every chat session working in this project shares these tasks.
          </DialogDescription>
        </DialogHeader>

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
                  empById={empById}
                  onAddCard={(t) => addCard(column.id, t)}
                  onEditCard={setEditing}
                  onDeleteCard={deleteCard}
                  onRename={(nm) => renameColumn(column.id, nm)}
                  onDelete={() => deleteColumn(column.id)}
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
              {activeCard ? <CardFace card={activeCard} empById={empById} dragging /> : null}
            </DragOverlay>
          </DndContext>
        )}
      </DialogContent>

      {editing && (
        <CardEditor
          card={editing}
          employees={employees}
          onSave={saveCardEdit}
          onClose={() => setEditing(null)}
        />
      )}
    </Dialog>
  )
}

// ── One column: droppable, its cards, add-card input, rename/delete ──────────
function ColumnView({
  column,
  cards,
  empById,
  onAddCard,
  onEditCard,
  onDeleteCard,
  onRename,
  onDelete,
}: {
  column: BoardColumn
  cards: Card[]
  empById: Map<number, Employee>
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
          <DraggableCard key={c.id} card={c} empById={empById} onEdit={() => onEditCard(c)} onDelete={() => onDeleteCard(c.id)} />
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
function DraggableCard({ card, empById, onEdit, onDelete }: { card: Card; empById: Map<number, Employee>; onEdit: () => void; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.id })
  return (
    <div ref={setNodeRef} className={cn(isDragging && "opacity-40")}>
      <CardFace card={card} empById={empById} onEdit={onEdit} onDelete={onDelete} handleProps={{ ...attributes, ...listeners }} />
    </div>
  )
}

function CardFace({
  card,
  empById,
  dragging,
  onEdit,
  onDelete,
  handleProps,
}: {
  card: Card
  empById: Map<number, Employee>
  dragging?: boolean
  onEdit?: () => void
  onDelete?: () => void
  handleProps?: Record<string, unknown>
}) {
  const emp = card.assignee != null ? empById.get(card.assignee) : undefined
  return (
    <div className={cn("group rounded-md border border-border bg-background p-2 text-xs shadow-sm", dragging && "rotate-2 shadow-md")}>
      <div className="flex items-start gap-1">
        <button className="mt-0.5 cursor-grab text-muted-foreground/50 active:cursor-grabbing" {...handleProps} title="Drag">
          <GripVertical className="size-3.5" />
        </button>
        <button className="min-w-0 flex-1 text-left" onClick={onEdit}>
          <div className="font-medium leading-snug">{card.title}</div>
          {card.body && <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{card.body}</div>}
        </button>
        {onDelete && (
          <button className="text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100" onClick={onDelete} title="Delete task">
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      {emp && (
        <div className="mt-1.5 flex items-center gap-1 pl-5 text-[10px] text-muted-foreground">
          <User className="size-3" /> {emp.name}
        </div>
      )}
    </div>
  )
}

// ── Card editor modal (title / body / assignee) ──────────────────────────────
function CardEditor({
  card,
  employees,
  onSave,
  onClose,
}: {
  card: Card
  employees: Employee[]
  onSave: (patch: { title: string; body: string; assignee: number | null }) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(card.title)
  const [body, setBody] = useState(card.body)
  const [assignee, setAssignee] = useState<string>(card.assignee != null ? String(card.assignee) : UNASSIGNED)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit task</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="text-sm" />
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Details…" className="min-h-24 resize-none text-sm" />
          <div>
            <div className="mb-1 text-[11px] text-muted-foreground">Assignee</div>
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>{e.name}{e.role ? ` · ${e.role}` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button
              disabled={!title.trim()}
              onClick={() => onSave({ title: title.trim(), body: body.trim(), assignee: assignee === UNASSIGNED ? null : Number(assignee) })}
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
