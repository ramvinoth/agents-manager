import { useState } from "react"
import { Sparkles, ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Collapsible } from "./Collapsible"
import { Markdown } from "./Markdown"
import { useStore, useAgentLabel } from "@/store"
import { planText, planDecision, planStateLabel } from "@/lib/plan"
import type { ToolUseBlock } from "@/lib/types"
import { useFoldOnDecision } from "./useFoldOnDecision"

/**
 * A proposed plan (ExitPlanMode), with Approve / Request changes while it is
 * still awaiting a decision.
 *
 * Whether it was decided is derived from the block itself (`result != null`),
 * never stored — see lib/plan.ts. A decided plan folds to its one-line header so
 * a 12k-character plan doesn't own the scrollback forever; clicking reopens it,
 * with the buttons gone because the decision is already history.
 */
export function PlanBlock({ block }: { block: ToolUseBlock }) {
  const decidePlan = useStore((s) => s.decidePlan)
  const agentLabel = useAgentLabel()
  const state = planDecision(block.result)
  const pending = state === "pending"
  const text = planText(block.input)
  const [open, toggle] = useFoldOnDecision(pending)
  const [asking, setAsking] = useState(false)
  const [feedback, setFeedback] = useState("")
  const [sent, setSent] = useState(false)
  if (!text) return null

  const decide = (d: "approve" | "deny", note?: string) => {
    if (sent) return
    setSent(true)
    decidePlan(d, note)
  }

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-1.5 text-xs font-medium text-primary"
      >
        <Sparkles className="size-3.5" />
        <span>
          {agentLabel}'s plan
          {planStateLabel(state) ? ` · ${planStateLabel(state)}` : ""}
        </span>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
      {open && (
        <div className="mt-2">
          <Collapsible text={text}>{(shown) => <Markdown text={shown} />}</Collapsible>
        </div>
      )}
      {pending &&
        (asking ? (
          <div className="mt-3 space-y-2">
            <Textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="What should change? (sent to the agent to revise)"
              rows={3}
            />
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={sent} onClick={() => setAsking(false)}>
                Back
              </Button>
              <Button size="sm" disabled={sent} onClick={() => decide("deny", feedback.trim())}>
                Send feedback
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" disabled={sent} onClick={() => setAsking(true)}>
              Request changes
            </Button>
            <Button size="sm" disabled={sent} onClick={() => decide("approve")}>
              {sent ? "…" : "Approve"}
            </Button>
          </div>
        ))}
    </div>
  )
}
