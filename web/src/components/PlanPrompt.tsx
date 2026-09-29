import { useState } from "react"
import { ClipboardList, Check, X, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useStore } from "@/store"
import { renderMarkdownSegments } from "@/lib/markdown"

/**
 * Plan approval (ExitPlanMode). A driven run in plan mode BLOCKS server-side
 * waiting for this decision — engine._await_plan_decision holds the call for up
 * to an hour — so without this card the agent simply hangs with nothing on
 * screen. It is excluded from the generic Allow/Deny list on purpose
 * (pending_approvals_public) because a plan needs its own affordances: read the
 * plan, approve it, or send it back with feedback to revise.
 *
 * Approve -> the agent starts executing. Deny -> it revises using the feedback
 * text, in the SAME turn (the blocked call returns the feedback as the tool
 * result), so nothing needs to be re-sent as a new message.
 */
export function PlanPrompt() {
  const plan = useStore((s) => s.pendingPlan)
  const decidePlan = useStore((s) => s.decidePlan)
  const [feedback, setFeedback] = useState("")
  const [revising, setRevising] = useState(false)
  const [sent, setSent] = useState(false)

  if (!plan) return null

  async function send(decision: "approve" | "deny") {
    if (sent) return
    setSent(true)
    await decidePlan(decision, decision === "deny" ? feedback : "")
    setFeedback("")
    setRevising(false)
    setSent(false)
  }

  const segments = renderMarkdownSegments(plan.plan || "")

  return (
    <div className="mb-2 rounded-lg border border-blue-500/40 bg-blue-500/5 px-3 py-2.5 text-sm">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400">
        <ClipboardList className="size-3.5" /> Plan ready for review
      </div>
      <div className="markdown-content mb-2 max-h-96 overflow-auto rounded bg-background/60 p-2">
        {segments.map((seg, i) => (
          <div key={i} dangerouslySetInnerHTML={{ __html: seg.type === "mermaid" ? "" : seg.html }} />
        ))}
      </div>
      {revising ? (
        <div className="space-y-2">
          <textarea
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should change? The agent revises the plan using this."
            rows={3}
            className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="flex gap-2">
            <Button size="sm" className="h-7 gap-1" disabled={sent} onClick={() => send("deny")}>
              {sent ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Send feedback
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={sent}
              onClick={() => setRevising(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" className="h-7 gap-1" disabled={sent} onClick={() => send("approve")}>
            {sent ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Approve & run
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1"
            disabled={sent}
            onClick={() => setRevising(true)}
          >
            <X className="size-3.5" /> Request changes
          </Button>
        </div>
      )}
    </div>
  )
}
