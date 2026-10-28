import { useEffect, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Markdown } from "../Markdown"
import { MermaidDiagram } from "../MermaidDiagram"
import { splitSlides, themedHtml, type CanvasKind } from "@/lib/canvas"
import { cn } from "@/lib/utils"

/** Arrow keys turn slides unless the owner is typing somewhere. */
function typingIn(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null
  return !!e && (e.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.tagName))
}

/** One doc an agent showed (a canvas doc tile): markdown, a mermaid diagram,
 *  sandboxed HTML, or slides. `keys` lets the arrow keys turn slides — only the
 *  expanded view takes them, so a tile on the board never steals the keyboard. */
export function DocView({ kind, content, title, keys = false }: {
  kind: CanvasKind; content: string; title: string; keys?: boolean
}) {
  const [slide, setSlide] = useState(0)
  const slides = kind === "slides" ? splitSlides(content) : null
  const count = slides?.length ?? 0
  const at = Math.min(slide, Math.max(count - 1, 0))

  useEffect(() => {
    if (!keys || count < 2) return
    const onKey = (e: KeyboardEvent) => {
      if (typingIn(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "ArrowRight") setSlide((n) => Math.min(n + 1, count - 1))
      else if (e.key === "ArrowLeft") setSlide((n) => Math.max(n - 1, 0))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [keys, count])

  const dark = document.documentElement.classList.contains("dark")
  if (kind === "html") {
    const body = getComputedStyle(document.body)
    // No allow-same-origin: the agent's HTML runs scripts but can't reach this app's cookies or API.
    return <iframe title={title} sandbox="allow-scripts"
      srcDoc={themedHtml(content, { bg: body.backgroundColor, fg: body.color, dark })}
      className="size-full min-h-96 border-0" />
  }
  if (kind === "mermaid") return <div className="canvas-diagram p-4"><MermaidDiagram source={content} dark={dark} /></div>
  if (!slides) return <div className="mx-auto max-w-3xl px-4 py-2"><Markdown text={content} /></div>
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One slide at a time, centred and a step larger than chat text. */}
      <div className="canvas-slide flex min-h-0 flex-1 flex-col justify-center overflow-auto px-10 py-8">
        <Markdown text={slides[at]} />
      </div>
      {count > 1 && (
        <div className="flex items-center justify-center gap-1 border-t border-border px-2 py-1 text-xs text-muted-foreground">
          <Button variant="ghost" size="icon" className="size-7" disabled={at === 0} onClick={() => setSlide(at - 1)} aria-label="Previous slide">
            <ChevronLeft className="size-4" />
          </Button>
          <span className="flex items-center gap-1" aria-label={`Slide ${at + 1} of ${count}`}>
            {count <= 12
              ? slides.map((_, i) => (
                  <button key={i} onClick={() => setSlide(i)} aria-label={`Slide ${i + 1}`}
                    className={cn("size-1.5 rounded-full", i === at ? "bg-foreground" : "bg-muted-foreground/40 hover:bg-muted-foreground")} />
                ))
              : <span className="tabular-nums">{at + 1} / {count}</span>}
          </span>
          <Button variant="ghost" size="icon" className="size-7" disabled={at === count - 1} onClick={() => setSlide(at + 1)} aria-label="Next slide">
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
