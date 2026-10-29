import { useEffect, useState } from "react"
import { Loader2, Maximize2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { userError } from "@/lib/errors"
import type { CanvasKind } from "@/lib/canvas"
import { DocView } from "./DocView"

/** What the server stamps on a doc tile (viewer canvas_show): the content lives
 *  as a canvas file, so the board itself stays small. */
export type DocMeta = { title: string; kind: CanvasKind; file: string; session?: string }

/** Doc tiles carry this link; Excalidraw renders only embeddables it validates. */
export const DOC_LINK = "harman://doc/"
export const isDocLink = (link: string) => link.startsWith(DOC_LINK) || undefined

/** The doc's text, fetched once per file (a file id is its content hash, so it never goes stale). */
function useDocText(canvas: number, file: string) {
  const [state, setState] = useState<{ text?: string; err?: string }>({})
  useEffect(() => {
    let live = true
    setState({})
    fetch(api.canvasFileUrl(canvas, file))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((text) => live && setState({ text }))
      .catch((e) => live && setState({ err: userError(e, "this doc") }))
    return () => { live = false }
  }, [canvas, file])
  return state
}

function Body({ canvas, doc, keys }: { canvas: number; doc: DocMeta; keys?: boolean }) {
  const { text, err } = useDocText(canvas, doc.file)
  if (err) return <p className="p-3 text-sm text-muted-foreground">{err}</p>
  if (text == null) return <div className="flex h-full items-center justify-center"><Loader2 className="size-4 animate-spin" /></div>
  return <DocView kind={doc.kind} content={text} title={doc.title} keys={keys} />
}

/** A doc on the board: title bar plus the doc. Excalidraw lets pointers into it
 *  only once the tile is activated (clicked), so scrolling never fights panning. */
export function DocTile({ canvas, doc, by, onExpand }: { canvas: number; doc: DocMeta; by?: string; onExpand: () => void }) {
  return (
    <div className="flex size-full flex-col overflow-hidden bg-background text-foreground">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{doc.title}</span>
        {by && <span className="shrink-0 truncate text-[11px] text-muted-foreground" title={`Made by ${by}`}>by {by}</span>}
        <Button variant="ghost" size="icon" className="size-6" onClick={onExpand} aria-label="Expand" title="Expand">
          <Maximize2 className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto"><Body canvas={canvas} doc={doc} /></div>
    </div>
  )
}

/** The doc full size over the canvas; arrow keys turn slides here. */
export function DocExpanded({ canvas, doc, onClose }: { canvas: number; doc: DocMeta; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose() } }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background" role="dialog" aria-label={doc.title}>
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{doc.title}</span>
        <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto"><Body canvas={canvas} doc={doc} keys /></div>
    </div>
  )
}
