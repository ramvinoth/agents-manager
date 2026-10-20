import { useEffect, useState } from "react"
import { ChevronLeft, ChevronRight, Loader2, MessageSquareReply, NotebookPen, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Markdown } from "./Markdown"
import { MermaidDiagram } from "./MermaidDiagram"
import { api } from "@/lib/api"
import { replyDraft, splitSlides, type Canvas } from "@/lib/canvas"
import { sessionIdOf } from "@/store/helpers"
import { useStore } from "@/store"
import { cn } from "@/lib/utils"

/** The canvas pane: what the agent chose to SHOW, beside the chat. Tabs per
 *  canvas; the owner reads, replies about it, saves it as a note, or deletes it. */
export function CanvasPane() {
  const canvases = useStore((s) => s.canvases)
  const active = useStore((s) => s.canvasActive)
  const path = useStore((s) => s.currentSessionPath)
  const openCanvas = useStore((s) => s.openCanvas)
  const closeCanvas = useStore((s) => s.closeCanvas)
  const deleteCanvas = useStore((s) => s.deleteCanvas)
  const meta = canvases.find((c) => c.title === active) ?? null
  const [canvas, setCanvas] = useState<Canvas | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [slide, setSlide] = useState(0)
  const [status, setStatus] = useState<string | null>(null)

  // Refetch when the active canvas or its version changes (the agent updated it).
  useEffect(() => {
    const sid = sessionIdOf(path)
    if (!meta || !sid) return setCanvas(null)
    let alive = true
    setError(null)
    api.canvasRead(sid, meta.title).then(
      (c) => { if (alive) { setCanvas(c); setSlide(0) } },
      (e) => { if (alive) setError(String(e?.message || e)) }
    )
    return () => { alive = false }
  }, [path, meta?.title, meta?.version])

  const slides = canvas?.kind === "slides" ? splitSlides(canvas.content) : null
  const at = slides ? Math.min(slide, slides.length - 1) : 0

  function reply() {
    if (!canvas) return
    useStore.setState({ pendingDraft: replyDraft(canvas, slides ? { index: at, count: slides.length } : undefined) })
  }
  async function saveNote() {
    if (!canvas) return
    const body = canvas.kind === "mermaid" ? "```mermaid\n" + canvas.content + "\n```"
      : canvas.kind === "html" ? "```html\n" + canvas.content + "\n```"
      : canvas.content
    try {
      await api.orgCreateNote({ title: canvas.title, body, session: sessionIdOf(path) })
      setStatus("Saved to notes")
    } catch (e: any) {
      setStatus("Couldn't save: " + (e?.message || e))
    }
    setTimeout(() => setStatus(null), 3000)
  }
  async function remove() {
    if (!meta || !window.confirm(`Delete the canvas "${meta.title}"? The agent can show it again, but this copy is gone.`)) return
    await deleteCanvas(meta.title).catch((e) => setStatus("Couldn't delete: " + (e?.message || e)))
  }

  const dark = document.documentElement.classList.contains("dark")
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist" aria-label="Canvases">
          {canvases.map((c) => (
            <button
              key={c.title}
              role="tab"
              aria-selected={c.title === active}
              onClick={() => openCanvas(c.title)}
              className={cn(
                "max-w-48 shrink-0 truncate rounded-md px-2 py-1 text-xs",
                c.title === active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50"
              )}
              title={`${c.title} · v${c.version}`}
            >
              {c.title}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon" className="size-7" onClick={closeCanvas} aria-label="Close canvas" title="Close canvas">
          <X className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4 text-sm text-destructive">Couldn't load this canvas: {error}</div>
        ) : !canvas || canvas.title !== meta?.title ? (
          <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : canvas.kind === "html" ? (
          // No allow-same-origin: the agent's HTML runs scripts but can't reach this app's cookies or API.
          <iframe title={canvas.title} sandbox="allow-scripts" srcDoc={canvas.content} className="size-full min-h-96 border-0 bg-white" />
        ) : canvas.kind === "mermaid" ? (
          <div className="p-4"><MermaidDiagram source={canvas.content} dark={dark} /></div>
        ) : (
          <div className="p-4"><Markdown text={slides ? slides[at] : canvas.content} /></div>
        )}
      </div>

      <div className="flex items-center gap-1 border-t border-border px-2 py-1.5 text-xs text-muted-foreground">
        {slides && slides.length > 1 && (
          <>
            <Button variant="ghost" size="icon" className="size-7" disabled={at === 0} onClick={() => setSlide(at - 1)} aria-label="Previous slide">
              <ChevronLeft className="size-4" />
            </Button>
            <span className="tabular-nums">{at + 1} / {slides.length}</span>
            <Button variant="ghost" size="icon" className="size-7" disabled={at === slides.length - 1} onClick={() => setSlide(at + 1)} aria-label="Next slide">
              <ChevronRight className="size-4" />
            </Button>
          </>
        )}
        <span className="min-w-0 flex-1 truncate">{status ?? (meta ? `v${meta.version}` : "")}</span>
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={reply} disabled={!canvas} data-track="canvas reply">
          <MessageSquareReply className="size-3.5" /> Reply
        </Button>
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={saveNote} disabled={!canvas} data-track="canvas save note">
          <NotebookPen className="size-3.5" /> Save as note
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={remove} disabled={!meta} aria-label="Delete canvas" title="Delete canvas">
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
