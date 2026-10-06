import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowBigDown, ArrowBigUp, Loader2, MessageSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Markdown } from "@/components/Markdown"
import { ActorName } from "@/components/ActorName"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { fmtAgo } from "@/lib/format"
import { formatActor } from "@/lib/board"
import { useStore } from "@/store"
import type { NoteComment, NoteCommentSort } from "@/lib/types"

const SORTS: { key: NoteCommentSort; label: string }[] = [
  { key: "best", label: "Best" }, { key: "new", label: "New" }, { key: "old", label: "Old" },
]

/**
 * NoteThread — the discussion under a note (viewer/discussion): sessions and
 * the owner reply in nested threads and vote so the best answer rises. The
 * server nests and sorts; a reply wakes the note's session and the parent's
 * author, so this view only renders and writes.
 */
export function NoteThread({ noteId, onCount }: { noteId: number; onCount?: (n: number) => void }) {
  const self = useStore((s) => s.authUser?.username)
  const [comments, setComments] = useState<NoteComment[]>([])
  const [count, setCount] = useState(0)
  const [sort, setSort] = useState<NoteCommentSort>("best")
  const [err, setErr] = useState("")
  const [loading, setLoading] = useState(true)
  const countTo = useRef(onCount)
  countTo.current = onCount

  const load = useCallback(async () => {
    try {
      const r = await api.orgNoteComments(noteId, sort)
      setComments(r.comments); setCount(r.count); setErr(""); countTo.current?.(r.count)
    } catch {
      setErr("Couldn't load the discussion.")
    } finally {
      setLoading(false)
    }
  }, [noteId, sort])
  useEffect(() => { load() }, [load])

  const post = async (body: string, parentId: number | null) => {
    await api.orgNoteComment({ note_id: noteId, body, parent_id: parentId })
    await load()
  }
  const vote = async (c: NoteComment, value: -1 | 1) => {
    await api.orgNoteVote(c.id, c.my_vote === value ? 0 : value)
    await load()
  }

  return (
    <section className="shrink-0 rounded-md border border-border p-2">
      <div className="mb-2 flex items-center gap-2 text-xs">
        <MessageSquare className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Discussion{count ? ` · ${count}` : ""}</span>
        <div className="ml-auto flex gap-1">
          {SORTS.map((s) => (
            <button key={s.key} onClick={() => setSort(s.key)}
              className={cn("rounded px-1.5 py-0.5", sort === s.key ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent")}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <Composer placeholder="Start or join the discussion — agents on this note are woken to reply." onSubmit={(b) => post(b, null)} />
      {loading ? <Loader2 className="mx-auto my-2 size-4 animate-spin text-muted-foreground" />
        : err ? <div className="py-2 text-xs text-destructive">{err} <button className="underline" onClick={load}>Try again</button></div>
        : comments.length === 0 ? <div className="py-2 text-xs text-muted-foreground">No replies yet.</div>
        : <ul className="mt-2 max-h-80 space-y-2 overflow-y-auto">
            {comments.map((c) => <Comment key={c.id} c={c} self={self} depth={0} onReply={post} onVote={vote} />)}
          </ul>}
    </section>
  )
}

function Comment({ c, self, depth, onReply, onVote }: {
  c: NoteComment; self?: string; depth: number
  onReply: (body: string, parentId: number) => Promise<void>
  onVote: (c: NoteComment, v: -1 | 1) => Promise<void>
}) {
  const who = formatActor(c.author, self)
  const [replying, setReplying] = useState(false)
  const own = who.kind === "you"
  return (
    <li className={cn(depth > 0 && "border-l-2 border-border pl-3")}>
      <div className="flex gap-2">
        <div className="flex flex-col items-center text-muted-foreground">
          <button disabled={own} title={own ? "You can't vote on your own reply" : "Agree"} onClick={() => onVote(c, 1)}
            className="disabled:opacity-30"><ArrowBigUp className={cn("size-4", c.my_vote === 1 && "fill-primary text-primary")} /></button>
          <span className={cn("text-xs tabular-nums", c.score > 0 && "text-primary", c.score < 0 && "text-destructive")}>{c.score}</span>
          <button disabled={own} title={own ? "You can't vote on your own reply" : "Disagree"} onClick={() => onVote(c, -1)}
            className="disabled:opacity-30"><ArrowBigDown className={cn("size-4", c.my_vote === -1 && "fill-destructive text-destructive")} /></button>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-xs">
            <ActorName {...who} />
            <span className="text-muted-foreground" title={new Date(c.created_at * 1000).toLocaleString()}>{fmtAgo(c.created_at)}</span>
          </div>
          <div className="text-sm"><Markdown text={c.body} /></div>
          <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setReplying(!replying)}>
            {replying ? "Cancel" : "Reply"}
          </button>
          {replying && <Composer autoFocus placeholder={`Reply to ${who.kind === "you" ? "yourself" : who.name}`}
            onSubmit={async (b) => { await onReply(b, c.id); setReplying(false) }} />}
        </div>
      </div>
      {c.replies.length > 0 && (
        <ul className="mt-2 space-y-2">
          {c.replies.map((r) => <Comment key={r.id} c={r} self={self} depth={depth + 1} onReply={onReply} onVote={onVote} />)}
        </ul>
      )}
    </li>
  )
}

function Composer({ placeholder, autoFocus, onSubmit }: { placeholder: string; autoFocus?: boolean; onSubmit: (body: string) => Promise<void> }) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const send = async () => {
    if (!text.trim() || busy) return
    setBusy(true); setFailed(false)
    try { await onSubmit(text.trim()); setText("") } catch { setFailed(true) } finally { setBusy(false) }
  }
  return (
    <div className="mt-1 flex items-end gap-2">
      <Textarea value={text} autoFocus={autoFocus} rows={1} placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }}
        className="min-h-8 text-sm" />
      <Button size="sm" disabled={!text.trim() || busy} onClick={send} title="Post (⌘↵)">
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Post"}
      </Button>
      {failed && <span className="text-xs text-destructive">Not posted — try again</span>}
    </div>
  )
}
