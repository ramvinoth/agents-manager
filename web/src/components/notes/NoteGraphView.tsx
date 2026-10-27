import { useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react"
import { layoutGraph, type NoteGraph } from "@/lib/noteLinks"
import { cn } from "@/lib/utils"

const W = 1000, H = 700

/**
 * The project's notes as a connected graph (Obsidian's graph view): one dot
 * per note sized by how connected it is, a line per [[link]], hollow dots for
 * links to notes not written yet. Hover lights a note's neighbours; click
 * opens it (a hollow one is created). Drag to pan, wheel to zoom. Plain SVG
 * over the pure layout in lib/noteLinks — no graph library.
 */
export function NoteGraphView({ graph, openId, onOpen, onCreate }: {
  graph: NoteGraph
  openId: number | null
  onOpen: (id: number) => void
  onCreate: (title: string) => void
}) {
  const { nodes, links, pos } = useMemo(() => {
    const nodes = [
      ...graph.nodes.map((n) => ({ key: `n${n.id}`, label: n.title || "Untitled", id: n.id as number | null, archived: n.archived, pinned: n.pinned })),
      ...graph.ghosts.map((g) => ({ key: `g:${g.title.toLowerCase()}`, label: g.title, id: null, archived: false, pinned: false })),
    ]
    const links: [string, string][] = [
      ...graph.edges.filter((e) => e.source !== e.target).map((e) => [`n${e.source}`, `n${e.target}`] as [string, string]),
      ...graph.ghosts.flatMap((g) => g.from.map((f) => [`n${f}`, `g:${g.title.toLowerCase()}`] as [string, string])),
    ]
    const pos = new Map(layoutGraph(nodes.map((n) => n.key), links).map((p) => [p.key, p]))
    return { nodes, links, pos }
  }, [graph])
  const [hover, setHover] = useState<string | null>(openId != null ? `n${openId}` : null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  const near = useMemo(() => {
    if (!hover) return null
    const s = new Set([hover])
    for (const [a, b] of links) { if (a === hover) s.add(b); if (b === hover) s.add(a) }
    return s
  }, [hover, links])

  if (!nodes.length)
    return <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      No notes yet. Link one note to another by typing [[ and its title — the graph grows from those links.
    </div>

  const px = (x: number) => W / 2 + x * (W / 2 - 60)
  const py = (y: number) => H / 2 + y * (H / 2 - 40)
  const r = (deg: number) => 5 + Math.min(10, Math.sqrt(deg) * 2.5)

  function onWheel(e: WheelEvent) {
    const k = Math.min(4, Math.max(0.4, view.k * (e.deltaY < 0 ? 1.1 : 0.9)))
    setView((v) => ({ ...v, k }))
  }
  function onDown(e: PointerEvent) { drag.current = { x: e.clientX, y: e.clientY, moved: false } }
  function onMove(e: PointerEvent) {
    const d = drag.current
    if (!d || !(e.buttons & 1)) return
    const dx = e.clientX - d.x, dy = e.clientY - d.y
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    d.x = e.clientX; d.y = e.clientY
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
  }
  function pick(n: (typeof nodes)[number]) {
    if (drag.current?.moved) return
    if (n.id != null) onOpen(n.id)
    else onCreate(n.label)
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-muted/20">
      <svg
        viewBox={`0 0 ${W} ${H}`} className="size-full cursor-grab select-none active:cursor-grabbing"
        onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => setTimeout(() => (drag.current = null))}
      >
        <g transform={`translate(${view.x} ${view.y}) translate(${W / 2} ${H / 2}) scale(${view.k}) translate(${-W / 2} ${-H / 2})`}>
          {links.map(([a, b], i) => {
            const p = pos.get(a), q = pos.get(b)
            if (!p || !q) return null
            const lit = near && near.has(a) && near.has(b) && (a === hover || b === hover)
            return <line key={i} x1={px(p.x)} y1={py(p.y)} x2={px(q.x)} y2={py(q.y)}
              className={cn("stroke-muted-foreground", lit ? "opacity-90" : near ? "opacity-10" : "opacity-35")} strokeWidth={lit ? 1.6 : 1} />
          })}
          {nodes.map((n) => {
            const p = pos.get(n.key)!
            const dim = near && !near.has(n.key)
            const open = n.id != null && n.id === openId
            return (
              <g key={n.key} transform={`translate(${px(p.x)} ${py(p.y)})`} className={cn("cursor-pointer", dim && "opacity-20")}
                onPointerEnter={() => setHover(n.key)} onPointerLeave={() => setHover(null)} onClick={() => pick(n)}>
                <title>{n.id == null ? `${n.label} — not written yet, click to create` : n.label}</title>
                <circle r={r(p.degree)} strokeWidth={1.5}
                  className={cn(n.id == null ? "fill-background stroke-muted-foreground [stroke-dasharray:3_2]"
                    : open ? "fill-primary stroke-primary" : n.archived ? "fill-muted-foreground/40 stroke-transparent"
                    : "fill-primary/60 stroke-transparent")} />
                <text y={r(p.degree) + 13} textAnchor="middle"
                  className={cn("fill-foreground text-[12px]", n.id == null && "fill-muted-foreground italic", (open || n.key === hover) && "font-semibold")}>
                  {n.label.length > 28 ? n.label.slice(0, 27) + "…" : n.label}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
      <div className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-muted-foreground">
        {graph.nodes.length} notes · {graph.edges.length} links{graph.ghosts.length ? ` · ${graph.ghosts.length} not written yet` : ""} — drag to move, scroll to zoom
      </div>
    </div>
  )
}
