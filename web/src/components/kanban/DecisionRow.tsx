import { HelpCircle, FileText, ShieldCheck, ShieldAlert, ClipboardList } from "lucide-react"
import { Badge } from "@/components/ui/badge"
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

/** One open decision as a single line: what it is, who waits, for how long.
 *  Shared by the board's DecisionsBand (every session) and the canvas pane's
 *  "Needs you" tab (one session — `inSession` drops the session name, it is the
 *  chat the owner is already in). */
export function DecisionRowContent({ d, inSession = false }: { d: OpenDecision; inSession?: boolean }) {
  const meta = KIND_META[d.kind] || KIND_META.question
  const Icon = meta.icon
  const isCard = d.kind === "card" && !!d.card
  return (
    <>
      <Icon className={cn("size-4 shrink-0", d.kind === "red" ? "text-destructive" : "text-muted-foreground")} />
      <span className="shrink-0 font-medium">
        {isCard || d.kind === "red" ? d.summary : inSession ? meta.label : d.label || d.session.slice(0, 8)}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {isCard
          ? `${d.column} · ${d.label || "an agent"} is waiting on you`
          : d.kind === "red"
            ? `${d.label || d.requested_by || "an agent"} · why: ${d.reason || "no reason given"}`
            : d.summary || meta.label}
      </span>
      {!inSession && <Badge variant="outline" className="shrink-0 text-[10px]">{meta.label}</Badge>}
      {d.host !== "local" && <Badge variant="outline" className="shrink-0 text-[10px]">{d.host}</Badge>}
      <span className="shrink-0 text-xs text-muted-foreground">
        waiting {fmtDuration(d.waiting_s * 1000) || "now"}
      </span>
    </>
  )
}
