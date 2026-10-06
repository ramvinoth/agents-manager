import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Archive, ArchiveRestore, ArrowLeft, Download, Eye, Loader2, MessageSquare, Network, Pencil, Pin, Plus, Search, Trash2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { fmtAgo } from "@/lib/format"
import { KIND_LABEL, displayTitle, noteTemplates, orderNotes, previewLine, searchNotes } from "@/lib/notes"
import { Markdown, type NoteLinkHandlers } from "@/components/Markdown"
import { completeLink, filterByTags, neighbours, openLinkQuery, resolveLink, suggestTitles, type NoteGraph } from "@/lib/noteLinks"
import { NoteGraphView } from "./NoteGraphView"
import { NoteThread } from "./NoteThread"
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
 *
 * Notes link like an Obsidian vault: `[[Title]]` and `#tags` in a body. The
 * server derives the graph from the bodies (viewer/notelinks.py); this dialog
 * reads it to make links clickable (a link to a note not written yet creates
 * it), list backlinks under the open note, filter by tag, draw the graph, and
 * export the whole project as a vault.
 */
export function NotesDialog({ host, cwd, name, onClose }: { host: string; cwd: string; name: string; onClose: () => void }) {
  const [project, setProject] = useState<OrgProject | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState("")
  const [archived, setArchived] = useState(false)
  const [q, setQ] = useState("")
  const [openId, setOpenId] = useState<number | null>(null)
  const [graph, setGraph] = useState<NoteGraph | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [showGraph, setShowGraph] = useState(false)
  const [reading, setReading] = useState(false)
  const [trail, setTrail] = useState<number[]>([])   // notes roamed through, for Back
  const [flash, setFlash] = useState("")

  // The graph spans both shelves; refreshed after every save that can change it.
  const refreshGraph = useCallback(async (proj: OrgProject | null) => {
    if (!proj) return
    try { setGraph(await api.orgNotesGraph(proj.id)) } catch { /* links stay plain until the next save */ }
  }, [])

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
        await Promise.all([load(proj, archived), refreshGraph(proj)])
        setErr("")
      } catch (ex: any) {
        if (alive) setErr(String(ex?.message || ex))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [host, cwd, name, archived, load, refreshGraph])

  const shown = useMemo(() => orderNotes(filterByTags(searchNotes(notes, q), graph, tags)), [notes, q, graph, tags])
  const open = openId != null ? notes.find((n) => n.id === openId) || null : null
  const titles = useMemo(() => (graph?.nodes || []).filter((n) => !n.archived).map((n) => n.title), [graph])

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(""), 4000)
    return () => clearTimeout(t)
  }, [flash])

  /** Open a note by id from anywhere (a link, a backlink, the graph),
   *  switching shelf when it lives on the other one; Back retraces. */
  function go(id: number, from: number | null = openId) {
    const node = graph?.nodes.find((n) => n.id === id)
    if (node && node.archived !== archived) { setLoading(true); setArchived(node.archived) }
    if (from != null && from !== id) setTrail((t) => [...t.slice(-49), from])
    setShowGraph(false)
    setOpenId(id)
  }

  function back() {
    const prev = trail[trail.length - 1]
    if (prev == null) return
    setTrail((t) => t.slice(0, -1))
    go(prev, null)
  }

  /** A [[link]] was followed: open its note, or write the note it promises. */
  async function follow(target: string) {
    const id = resolveLink(graph, project?.id ?? null, target)
    if (id != null) go(id)
    else await create("note", "", target.trim())
  }

  const linkHandlers = useMemo<NoteLinkHandlers>(() => ({
    resolves: (t) => resolveLink(graph, project?.id ?? null, t) != null,
    onLink: (t) => { void follow(t) },
    onTag: (t) => setTags((cur) => (cur.includes(t) ? cur : [...cur, t])),
    // follow/go read the latest state through this memo's deps
  }), [graph, project, openId, archived, notes])

  function patchLocal(n: Note) {
    // A write returns the bare row; the thread stats ride only on the list read.
    setNotes((all) => all.map((x) => (x.id === n.id ? { ...x, ...n } : x)))
  }

  async function create(kind: NoteKind, body: string, title = "") {
    if (!project) return
    try {
      const n = await api.orgCreateNote({ title, body, kind, project_id: project.id })
      if (archived) setArchived(false)
      setNotes((all) => [n, ...all])
      if (openId != null) setTrail((t) => [...t.slice(-49), openId])
      setShowGraph(false)
      setReading(false)
      setOpenId(n.id)
      void refreshGraph(project)
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
    if (n.relinked && project) {
      // A rename rewrote [[links]] in other notes: show them as stored now.
      setFlash(`Renamed — updated the links in ${n.relinked} note${n.relinked === 1 ? "" : "s"}.`)
      await load(project, archived)
    }
    if (fields.title !== undefined || fields.body !== undefined || fields.archived !== undefined) void refreshGraph(project)
    return n
  }

  async function remove(n: Note) {
    if (!window.confirm(`Delete "${displayTitle(n)}"? This cannot be undone — archiving keeps it.`)) return
    const r = await api.orgDeleteNote(n.id)
    if (isQueued(r)) { setErr("Deleting is irreversible, so it was queued for the owner's approval."); return }
    setNotes((all) => all.filter((x) => x.id !== n.id))
    setTrail((t) => t.filter((x) => x !== n.id))
    setOpenId(null)
    void refreshGraph(project)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex h-[90vh] max-w-[95vw] flex-col sm:max-w-[95vw]"
        // Radix catches Escape on the document before the editor sees it: while
        // the [[ suggestion list is open, Escape closes that list, not the notes.
        onEscapeKeyDown={(e) => { if ((e.target as HTMLElement | null)?.getAttribute?.("aria-expanded") === "true") e.preventDefault() }}
      >
        <DialogHeader>
          <DialogTitle>Notes · {project?.name || name}</DialogTitle>
          <DialogDescription>
            Notes, journals, meeting notes and checklists for this project — yours and the ones agents write from their chats.
          </DialogDescription>
        </DialogHeader>
        {err && <div className="text-sm text-destructive">{err}</div>}
        {flash && <div className="text-sm text-muted-foreground">{flash}</div>}
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
                <NewNoteMenu onPick={(k, b) => create(k, b)} />
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <button
                  onClick={() => { setArchived((v) => !v); setOpenId(null); setLoading(true) }}
                  className={cn("rounded-full border px-2 py-0.5 text-xs", archived ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground")}
                >
                  Archived
                </button>
                <button
                  onClick={() => setShowGraph((v) => !v)}
                  title="See how your notes connect"
                  className={cn("flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs", showGraph ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground")}
                >
                  <Network className="size-3" /> Graph
                </button>
                {project && (
                  <a
                    href={api.orgNotesExportUrl(project.id)}
                    download
                    title="Download every note in this project as an Obsidian vault (a .zip of markdown files)"
                    className="ml-auto flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                  >
                    <Download className="size-3" /> Export
                  </a>
                )}
              </div>
              {!!graph?.tags.length && (
                <div className="flex max-h-16 flex-wrap gap-1 overflow-y-auto">
                  {graph.tags.slice(0, 30).map(({ tag, count }) => (
                    <button
                      key={tag}
                      data-track="tag filter"
                      onClick={() => setTags((cur) => (cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag]))}
                      className={cn("rounded-full px-1.5 text-[11px]", tags.includes(tag) ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary")}
                    >
                      #{tag} <span className="opacity-60">{count}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto">
                {shown.length === 0 && (
                  <div className="p-3 text-sm text-muted-foreground">
                    {archived ? "Nothing archived." : q || tags.length ? "No matches." : "No notes yet — press + to start one."}
                  </div>
                )}
                {shown.map((n) => (
                  <button
                    key={n.id}
                    data-track="note row"
                    onClick={() => { setShowGraph(false); setTrail([]); setOpenId(n.id) }}
                    className={cn("flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left hover:bg-accent", n.id === openId && "bg-accent")}
                  >
                    <div className="flex items-center gap-1">
                      {n.pinned && <Pin className="size-3 text-primary" />}
                      <span className="flex-1 truncate text-sm font-medium">{displayTitle(n)}</span>
                      <span className="text-xs text-muted-foreground">{fmtAgo(n.updated_at)}</span>
                    </div>
                    {previewLine(n) && <div className="truncate text-xs text-muted-foreground">{previewLine(n)}</div>}
                    <div className="text-[11px] text-muted-foreground">
                      {KIND_LABEL[n.kind]} · {n.created_by.replace(/^(user|session):/, "")}
                      {!!n.replies && <> · <MessageSquare className="inline size-3" /> {n.replies}</>}
                    </div>
                  </button>
                ))}
              </div>
            </aside>
            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              {showGraph && graph ? (
                <NoteGraphView graph={graph} openId={openId} onOpen={(id) => go(id)} onCreate={(t) => void follow(t)} />
              ) : open ? (
                <NoteEditor
                  key={open.id}
                  note={open}
                  onChange={(f) => update(open.id, f)}
                  onDelete={() => remove(open)}
                  reading={reading}
                  setReading={setReading}
                  links={linkHandlers}
                  titles={titles}
                  neighbourhood={neighbours(graph, open.id)}
                  onOpen={(id) => go(id)}
                  onBack={trail.length ? back : undefined}
                  onReplies={(n) => setNotes((ns) => ns.map((x) => (x.id === open.id ? { ...x, replies: n } : x)))}
                />
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
 *  unmount), a reading view through the app's ONE markdown renderer with
 *  clickable [[links]] and #tags, `[[` title suggestions while writing, and the
 *  note's backlinks underneath. */
function NoteEditor({
  note,
  onChange,
  onDelete,
  reading,
  setReading,
  links,
  titles,
  neighbourhood,
  onOpen,
  onBack,
  onReplies,
}: {
  note: Note
  onChange: (f: { title?: string; body?: string; kind?: NoteKind; pinned?: boolean; archived?: boolean }) => Promise<Note & { relinked?: number }>
  onDelete: () => void
  reading: boolean
  setReading: (v: boolean) => void
  links: NoteLinkHandlers
  titles: string[]
  neighbourhood: ReturnType<typeof neighbours>
  onOpen: (id: number) => void
  onBack?: () => void
  onReplies: (n: number) => void
}) {
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)
  const [status, setStatus] = useState<"" | "saving" | "failed">("")
  const [suggest, setSuggest] = useState<{ start: number; caret: number; items: string[]; sel: number } | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const draft = useRef<{ title?: string; body?: string }>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(async () => {
    const pending = draft.current
    draft.current = {}
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (pending.title === undefined && pending.body === undefined) return
    setStatus("saving")
    try {
      const n = await onChange(pending)
      // A rename can rewrite this note's own links to itself: adopt the stored
      // body, unless newer typing is already queued (it would be overwritten).
      if (n.relinked && draft.current.body === undefined) setBody(n.body)
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

  /** Re-read the caret after every keystroke/click: an open `[[` shows titles. */
  function track(text: string, caret: number) {
    const open = openLinkQuery(text, caret)
    const items = open ? suggestTitles(titles, open.query, 8, title) : []
    setSuggest(open && items.length ? { start: open.start, caret, items, sel: 0 } : null)
  }

  function pickSuggestion(t: string) {
    if (!suggest) return
    const r = completeLink(body, suggest.start, suggest.caret, t)
    setBody(r.text)
    queue({ body: r.text })
    setSuggest(null)
    requestAnimationFrame(() => { area.current?.focus(); area.current?.setSelectionRange(r.caret, r.caret) })
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!suggest) return
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const d = e.key === "ArrowDown" ? 1 : -1
      setSuggest({ ...suggest, sel: (suggest.sel + d + suggest.items.length) % suggest.items.length })
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      pickSuggestion(suggest.items[suggest.sel])
    } else if (e.key === "Escape") {
      e.preventDefault()
      setSuggest(null)
    }
  }

  const kinds = Object.keys(KIND_LABEL) as NoteKind[]
  const { backlinks, links: outgoing, ghosts } = neighbourhood
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        {onBack && (
          <Button size="icon" variant="ghost" title="Back to the previous note" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
        )}
        <Input
          value={title}
          onChange={(e) => { setTitle(e.target.value); queue({ title: e.target.value }) }}
          placeholder="Title"
          className="border-0 px-0 text-xl font-semibold shadow-none focus-visible:ring-0"
        />
        <Button size="icon" variant="ghost" title={reading ? "Edit" : "Read (links clickable)"} onClick={() => setReading(!reading)}>
          {reading ? <Pencil className="size-4" /> : <Eye className="size-4" />}
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
      {reading ? (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border p-3">
          <Markdown text={body || "_Nothing here yet._"} notes={links} />
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <Textarea
            ref={area}
            value={body}
            onChange={(e) => { setBody(e.target.value); queue({ body: e.target.value }); track(e.target.value, e.target.selectionStart) }}
            onKeyDown={onKey}
            aria-expanded={!!suggest}
            onClick={(e) => track(body, e.currentTarget.selectionStart)}
            onBlur={() => setTimeout(() => setSuggest(null), 150)}
            placeholder="Write in markdown — # headings, - lists, **bold**. Type [[ to link another note, #tag to group notes."
            className="min-h-0 flex-1 resize-none font-mono text-sm"
          />
          {suggest && (
            <div className="absolute bottom-2 left-2 z-10 w-72 rounded-md border border-border bg-popover p-1 shadow-md">
              <div className="px-2 pb-1 text-[11px] text-muted-foreground">Link to a note — ↑↓ then Enter</div>
              {suggest.items.map((t, i) => (
                <button
                  key={t}
                  onMouseDown={(e) => { e.preventDefault(); pickSuggestion(t) }}
                  className={cn("block w-full truncate rounded px-2 py-1 text-left text-sm", i === suggest.sel && "bg-accent")}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {(backlinks.length > 0 || outgoing.length > 0 || ghosts.length > 0) && (
        <div className="max-h-48 shrink-0 overflow-y-auto rounded-md border border-border p-2 text-sm">
          {backlinks.length > 0 && (
            <>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Linked from {backlinks.length} note{backlinks.length === 1 ? "" : "s"}</div>
              {backlinks.map((b, i) => (
                <button key={i} onClick={() => onOpen(b.source)} className="block w-full rounded px-1 py-0.5 text-left hover:bg-accent">
                  <span className="font-medium">{b.title || "Untitled"}</span>
                  <span className="ml-2 truncate text-xs text-muted-foreground">{b.context}</span>
                </button>
              ))}
            </>
          )}
          {(outgoing.length > 0 || ghosts.length > 0) && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="text-xs text-muted-foreground">Links to</span>
              {outgoing.map((l, i) => (
                <button key={i} onClick={() => onOpen(l.target)} className="rounded-full bg-primary/10 px-2 text-xs text-primary hover:bg-primary/20">
                  {l.title || "Untitled"}{l.heading ? ` › ${l.heading}` : ""}
                </button>
              ))}
              {ghosts.map((g) => (
                <button key={g} onClick={() => links.onLink(g)} title="Not written yet — click to create"
                  className="rounded-full border border-dashed px-2 text-xs text-muted-foreground hover:bg-accent">
                  {g} +
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <NoteThread noteId={note.id} onCount={onReplies} />
    </div>
  )
}
