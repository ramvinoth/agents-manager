import { useState } from "react"
import { ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { userError } from "@/lib/errors"
import type { RedAsk } from "@/lib/types"
import { useStore } from "@/store"

/**
 * An org (Red) approval — the ONE rendering, shared by the decision cockpit
 * and the asking session's chat (card 223), so the two surfaces cannot drift.
 * Both decide through lib/redApproval's resolveRed.
 */

export function DecisionBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}

export function DecisionActions({ busy, deny, allow, allowLabel, destructive }: {
  busy: boolean; deny: () => void; allow: () => void; allowLabel: string; destructive?: boolean
}) {
  return (
    <div className="mt-3 flex justify-end gap-2">
      <Button data-testid="cockpit-deny" size="sm" variant="outline" disabled={busy} onClick={deny}>Deny</Button>
      <Button data-testid="cockpit-allow" size="sm" variant={destructive ? "destructive" : "default"} disabled={busy} onClick={allow}>{allowLabel}</Button>
    </div>
  )
}

/** The open org approvals THIS chat's session raised, inline above the
 *  composer: decided here instead of a trip to the Inbox (card 223). */
export function ChatRedApprovals() {
  const pending = useStore((s) => s.pendingRed)
  const decide = useStore((s) => s.decideRed)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState<{ id: string; text: string } | null>(null)
  if (!pending.length) return null
  const onDecide = async (id: string, decision: "approved" | "denied") => {
    if (busy) return
    setBusy(id)
    setError(null)
    try {
      await decide(id, decision)
    } catch (e) {
      setError({ id, text: userError(e, "this approval", "decide") })
    } finally {
      setBusy("")
    }
  }
  return (
    <div data-testid="chat-red-approvals" className="mb-2 space-y-2">
      {pending.map((ask) => (
        <div key={ask.id} className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-destructive">
            <ShieldAlert className="size-3.5" /> Needs your OK: {ask.summary}
          </div>
          <RedApprovalBlock ask={ask} busy={busy === ask.id} onDecide={(d) => onDecide(ask.id || "", d)} />
          {error && error.id === ask.id &&<p data-testid="chat-red-error" className="mt-1.5 text-xs text-destructive">{error.text}</p>}
        </div>
      ))}
    </div>
  )
}

/** Why the agent asks, what approving costs, and Deny / Approve. */
export function RedApprovalBlock({ ask, busy, onDecide, title = "Why it asks" }: {
  ask: RedAsk
  busy: boolean
  onDecide: (decision: "approved" | "denied") => void
  title?: string
}) {
  return (
    <DecisionBox title={title}>
      <p className="text-sm">{ask.reason || "No reason given — deny it and the agent can ask again with one."}</p>
      <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">If you approve</p>
      <p className="text-sm">{ask.risk || "The action runs."}</p>
      <p className="mt-2 text-xs text-muted-foreground">Deny and nothing happens. The asking session is told either way.</p>
      <DecisionActions busy={busy} destructive allowLabel="Approve"
        deny={() => onDecide("denied")} allow={() => onDecide("approved")} />
    </DecisionBox>
  )
}
