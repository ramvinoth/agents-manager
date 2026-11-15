import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useStore } from "@/store"
import { GOAL_EXAMPLES, ceoStart } from "@/lib/firstGoal"

/**
 * First-run card in an empty chat rail: the new owner's first action is
 * stating a goal, which starts a CEO chat (lib/firstGoal.ts).
 */
export function FirstGoalCard() {
  const startNewSession = useStore((s) => s.startNewSession)
  const [text, setText] = useState("")
  const ready = text.trim().length > 0
  return (
    <div className="space-y-3 px-2 py-6" data-testid="first-goal-card">
      <div className="text-sm font-medium">What should your team work on first?</div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Describe a goal in a sentence"
        className="min-h-16 text-sm"
        aria-label="First goal"
      />
      <div className="flex flex-wrap gap-1.5">
        {GOAL_EXAMPLES.map((g) => (
          <Button key={g} variant="secondary" size="sm" className="h-auto whitespace-normal py-1 text-left text-xs" onClick={() => setText(g)}>
            {g}
          </Button>
        ))}
      </div>
      <Button
        className="w-full"
        disabled={!ready}
        onClick={() => void startNewSession({ cwd: "~", ...ceoStart(text) })}
      >
        Start
      </Button>
    </div>
  )
}
