import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { centered, fitView, wheelFactor, zoomAt, type Size, type View } from "@/lib/zoom"

/** What the viewer shows: a rendered SVG string (a Mermaid diagram) or an image URL (a screenshot). */
export type ZoomSource = { svg: string } | { src: string; alt?: string }

/**
 * Full-screen pan/zoom viewer for one diagram or image.
 * Wheel / trackpad pinch / two-finger pinch zoom at the pointer, drag pans,
 * double-click zooms in, + − 0 keys and the toolbar buttons do the same.
 * The maths lives in lib/zoom; this only translates events into it.
 */
export function ZoomViewer({ source, open, onOpenChange }: { source: ZoomSource; open: boolean; onOpenChange: (o: boolean) => void }) {
  const isSvg = "svg" in source
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[100dvh] w-screen max-w-none flex-col gap-0 rounded-none p-0 sm:max-w-none"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{isSvg ? "Diagram" : "Image"}</DialogTitle>
        <DialogDescription className="sr-only">Zoom with the wheel or a pinch, drag to pan.</DialogDescription>
        {open && <Stage source={source} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function Stage({ source, onClose }: { source: ZoomSource; onClose: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [content, setContent] = useState<Size>({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 })
  const pointers = useRef(new Map<number, { x: number; y: number }>())

  const box = (): Size => {
    const r = boxRef.current?.getBoundingClientRect()
    return { w: r?.width ?? 0, h: r?.height ?? 0 }
  }
  const place = useCallback((size: Size) => {
    setContent(size)
    setView(fitView(size, box()))
  }, [])
  // Natural size: an SVG's viewBox (text renders at its real size at 100%), or an
  // image's pixel size once it has decoded (onLoad below).
  const svg = "svg" in source ? source.svg : null
  useLayoutEffect(() => {
    if (svg == null) return
    const el = boxRef.current?.querySelector("svg")
    const vb = el?.viewBox?.baseVal
    place(vb && vb.width > 0 ? { w: vb.width, h: vb.height } : { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 })
  }, [svg, place])

  const zoomBy = useCallback((factor: number, px?: number, py?: number) => {
    const b = box()
    setView((v) => zoomAt(v, factor, px ?? b.w / 2, py ?? b.h / 2))
  }, [])
  const fit = () => setView(fitView(content, box()))
  const actual = () => setView(centered(content, box(), 1))

  // React's onWheel is passive and cannot stop the page from scrolling; bind natively.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomBy(wheelFactor(e.deltaY, e.ctrlKey), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [zoomBy])

  const local = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, local(e))
    // Capture keeps a drag alive outside the stage; it is a nicety, never a precondition.
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const ps = pointers.current
    const prev = ps.get(e.pointerId)
    if (!prev) return
    const cur = local(e)
    if (ps.size === 1) {
      setView((v) => ({ ...v, x: v.x + cur.x - prev.x, y: v.y + cur.y - prev.y }))
    } else if (ps.size === 2) {
      const other = [...ps.entries()].find(([id]) => id !== e.pointerId)![1]
      const before = Math.hypot(prev.x - other.x, prev.y - other.y)
      const after = Math.hypot(cur.x - other.x, cur.y - other.y)
      if (before > 0) {
        const mx = (cur.x + other.x) / 2, my = (cur.y + other.y) / 2
        const pmx = (prev.x + other.x) / 2, pmy = (prev.y + other.y) / 2
        setView((v) => {
          const z = zoomAt(v, after / before, mx, my)
          return { ...z, x: z.x + mx - pmx, y: z.y + my - pmy }
        })
      }
    }
    ps.set(e.pointerId, cur)
  }
  const onPointerUp = (e: React.PointerEvent) => { pointers.current.delete(e.pointerId) }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") zoomBy(1.25)
    else if (e.key === "-") zoomBy(0.8)
    else if (e.key === "0") fit()
    else return
    e.preventDefault()
  }

  const style = {
    width: content.w || undefined,
    height: content.h || undefined,
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
  }

  return (
    <div className="zoom-viewer" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="zoom-viewer-bar">
        <span className="zoom-viewer-pct" aria-live="polite">{Math.round(view.scale * 100)}%</span>
        <button type="button" onClick={() => zoomBy(0.8)} title="Zoom out (−)" aria-label="Zoom out">−</button>
        <button type="button" onClick={() => zoomBy(1.25)} title="Zoom in (+)" aria-label="Zoom in">+</button>
        <button type="button" onClick={fit} title="Fit to screen (0)">Fit</button>
        <button type="button" onClick={actual} title="Actual size">100%</button>
        <button type="button" onClick={onClose} title="Close (Esc)" className="zoom-viewer-close">Close</button>
      </div>
      <div
        ref={boxRef}
        className="zoom-viewer-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => { const p = local(e); zoomBy(2, p.x, p.y) }}
      >
        {svg != null ? (
          <div
            className="zoom-viewer-content"
            style={style}
            // Same strict-mode mermaid SVG the inline diagram already shows.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="zoom-viewer-content" style={style}>
            <img
              src={"src" in source ? source.src : ""}
              alt={"alt" in source ? source.alt : ""}
              draggable={false}
              // Past 2x a screenshot is inspected pixel by pixel; smoothing would blur it.
              style={{ imageRendering: view.scale >= 2 ? "pixelated" : "auto" }}
              onLoad={(e) => place({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            />
          </div>
        )}
      </div>
    </div>
  )
}
