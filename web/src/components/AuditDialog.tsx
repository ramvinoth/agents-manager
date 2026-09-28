import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { formatActor, type ActorKind } from "@/lib/board"
import { TONE_CLASS, type Tone } from "@/lib/tone"
import {
  AUDIT_FILTERS,
  auditError,
  auditReducer,
  auditSubject,
  auditTime,
  auditTimestamp,
  groupAuditEntries,
  initialAuditState,
  resultTone,
  type AuditEntry,
  type AuditFilter,
  type AuditLoad,
  type ResultTone,
} from "@/lib/audit"

/**
 * AuditDialog — the org's activity feed: who did what, to which card, grouped
 * by day. Mirrors the mobile Audit screens as one surface: a row reads as a
 * sentence ("Harman · card_move · “Ship the editor” → Review"), plain successes
 * stay quiet and only approvals, denials and failures get a chip, and clicking a
 * row expands its record in place instead of leaving the feed. `onOpenCard`
 * lets the board host jump to a card that still exists on it; without a host
 * (Profile) the record is read-only.
 */
export function AuditDialog({
  selfUsername,
  onOpenCard,
  onClose,
}: {
  selfUsername?: string
  /** Returns false when the card is not on the host's board; the link then explains itself. */
  onOpenCard?: (cardId: number) => boolean
  onClose: () => void
}) {
  const [state, dispatch] = useReducer(auditReducer, undefined, initialAuditState)
  const [open, setOpen] = useState<number | null>(null)
  const request = useRef(0)
  const busy = useRef<AuditLoad | null>(null)
  const sections = useMemo(() => groupAuditEntries(state.rows), [state.rows])

  const load = useCallback(async (mode: AuditLoad, filter: AuditFilter, before?: number) => {
    // Refresh/filter deliberately supersede older requests. Repeated older clicks do not.
    if (mode === "older" && busy.current) return
    const current = ++request.current
    busy.current = mode
    dispatch({ type: "begin", request: current, mode, filter })
    try {
      const page = await api.orgAudit(filter, before)
      if (current !== request.current) return
      dispatch({ type: "success", request: current, page })
    } catch (error) {
      if (current !== request.current) return
      dispatch({ type: "failure", request: current, error: auditError(error) })
    } finally {
      if (current === request.current) busy.current = null
    }
  }, [])

  useEffect(() => {
    void load("initial", "all")
    return () => { ++request.current; busy.current = null }
  }, [load])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[85vh] max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 pt-5 pb-3">
          <DialogTitle>Activity</DialogTitle>
          <DialogDescription>Who did what, and when — every recorded board change, approval and denial across the org.</DialogDescription>
          <div className="mt-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Filter by result">
            {AUDIT_FILTERS.map((f) => {
              const on = f.value === state.filter
              return (
                <button
                  key={f.value}
                  role="radio"
                  aria-checked={on}
                  onClick={() => { if (!on) { setOpen(null); void load("initial", f.value) } }}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                    on ? "bg-foreground text-background" : "bg-muted text-foreground hover:bg-accent"
                  )}
                >
                  {f.label}
                </button>
              )
            })}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          {state.error && (
            <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm">
              <div className="font-medium text-destructive" role="alert">{state.error}</div>
              {state.loaded && <div className="mt-0.5 text-xs text-muted-foreground">Showing the previously loaded records.</div>}
              <Button variant="link" size="sm" className="mt-1 h-auto px-0" onClick={() => void load(state.loaded ? "refresh" : "initial", state.filter)}>
                Try again
              </Button>
            </div>
          )}

          {state.loading && !state.rows.length ? (
            <div className="flex justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
          ) : !state.error && state.loaded && !state.rows.length ? (
            <div className="px-6 py-16 text-center">
              <div className="text-base font-semibold">{state.filter === "all" ? "Nothing recorded yet" : "Nothing here"}</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {state.filter === "all" ? "Every board change, approval and denial will show up here as it happens." : "No recorded actions match this filter."}
              </div>
            </div>
          ) : null}

          {sections.map((section) => (
            <section key={section.key}>
              <h3 className="sticky top-0 z-10 bg-background/95 px-5 pt-4 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                {section.title}
              </h3>
              <ul>
                {section.data.map((entry) => (
                  <AuditRow
                    key={entry.id}
                    entry={entry}
                    selfUsername={selfUsername}
                    expanded={open === entry.id}
                    onToggle={() => setOpen((o) => (o === entry.id ? null : entry.id))}
                    onOpenCard={onOpenCard}
                  />
                ))}
              </ul>
            </section>
          ))}

          {state.loaded && state.rows.length > 0 && (
            <div className="flex flex-col items-center gap-1 px-5 py-5">
              {state.olderError && <div role="alert" className="text-xs text-destructive">{state.olderError} Loaded records are unchanged.</div>}
              {state.nextBefore !== null ? (
                <Button variant="outline" size="sm" disabled={!!state.loading} onClick={() => void load("older", state.filter, state.nextBefore!)}>
                  {state.loading === "older" ? "Loading older…" : state.olderError ? "Try loading older again" : "Load older"}
                </Button>
              ) : (
                <div className="text-xs text-muted-foreground">Beginning of recorded history{state.filter !== "all" ? " for this filter" : ""}.</div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Loudness → colour: "quiet" never renders a chip, so it has no tone. */
const RESULT_TONE: Record<Exclude<ResultTone, "quiet">, Tone> = { attention: "warning", danger: "danger", muted: "neutral" }

/** Initial-letter avatar: humans get the primary tint, agents the neutral one. */
function ActorBadge({ name, kind, className }: { name: string; kind: ActorKind; className?: string }) {
  const human = kind === "you" || kind === "human"
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
        human ? "bg-primary/15 text-primary" : "bg-muted text-foreground",
        className
      )}
    >
      {(name.trim()[0] || "?").toUpperCase()}
    </span>
  )
}

function AuditRow({
  entry,
  selfUsername,
  expanded,
  onToggle,
  onOpenCard,
}: {
  entry: AuditEntry
  selfUsername?: string
  expanded: boolean
  onToggle: () => void
  onOpenCard?: (cardId: number) => boolean
}) {
  const who = formatActor(entry.actor, selfUsername)
  const subject = auditSubject(entry.target)
  const tone = resultTone(entry.result.category)
  const cardId = entry.target.card_id
  const [missing, setMissing] = useState(false)
  return (
    <li className={cn("border-b border-border/60 last:border-0", expanded && "bg-muted/40")}>
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-3 px-5 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        <ActorBadge name={who.name} kind={who.kind} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <div className="min-w-0 flex-1 truncate text-sm">
              <span className="font-semibold">{who.name}</span>
              <span className="text-muted-foreground"> · {entry.action}</span>
            </div>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{auditTime(entry.created_at)}</span>
          </div>
          <div className="truncate text-sm">{subject}</div>
          {tone !== "quiet" && (
            <span className={cn("mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium", TONE_CLASS[RESULT_TONE[tone]])}>{entry.result.label}</span>
          )}
        </div>
      </button>
      {expanded && (
        <div className="px-5 pb-4 pl-[60px]">
          <div className="rounded-md border border-border bg-background p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recorded result</span>
              <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", tone !== "quiet" && TONE_CLASS[RESULT_TONE[tone]])}>{entry.result.label}</span>
            </div>
            <p className="mt-1.5 leading-relaxed">{entry.result.explanation}</p>
            <p className="mt-1 text-xs text-muted-foreground">A record of what happened then, not the card’s state now.</p>
            <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-y-1.5 border-t border-border pt-3 text-xs">
              <dt className="text-muted-foreground">Actor</dt><dd className="font-mono">{entry.actor}</dd>
              <dt className="text-muted-foreground">Target</dt><dd>{entry.target.label}</dd>
              <dt className="text-muted-foreground">Recorded at</dt><dd className="tabular-nums">{auditTimestamp(entry.created_at)}</dd>
              <dt className="text-muted-foreground">Record ID</dt><dd className="tabular-nums">{entry.id}</dd>
            </dl>
            {onOpenCard && cardId !== undefined && (
              <div className="mt-3 flex items-center gap-2">
                <Button size="sm" variant="secondary" disabled={missing} onClick={() => { if (!onOpenCard(cardId)) setMissing(true) }}>
                  Open card
                </Button>
                {missing && <span className="text-xs text-muted-foreground">This card is not on this board any more.</span>}
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  )
}
