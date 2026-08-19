import { useState } from "react"
import { Loader2, Plus, Repeat, Trash2, Pencil, ChevronLeft } from "lucide-react"
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
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { fmtInterval, parseInterval } from "@/lib/format"
import { useStore } from "@/store"
import type { Loop } from "@/lib/types"

type Draft = { id: string; prompt: string; interval: string }

/**
 * The Loops manager modal: list every scheduled loop for this session with
 * add / edit / delete. Add and edit share ONE inline form (new = no id → create,
 * existing = id → edit, preserving the loop's run-count and schedule server-side).
 */
export function LoopsDialog({ onClose }: { onClose: () => void }) {
  const loops = useStore((s) => s.loops)
  const createLoop = useStore((s) => s.createLoop)
  const editLoop = useStore((s) => s.editLoop)
  const deleteLoop = useStore((s) => s.deleteLoop)

  const [editing, setEditing] = useState<Draft | null>(null) // null = list; Draft = form
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  function openForm(l?: Loop) {
    setEditing(
      l
        ? { id: l.id, prompt: l.prompt, interval: fmtInterval(l.interval) }
        : { id: "", prompt: "", interval: "1h" }
    )
  }

  async function save() {
    if (!editing) return
    const prompt = editing.prompt.trim()
    const interval = parseInterval(editing.interval)
    if (!prompt || !interval) return
    setSaving(true)
    try {
      if (editing.id) await editLoop(editing.id, prompt, interval, "")
      else await createLoop(prompt, interval, "")
      setEditing(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Loops</DialogTitle>
          <DialogDescription>Automatically re-run a prompt on a schedule for this session.</DialogDescription>
        </DialogHeader>

        {!editing ? (
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {loops.length === 0 && (
              <p className="px-1 text-xs italic text-muted-foreground">No loops yet.</p>
            )}
            {loops.map((l) => (
              <div key={l.id} className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2">
                <Repeat className="size-4 shrink-0 text-muted-foreground" />
                <button className="min-w-0 flex-1 text-left" onClick={() => openForm(l)} title="Edit">
                  <div className="truncate text-sm" title={l.prompt}>{l.prompt}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Badge variant="outline" className="px-1.5 text-[10px] font-normal tabular-nums">
                      {fmtInterval(l.interval)}
                    </Badge>
                    <span className="tabular-nums">{l.runs || 0} run{(l.runs || 0) === 1 ? "" : "s"}</span>
                  </div>
                </button>
                {confirmDelete === l.id ? (
                  <>
                    <Button variant="destructive" size="sm" className="h-7" onClick={() => { deleteLoop(l.id); setConfirmDelete(null) }}>
                      Delete
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7" onClick={() => setConfirmDelete(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="ghost" size="icon" className="size-7" onClick={() => openForm(l)} title="Edit">
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-destructive hover:text-destructive"
                      onClick={() => setConfirmDelete(l.id)}
                      title="Delete"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                )}
              </div>
            ))}
            <Button variant="outline" size="sm" className="mt-1 self-start gap-1" onClick={() => openForm()}>
              <Plus className="size-3.5" /> Add loop
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <button className="hover:text-foreground" onClick={() => setEditing(null)} title="Back to list">
                <ChevronLeft className="size-4" />
              </button>
              {editing.id ? "Edit loop" : "New loop"}
            </div>
            <Textarea
              autoFocus
              value={editing.prompt}
              onChange={(e) => setEditing((d) => (d ? { ...d, prompt: e.target.value } : d))}
              placeholder="Prompt to run on a schedule…"
              className="min-h-24 resize-none text-sm leading-relaxed"
            />
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-[11px] text-muted-foreground">Runs every</span>
              <Input
                value={editing.interval}
                onChange={(e) => setEditing((d) => (d ? { ...d, interval: e.target.value } : d))}
                placeholder="1h"
                className="h-8 w-16 px-2 text-center text-xs tabular-nums"
                title="Interval — e.g. 30s, 5m, 1h"
              />
              <Button
                size="sm"
                className="ml-auto h-8"
                disabled={!editing.prompt.trim() || !parseInterval(editing.interval) || saving}
                onClick={save}
              >
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
              </Button>
              <Button variant="ghost" size="sm" className="h-8" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
