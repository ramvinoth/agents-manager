import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Archive, ArchiveRestore, Eye, Loader2, Pencil, Pin, Plus, Search, Trash2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { fmtAgo } from "@/lib/format"
import { KIND_LABEL, displayTitle, noteTemplates, orderNotes, previewLine, searchNotes } from "@/lib/notes"
import { Markdown } from "@/components/Markdown"
import { isQueued } from "@/lib/types"
import type { Note, NoteKind, OrgProject } from "@/lib/types"

const SAVE_DEBOUNCE_MS = 700

/**
 * NotesDialog — the project's notes ledger (viewer/db `notes`) as a two-pane
 * modal: list on the left (search, archived shelf, template "+"), editor on the
 * right (title, kind, markdown body with autosave and a preview toggle, pin /
 * archive / delete). Resolves the org project from (host, cwd) exactly like the
 * board, so the notes here are the ones agents in this directory's sessions
 * write through their note_* MCP tools.
 */
export function NotesDialog({ host, cwd, name, onClose }: { host: string; cwd: string; name: string; onClose: () => void }) {
  const [project, setProject] = useState<OrgProject | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState("")
  const [archived, setArchived] = useState(false)
  const [q, setQ] = useState("")
  const [openId, setOpenId] = useState<number | null>(null)

  const load = useCallback(async (proj: OrgProject, shelf: boolean) => {
    const r = await api.orgNotes({ project: proj.id, archived: shelf })
    setNotes(r.notes || [])
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const proj = await api.orgProjectForCwd({ host, cwd, name })
        if (!alive) return
        setProject(proj)
        await load(proj, archived)
        setErr("")
      } catch (ex: any) {
        if (alive) setErr(String(ex?.message || ex))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [host, cwd, name, archived, load])

  const shown = useMemo(() => orderNotes(searchNotes(notes, q)), [notes, q])
  const open = openId != null ? notes.find((n) => n.id === openId) || null : null

  function patchLocal(n: Note) {
    setNotes((all) => all.map((x) => (x.id === n.id ? n : x)))
  }

  async function create(kind: NoteKind, body: string) {
    if (!project) return
    try {
      const n = await api.orgCreateNote({ title: "", body, kind, project_id: project.id })
      if (archived) setArchived(false)
      setNotes((all) => [n, ...all])
      setOpenId(n.id)
    } catch (ex: any) {
      setErr(String(ex?.message || ex))
    }
  }

  async function update(id: number, fields: { title?: string; body?: string; kind?: NoteKind; pinned?: boolean; archived?: boolean }) {
    const n = await api.orgUpdateNote({ note_id: id, ...fields })
    if (fields.archived !== undefined && fields.archived !== archived) {
      // Left this shelf — drop it from the list; the other shelf will load it.
      setNotes((all) => all.filter((x) => x.id !== id))
      setOpenId(null)
    } else patchLocal(n)
    return n
  }

  async function remove(n: Note) {
    if (!window.confirm(`Delete "${displayTitle(n)}"? This cannot be undone — archiving keeps it.`)) return
    const r = await api.orgDeleteNote(n.id)
    if (isQueued(r)) { setErr("Deleting is irreversible, so it was queued for the owner's approval."); return }
    setNotes((all) => all.filter((x) => x.id !== n.id))
    setOpenId(null)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col sm:max-w-[95vw]">
        <DialogHeader>
          <DialogTitle>Notes · {project?.name || name}</DialogTitle>
          <DialogDescription>
            Notes, journals, meeting notes and checklists for this project — yours and the ones agents write from their chats.
          </DialogDescription>
        </DialogHeader>
        {err && <div className="text-sm text-destructive">{err}</div>}
        {loading ? (
          <div className="flex flex-1 items-center justify-center"><Loader2 className="size-5 animate-spin" /></div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-4">
            <aside className="flex w-72 shrink-0 flex-col gap-2 border-r border-border pr-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="pl-8" />
                </div>
                <NewNoteMenu onPick={create} />
              </div>
              <button
                onClick={() => { setArchived((v) => !v); setOpenId(null); setLoading(true) }}
                className={cn("self-start rounded-full border px-2 py-0.5 text-xs", archived ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground")}
              >
                Archived
              </button>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {shown.length === 0 && (
                  <div className="p-3 text-sm text-muted-foreground">
                    {archived ? "Nothing archived." : q ? "No matches." : "No notes yet — press + to start one."}
                  </div>
                )}
                {shown.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => setOpenId(n.id)}
                    className={cn("flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left hover:bg-accent", n.id === openId && "bg-accent")}
                  >
                    <div className="flex items-center gap-1">
                      {n.pinned && <Pin className="size-3 text-primary" />}
                      <span className="flex-1 truncate text-sm font-medium">{displayTitle(n)}</span>
                      <span className="text-xs text-muted-foreground">{fmtAgo(n.updated_at)}</span>
                    </div>
                    {previewLine(n) && <div className="truncate text-xs text-muted-foreground">{previewLine(n)}</div>}
                    <div className="text-[11px] text-muted-foreground">{KIND_LABEL[n.kind]} · {n.created_by.replace(/^(user|session):/, "")}</div>
                  </button>
                ))}
              </div>
            </aside>
            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              {open ? (
                <NoteEditor key={open.id} note={open} onChange={(f) => update(open.id, f)} onDelete={() => remove(open)} />
              ) : (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  Pick a note, or press + to start one.
                </div>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function NewNoteMenu({ onPick }: { onPick: (kind: NoteKind, body: string) => void }) {
  const [openMenu, setOpenMenu] = useState(false)
  const templates = noteTemplates()
  return (
    <div className="relative">
      <Button size="icon" variant="outline" onClick={() => setOpenMenu((v) => !v)} title="New note"><Plus className="size-4" /></Button>
      {openMenu && (
        <div className="absolute right-0 z-10 mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-md">
          {templates.map((tp) => (
            <button
              key={tp.kind}
              onClick={() => { setOpenMenu(false); onPick(tp.kind, tp.body) }}
              className="flex w-full flex-col rounded px-2 py-1.5 text-left hover:bg-accent"
            >
              <span className="text-sm font-medium">{tp.label}</span>
              <span className="text-xs text-muted-foreground">{tp.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** One open note. Title + body autosave (debounced; a pending draft flushes on
 *  unmount), a preview toggle through the app's ONE markdown renderer. */
function NoteEditor({
  note,
  onChange,
  onDelete,
}: {
  note: Note
  onChange: (f: { title?: string; body?: string; kind?: NoteKind; pinned?: boolean; archived?: boolean }) => Promise<Note>
  onDelete: () => void
}) {
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)
  const [preview, setPreview] = useState(false)
  const [status, setStatus] = useState<"" | "saving" | "failed">("")
  const draft = useRef<{ title?: string; body?: string }>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(async () => {
    const pending = draft.current
    draft.current = {}
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (pending.title === undefined && pending.body === undefined) return
    setStatus("saving")
    try {
      await onChange(pending)
      setStatus("")
    } catch {
      draft.current = { ...pending, ...draft.current }
      setStatus("failed")
    }
  }, [onChange])

  useEffect(() => () => { flush() }, [flush])

  function queue(patch: { title?: string; body?: string }) {
    draft.current = { ...draft.current, ...patch }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }

  const kinds = Object.keys(KIND_LABEL) as NoteKind[]
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          value={title}
          onChange={(e) => { setTitle(e.target.value); queue({ title: e.target.value }) }}
          placeholder="Title"
          className="border-0 px-0 text-xl font-semibold shadow-none focus-visible:ring-0"
        />
        <Button size="icon" variant="ghost" title={preview ? "Edit" : "Preview"} onClick={() => setPreview((v) => !v)}>
          {preview ? <Pencil className="size-4" /> : <Eye className="size-4" />}
        </Button>
        <Button size="icon" variant="ghost" title={note.pinned ? "Unpin" : "Pin"} onClick={() => onChange({ pinned: !note.pinned })}>
          <Pin className={cn("size-4", note.pinned && "text-primary")} />
        </Button>
        <Button size="icon" variant="ghost" title={note.archived ? "Unarchive" : "Archive"} onClick={() => onChange({ archived: !note.archived })}>
          {note.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
        </Button>
        <Button size="icon" variant="ghost" title="Delete" onClick={onDelete}>
          <Trash2 className="size-4 text-destructive" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {kinds.map((k) => (
          <Badge
            key={k}
            variant={note.kind === k ? "default" : "outline"}
            className="cursor-pointer"
            onClick={() => onChange({ kind: k })}
          >
            {KIND_LABEL[k]}
          </Badge>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {status === "saving" ? "saving…" : status === "failed" ? "not saved yet — retries as you type" : `edited ${fmtAgo(note.updated_at)}`}
        </span>
      </div>
      {preview ? (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border p-3">
          <Markdown text={body || "_Nothing here yet._"} />
        </div>
      ) : (
        <Textarea
          value={body}
          onChange={(e) => { setBody(e.target.value); queue({ body: e.target.value }) }}
          placeholder="Write in markdown — # headings, - lists, - [ ] checkboxes, **bold**"
          className="min-h-0 flex-1 resize-none font-mono text-sm"
        />
      )}
    </div>
  )
}
