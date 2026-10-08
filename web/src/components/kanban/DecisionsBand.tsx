import { useCallback, useEffect, useState } from "react"
import { HelpCircle, FileText, ShieldCheck, ShieldAlert, ClipboardList, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { api } from "@/lib/api"
import { fmtDuration } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { OpenDecision } from "@/lib/types"

const KIND_META = {
  question: { icon: HelpCircle, label: "Question" },
  plan: { icon: FileText, label: "Plan" },
  approval: { icon: ShieldCheck, label: "Approval" },
  card: { icon: ClipboardList, label: "Card" },
  red: { icon: ShieldAlert, label: "Needs your OK" },
} as const

/**
 * DecisionsBand — the cross-session decision queue on the board (card #60):
 * every open durable question, plan, live tool approval and board card parked
 * in Review/Needs-info, oldest first, with a total count. A READ surface — it
 * lists, it never decides: opening an item goes to the session that owns the
 * decision (its thread renders the actual decision card), or to the card
 * itself when the card is the decision. The one exception is an org (Red)
 * approval: it has no thread to open, so its row carries Deny/Approve and the
 * plain risk inline — the decision is made where it is read. The queue is one read of the existing sources
 * (/api/decisions/open), no parallel store. A viewer that predates the route
 * (404, e.g. before a restart) makes the band hide itself entirely; other
 * failures show inline.
 */
export function DecisionsBand({
  onOpenSession,
  onOpenCard,
}: {
  onOpenSession?: (d: OpenDecision) => boolean
  onOpenCard?: (id: number) => boolean
}) {
  const [items, setItems] = useState<OpenDecision[] | null>(null)
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [deciding, setDeciding] = useState("")

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await api.openDecisions()
      setItems(r.decisions || [])
      setErr("")
      setHidden(false)
    } catch (ex: any) {
      // A 404 means this viewer predates the queue route (a restart is pending):
      // hide the band entirely rather than error on every board. Anything else
      // (network, 5xx) is a real failure worth showing.
      if (ex?.status === 404) {
        setItems(null)
        setHidden(true)
        setErr("")
        return
      }
      setErr(String(ex?.message || ex))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  /** Approve or deny an org approval. A 404 means someone already decided
   *  it — the reload drops it; a 403 (you raised it) shows its reason. */
  const resolve = async (d: OpenDecision, resolution: "approved" | "denied") => {
    setDeciding(d.id || "")
    try {
      const r = await api.orgResolveApproval(Number(d.id), resolution)
      setErr(r.result?.error ? `Approved, but it failed: ${r.result.error}` : "")
    } catch (ex: any) {
      if (ex?.status !== 404) setErr(String(ex?.message || ex))
    } finally {
      setDeciding("")
      load()
    }
  }

  if (hidden) return null

  return (
    <div className="border-b border-border px-4 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Decisions</span>
        <Badge variant="secondary" className="text-[10px]">{items ? items.length : "…"}</Badge>
        <Button variant="ghost" size="icon" className="size-6" onClick={load} title="Refresh the queue">
          <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
        </Button>
        {err && <span className="text-[11px] text-destructive">{err}</span>}
      </div>
      {!items ? (
        <div className="text-xs text-muted-foreground">Loading open decisions…</div>
      ) : items.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No open decisions — a session's question, plan or tool approval shows up here while it waits.
        </div>
      ) : (
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {items.map((d) => {
            const meta = KIND_META[d.kind] || KIND_META.question
            const Icon = meta.icon
            const isCard = d.kind === "card" && !!d.card
            const open = isCard
              ? onOpenCard && (() => onOpenCard(d.card!))
              : d.session && onOpenSession ? () => onOpenSession(d) : undefined
            return (
              <li key={`${d.kind}:${d.session}:${d.tool_use_id || d.id || d.card}`}>
                <div className="flex items-center gap-1">
                  <button
                    data-track="decision row"
                    disabled={!open}
                    onClick={open || undefined}
                    title={d.kind === "red" ? `${d.summary}\nIf you approve: ${d.risk || ""}\nAsked by: ${d.label || d.requested_by || "an agent"}` : undefined}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent disabled:cursor-default"
                  >
                    <Icon className={cn("size-4 shrink-0", d.kind === "red" ? "text-destructive" : "text-muted-foreground")} />
                    <span className="shrink-0 font-medium">
                      {isCard || d.kind === "red" ? d.summary : d.label || d.session.slice(0, 8)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {isCard
                        ? `${d.column} · ${d.label || "an agent"} is waiting on you`
                        : d.kind === "red"
                          ? `If you approve: ${d.risk || "it runs"}`
                          : d.summary || meta.label}
                    </span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">{meta.label}</Badge>
                    {d.host !== "local" && <Badge variant="outline" className="shrink-0 text-[10px]">{d.host}</Badge>}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      waiting {fmtDuration(d.waiting_s * 1000) || "now"}
                    </span>
                  </button>
                  {d.kind === "red" && (
                    <>
                      <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={!!deciding}
                        data-track="red deny" onClick={() => resolve(d, "denied")}>Deny</Button>
                      <Button size="sm" variant="destructive" className="h-6 px-2 text-xs" disabled={!!deciding}
                        data-track="red approve" onClick={() => resolve(d, "approved")}>Approve</Button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
