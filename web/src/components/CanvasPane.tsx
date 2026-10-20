import { useEffect, useRef, useState } from "react"
import {
  AppWindow, ChevronLeft, ChevronRight, FileText, Loader2, Maximize2, MessageSquareReply, Minimize2,
  NotebookPen, Presentation, Trash2, Workflow, X, type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Markdown } from "./Markdown"
import { MermaidDiagram } from "./MermaidDiagram"
import { api } from "@/lib/api"
import { KIND_LABEL, replyDraft, splitSlides, themedHtml, type Canvas, type CanvasKind } from "@/lib/canvas"
import { fmtAgo } from "@/lib/format"
import { sessionIdOf } from "@/store/helpers"
import { useStore } from "@/store"
import { cn } from "@/lib/utils"

const KIND_ICON: Record<CanvasKind, LucideIcon> = {
  markdown: FileText,
  mermaid: Workflow,
  html: AppWindow,
  slides: Presentation,
}

/** Arrow keys turn slides unless the owner is typing somewhere. */
function typingIn(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null
  return !!e && (e.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.tagName))
}

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
  const [full, setFull] = useState(false)
  const shownTitle = useRef<string | null>(null)

  // Refetch when the active canvas or its version changes (the agent updated it).
  useEffect(() => {
    const sid = sessionIdOf(path)
    if (!meta || !sid) return setCanvas(null)
    let alive = true
    setError(null)
    api.canvasRead(sid, meta.title).then(
      // A revision keeps the reader's slide; a different canvas starts at the top.
      (c) => {
        if (!alive) return
        if (shownTitle.current !== c.title) setSlide(0)
        shownTitle.current = c.title
        setCanvas(c)
      },
      (e) => { if (alive) setError(String(e?.message || e)) }
    )
    return () => { alive = false }
  }, [path, meta?.title, meta?.version])

  const slides = canvas?.kind === "slides" ? splitSlides(canvas.content) : null
  const at = slides ? Math.min(slide, slides.length - 1) : 0
  const count = slides?.length ?? 0

  useEffect(() => {
    if (count < 2 && !full) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && full) return setFull(false)
      if (count < 2 || typingIn(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "ArrowRight") setSlide((n) => Math.min(n + 1, count - 1))
      else if (e.key === "ArrowLeft") setSlide((n) => Math.max(n - 1, 0))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [count, full])

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
  const body = getComputedStyle(document.body)
  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", full && "fixed inset-0 z-50")}>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto scrollbar-none" role="tablist" aria-label="Canvases">
          {canvases.map((c) => {
            const TabIcon = KIND_ICON[c.kind]
            return (
              <button
                key={c.title}
                role="tab"
                aria-selected={c.title === active}
                onClick={() => openCanvas(c.title)}
                className={cn(
                  "flex max-w-52 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs",
                  c.title === active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                title={`${c.title} · ${KIND_LABEL[c.kind]} · v${c.version} · updated ${fmtAgo(c.updated_at)}`}
              >
                <TabIcon className="size-3.5 shrink-0" />
                <span className="truncate">{c.title}</span>
              </button>
            )
          })}
        </div>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => setFull(!full)}
          aria-label={full ? "Exit full screen" : "Full screen"} title={full ? "Exit full screen (Esc)" : "Full screen"}>
          {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => { setFull(false); closeCanvas() }} aria-label="Close canvas" title="Close canvas">
          <X className="size-4" />
        </Button>
      </div>

      {meta && (
        <div className="flex items-baseline gap-2 px-4 pb-1 pt-3">
          <h2 className="min-w-0 truncate text-base font-semibold">{meta.title}</h2>
          <span className="shrink-0 text-xs text-muted-foreground">
            {KIND_LABEL[meta.kind]} · v{meta.version} · {fmtAgo(meta.updated_at)}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4 text-sm text-destructive">Couldn't load this canvas: {error}</div>
        ) : !canvas || canvas.title !== meta?.title ? (
          <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : canvas.kind === "html" ? (
          // No allow-same-origin: the agent's HTML runs scripts but can't reach this app's cookies or API.
          <iframe
            title={canvas.title}
            sandbox="allow-scripts"
            srcDoc={themedHtml(canvas.content, { bg: body.backgroundColor, fg: body.color, dark })}
            className="size-full min-h-96 border-0"
          />
        ) : canvas.kind === "mermaid" ? (
          <div className="canvas-diagram p-4"><MermaidDiagram source={canvas.content} dark={dark} /></div>
        ) : slides ? (
          // One slide at a time, centred and a step larger than chat text.
          <div className="canvas-slide flex min-h-full flex-col justify-center px-10 py-8">
            <Markdown text={slides[at]} />
          </div>
        ) : (
          <div className="mx-auto max-w-3xl px-4 py-2"><Markdown text={canvas.content} /></div>
        )}
      </div>

      <div className="flex items-center gap-1 border-t border-border px-2 py-1.5 text-xs text-muted-foreground">
        {slides && slides.length > 1 && (
          <>
            <Button variant="ghost" size="icon" className="size-7" disabled={at === 0} onClick={() => setSlide(at - 1)} aria-label="Previous slide">
              <ChevronLeft className="size-4" />
            </Button>
            <span className="flex items-center gap-1" aria-label={`Slide ${at + 1} of ${slides.length}`}>
              {slides.length <= 12
                ? slides.map((_, i) => (
                    <button key={i} onClick={() => setSlide(i)} aria-label={`Slide ${i + 1}`}
                      className={cn("size-1.5 rounded-full", i === at ? "bg-foreground" : "bg-muted-foreground/40 hover:bg-muted-foreground")} />
                  ))
                : <span className="tabular-nums">{at + 1} / {slides.length}</span>}
            </span>
            <Button variant="ghost" size="icon" className="size-7" disabled={at === slides.length - 1} onClick={() => setSlide(at + 1)} aria-label="Next slide">
              <ChevronRight className="size-4" />
            </Button>
          </>
        )}
        <span className="min-w-0 flex-1 truncate" role="status">{status ?? ""}</span>
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
