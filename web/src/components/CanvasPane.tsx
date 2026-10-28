import { useEffect, useState } from "react"
import { BellRing, Maximize2, Minimize2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DecisionCockpit } from "./kanban/DecisionCockpit"
import { DecisionRowContent } from "./kanban/DecisionRow"
import { fmtAgo } from "@/lib/format"
import { useStore } from "@/store"
import { cn } from "@/lib/utils"
import type { OpenDecision } from "@/lib/types"
import { callSaid, type FoundCall } from "@/lib/decisionAnchors"

/** Scroll the chat to the turn that raised d: "shown", "missing", or the far-back call it found. */
type ShowInChat = (d: OpenDecision) => Promise<"shown" | "missing" | FoundCall>

/** "Needs you": this chat's open decisions, each linked to the turn that raised it.
 *  Show in chat scrolls the transcript there (like an excerpt card jumping to its
 *  passage); Decide opens the cockpit — the one place a decision is made. */
function NeedsList({ needs, onShowInChat }: { needs: OpenDecision[]; onShowInChat: ShowInChat }) {
  const loadNeeds = useStore((s) => s.loadNeeds)
  // The cockpit walks a frozen copy, so the 30s poll never moves the item being read.
  const [cockpit, setCockpit] = useState<{ snapshot: OpenDecision[]; at: number } | null>(null)
  // Why Show in chat could not scroll: not in this chat at all, or too far up to page in.
  const [miss, setMiss] = useState<{ key: string; far?: FoundCall } | null>(null)
  // A long chat pages its history in to find the turn — seconds, so say so.
  const [finding, setFinding] = useState<string | null>(null)

  async function show(d: OpenDecision, key: string) {
    setMiss(null)
    setFinding(key)
    try {
      const r = await onShowInChat(d)
      if (r !== "shown") setMiss({ key, far: r === "missing" ? undefined : r })
    } finally {
      setFinding(null)
    }
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
      <div className="mb-2 flex items-center gap-2 px-1">
        <h2 className="text-base font-semibold">Needs you</h2>
        <span className="text-xs text-muted-foreground">
          {needs.length} open in this chat — the agent waits on these
        </span>
        <Button size="sm" className="ml-auto h-7 px-2 text-xs" data-track="needs decide all"
          onClick={() => setCockpit({ snapshot: needs, at: 0 })}>
          Decide {needs.length > 1 ? `all ${needs.length}` : ""} ›
        </Button>
      </div>
      <ul className="space-y-1">
        {needs.map((d, i) => {
          const key = `${d.kind}:${d.tool_use_id || d.id || d.card}`
          return (
            <li key={key} className="rounded-md border border-border">
              <div className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm">
                <DecisionRowContent d={d} inSession />
              </div>
              <div className="flex items-center gap-1 border-t border-border px-1 py-1">
                <Button variant="ghost" size="sm" className="h-7 text-xs" data-track="needs show in chat"
                  disabled={finding !== null} onClick={() => show(d, key)}>
                  {finding === key ? "Finding in history…" : "Show in chat"}
                </Button>
                <Button size="sm" className="h-7 text-xs" data-track="needs decide"
                  onClick={() => setCockpit({ snapshot: needs, at: i })}>
                  Decide
                </Button>
              </div>
              {miss?.key === key && (
                <p className="line-clamp-4 border-t border-border px-2 py-1.5 text-xs text-muted-foreground" role="status">
                  {miss.far
                    ? <>Raised {miss.far.timestamp ? fmtAgo(Date.parse(miss.far.timestamp) / 1000) : "earlier"} in this chat — too far back to scroll to. It said: <span className="text-foreground">“{callSaid(miss.far)}”</span></>
                    : "Not in this chat's history — it was raised outside the chat (e.g. on the board)."}
                </p>
              )}
            </li>
          )
        })}
      </ul>
      {cockpit && (
        <DecisionCockpit
          decisions={cockpit.snapshot}
          startIndex={cockpit.at}
          onClose={() => setCockpit(null)}
          onResolved={loadNeeds}
        />
      )}
    </div>
  )
}

/** The side pane beside the chat: this chat's open decisions ("Needs you").
 *  What an agent SHOWS lives on the project canvas as doc tiles, not here. */
export function CanvasPane({ onShowInChat }: { onShowInChat: ShowInChat }) {
  const closeCanvas = useStore((s) => s.closeCanvas)
  const needs = useStore((s) => s.canvasNeeds)
  const [full, setFull] = useState(false)

  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [full])

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", full && "fixed inset-0 z-50")}>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-xs font-medium text-primary">
          <BellRing className="size-3.5 shrink-0" /> Needs you ({needs.length})
        </span>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => setFull(!full)}
          aria-label={full ? "Exit full screen" : "Full screen"} title={full ? "Exit full screen (Esc)" : "Full screen"}>
          {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => { setFull(false); closeCanvas() }} aria-label="Close" title="Close">
          <X className="size-4" />
        </Button>
      </div>
      {needs.length
        ? <NeedsList needs={needs} onShowInChat={onShowInChat} />
        : <p className="p-4 text-sm text-muted-foreground">Nothing in this chat is waiting on you.</p>}
    </div>
  )
}
