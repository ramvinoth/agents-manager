import { useCallback, useEffect, useState } from "react"
import { HelpCircle, FileText, ShieldCheck, ShieldAlert, ClipboardList, ChevronLeft, ChevronRight, Loader2, CheckCircle2, ExternalLink } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AuqBlock } from "@/components/AuqBlock"
import { PlanBlock } from "@/components/PlanBlock"
import { api } from "@/lib/api"
import { fmtDuration } from "@/lib/format"
import { firstOpen, stepDecision } from "@/lib/decisions"
import { SNOOZE_OPTIONS } from "@/lib/inbox"
import type { OpenDecision, ToolUseBlock } from "@/lib/types"
import { userError } from "@/lib/errors"

const KIND = {
  question: { icon: HelpCircle, label: "Question" },
  plan: { icon: FileText, label: "Plan approval" },
  approval: { icon: ShieldCheck, label: "Tool approval" },
  card: { icon: ClipboardList, label: "Card for you" },
  red: { icon: ShieldAlert, label: "Needs your OK" },
} as const

type Pending = { pending_question?: { tool_use_id: string; questions: unknown } | null; pending_plan?: { tool_use_id: string; plan: string } | null }

/** A POST that resolves on 2xx, treats 409/404 ("already decided elsewhere")
 *  as resolved too, and throws the server's words otherwise. */
async function decided(res: Response | Promise<Response>): Promise<void> {
  const r = await res
  if (r.ok || r.status === 409 || r.status === 404) return
  const d = await r.json().catch(() => ({}))
  throw new Error(d?.error || `HTTP ${r.status}`)
}

/**
 * DecisionCockpit (web) — the ONE place a decision is made, opened from the
 * board's Decisions band and from the Inbox (same contract as the mobile
 * cockpit). It walks a FROZEN snapshot of /api/decisions/open so the live poll
 * never reshuffles the item being read. Per item: full cold-reader context,
 * the decision itself, and Prev / Skip / Postpone / Next with the open count.
 *  - Skip leaves the durable row untouched → it is back on the next tick.
 *  - Postpone snoozes the item's inbox row → hidden everywhere until it lapses.
 *  - Deciding uses the existing per-session routes (race-safe); 409/404 means
 *    another device already decided it, which counts as resolved.
 * Question/plan content is fetched from the durable row (chatStatus); a tool
 * approval renders only the secret-safe preview the queue carries — raw tool
 * input stays in the owning chat ("Open chat").
 */
export function DecisionCockpit({
  decisions, startIndex, onClose, onResolved, onOpenSession, onOpenCard,
}: {
  decisions: OpenDecision[]
  startIndex: number
  onClose: () => void
  onResolved: () => void
  /** Open the owning chat; false when it is not openable from here. */
  onOpenSession?: (d: OpenDecision) => boolean
  onOpenCard?: (id: number) => Promise<boolean>
}) {
  const [idx, setIdx] = useState(startIndex)
  const [resolved] = useState(() => new Set<number>())
  const [, redraw] = useState(0)
  const [status, setStatus] = useState<Pending | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [postponing, setPostponing] = useState(false)

  const len = decisions.length
  const d = decisions[idx]
  const needsStatus = d?.kind === "question" || d?.kind === "plan"

  useEffect(() => {
    setError("")
    setPostponing(false)
    if (!d || !needsStatus) { setStatus(null); setLoading(false); return }
    let alive = true
    setLoading(true)
    setStatus(null)
    api.chatStatus(d.session)
      .then((s: Pending) => { if (alive) setStatus(s) })
      .catch((e: Error) => { if (alive) setError(userError(e, "this item")) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [d, needsStatus])

  const go = (i: number) => { setIdx(i); redraw((n) => n + 1) }

  const resolvedHere = useCallback(() => {
    resolved.add(idx)
    onResolved()
    const next = firstOpen(len, idx, resolved)
    if (next < 0) onClose()
    else go(next)
  }, [idx, len, resolved, onResolved, onClose])

  const run = async (act: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await act()
      resolvedHere()
    } catch (e) {
      setError(userError(e, "your answer", "send"))
    } finally {
      setBusy(false)
    }
  }

  const step = (dir: 1 | -1) => { const n = stepDecision(len, idx, dir, resolved); if (n !== idx) go(n) }
  const skip = () => { const n = stepDecision(len, idx, 1, resolved); if (n === idx) onClose(); else go(n) }

  // ← / → browse, like any reader's pager — not while typing a reply.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest("input, textarea, select, [contenteditable=true]")) return
      if (e.key === "ArrowRight") step(1)
      if (e.key === "ArrowLeft") step(-1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const openCount = len - resolved.size
  const meta = d ? KIND[d.kind] || KIND.question : KIND.question
  const Icon = meta.icon
  const who = d ? d.label || d.requested_by || d.session.slice(0, 8) || "an agent" : ""
  const block = (name: string, input: unknown, id: string): ToolUseBlock => ({ type: "tool_use", name, input, id, result: null })
  const openChat = d && d.kind !== "card" && d.session && onOpenSession ? () => onOpenSession(d) : undefined

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="decision-cockpit" className="flex max-h-[90vh] flex-col sm:max-w-2xl">
        {!d ? (
          <div className="flex flex-col items-center gap-3 py-10">
            <CheckCircle2 className="size-8 text-primary" />
            <DialogTitle>All caught up</DialogTitle>
            <DialogDescription>Nothing is waiting on you.</DialogDescription>
            <Button onClick={onClose}>Done</Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 pr-8">
                <Icon className={d.kind === "red" ? "size-4 text-destructive" : "size-4 text-primary"} />
                <span className="truncate">{d.kind === "card" || d.kind === "red" ? d.summary : who}</span>
                <span data-testid="cockpit-count" className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
                  {idx + 1} of {len} · {openCount} open
                </span>
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-[10px]">{meta.label}</Badge>
                <span>{d.kind === "card" || d.kind === "red" ? `asked by ${who}` : ""}</span>
                {d.host !== "local" && <Badge variant="outline" className="text-[10px]">{d.host}</Badge>}
                <span>waiting {fmtDuration(d.waiting_s * 1000) || "just now"}</span>
              </DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
              {d.kind !== "card" && d.kind !== "red" && <p className="text-sm leading-relaxed">{d.summary || "(no summary)"}</p>}
              {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              {error && <p data-testid="cockpit-error" className="text-sm text-destructive">{error}</p>}

              {d.kind === "question" && !loading && (status?.pending_question
                ? <AuqBlock key={status.pending_question.tool_use_id}
                    block={block("AskUserQuestion", { questions: status.pending_question.questions }, status.pending_question.tool_use_id)}
                    onAnswer={(picks, note) => run(() => decided(api.chatQuestionAnswer({ session: d.session, picks, note })))} />
                : !error && <Unavailable onOpen={openChat} />)}

              {d.kind === "plan" && !loading && (status?.pending_plan
                ? <PlanBlock key={status.pending_plan.tool_use_id}
                    block={block("ExitPlanMode", { plan: status.pending_plan.plan }, status.pending_plan.tool_use_id)}
                    onDecide={(decision, feedback) => run(() => decided(api.chatPlanDecide({ session: d.session, decision, feedback: feedback || "" })))} />
                : !error && <Unavailable onOpen={openChat} />)}

              {d.kind === "approval" && (
                <Box title={`Allow tool: ${d.tool_name || "tool"}?`}>
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{d.summary || "(no preview)"}</pre>
                  <Actions busy={busy}
                    deny={() => run(() => decided(api.chatPermissionDecide({ session: d.session, id: d.id, decision: "deny" })))}
                    allow={() => run(() => decided(api.chatPermissionDecide({ session: d.session, id: d.id, decision: "allow" })))}
                    allowLabel="Allow" />
                </Box>
              )}

              {d.kind === "red" && (
                <Box title="Why it asks">
                  <p className="text-sm">{d.reason || "No reason given — deny it and the agent can ask again with one."}</p>
                  <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">If you approve</p>
                  <p className="text-sm">{d.risk || "The action runs."}</p>
                  <p className="mt-2 text-xs text-muted-foreground">Deny and nothing happens. The asking session is told either way.</p>
                  <Actions busy={busy} destructive
                    deny={() => run(() => api.orgResolveApproval(Number(d.id), "denied").then(() => {}, rejectUnlessGone))}
                    allow={() => run(() => api.orgResolveApproval(Number(d.id), "approved").then((r) => {
                      if (r.result?.error) throw new Error(`Approved, but it failed: ${r.result.error}`)
                    }, rejectUnlessGone))}
                    allowLabel="Approve" />
                </Box>
              )}

              {d.kind === "card" && (
                <Box title={d.column ? `Parked in ${d.column}` : "Parked for you"}>
                  <p className="text-sm">The card holds the full context and the question. Open it to read the thread, comment, or move it to Approved or Declined.</p>
                  <div className="mt-3 flex justify-end">
                    <Button size="sm" disabled={!d.card || !onOpenCard} onClick={async () => {
                      setError("")
                      // Opening is not deciding: the item stays open in the queue.
                      if (await onOpenCard!(d.card!)) onClose()
                      else setError("Could not open this card — it may have been deleted.")
                    }}>
                      <ClipboardList className="size-3.5" /> Open card
                    </Button>
                  </div>
                </Box>
              )}

              {openChat && (
                <button data-testid="cockpit-open-chat" onClick={openChat}
                  className="flex items-center gap-1 text-xs text-primary hover:underline">
                  <ExternalLink className="size-3" /> Open the chat for the full thread
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Button data-testid="cockpit-prev" size="sm" variant="outline" disabled={busy} onClick={() => step(-1)} title="Previous (←)">
                <ChevronLeft className="size-3.5" /> Prev
              </Button>
              <Button data-testid="cockpit-skip" size="sm" variant="ghost" disabled={busy} onClick={skip}
                title="Not now — it stays open and comes back on the next check">Skip</Button>
              {d.inbox_id > 0 && (
                <div className="relative">
                  <Button data-testid="cockpit-postpone" size="sm" variant="ghost" disabled={busy} onClick={() => setPostponing((v) => !v)}>Postpone</Button>
                  {postponing && (
                    <div className="absolute bottom-full z-10 mb-1 w-52 rounded-md border border-border bg-popover p-1 shadow-md">
                      {SNOOZE_OPTIONS.map((o) => (
                        <button key={o.hours} data-testid={`cockpit-postpone-${o.hours}`}
                          onClick={() => { setPostponing(false); run(() => api.inboxSnooze(d.inbox_id, o.hours).then(() => {})) }}
                          className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent">{o.label}</button>
                      ))}
                      <div className="border-t border-border px-2 pt-1 text-[11px] text-muted-foreground">
                        Hidden from the Inbox and the board until then — never dropped.
                      </div>
                    </div>
                  )}
                </div>
              )}
              <Button data-testid="cockpit-next" size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={() => step(1)} title="Next (→)">
                Next <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** orgResolveApproval throws with `status`; 404 = decided elsewhere or gone. */
function rejectUnlessGone(e: Error & { status?: number }): void {
  if (e.status !== 404) throw e
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}

function Actions({ busy, deny, allow, allowLabel, destructive }: {
  busy: boolean; deny: () => void; allow: () => void; allowLabel: string; destructive?: boolean
}) {
  return (
    <div className="mt-3 flex justify-end gap-2">
      <Button data-testid="cockpit-deny" size="sm" variant="outline" disabled={busy} onClick={deny}>Deny</Button>
      <Button data-testid="cockpit-allow" size="sm" variant={destructive ? "destructive" : "default"} disabled={busy} onClick={allow}>{allowLabel}</Button>
    </div>
  )
}

/** A question/plan whose durable row isn't readable here (decided on another
 *  device, or a remote session): the summary is shown, not a stale card. */
function Unavailable({ onOpen }: { onOpen?: () => void }) {
  return (
    <Box title="Full details aren't loadable here">
      <p className="text-sm">It may already be answered, or the session lives on another machine. Open the chat to decide, or skip — it stays in the queue until it's handled.</p>
      {onOpen && <div className="mt-3 flex justify-end"><Button size="sm" onClick={onOpen}>Open chat</Button></div>}
    </Box>
  )
}
