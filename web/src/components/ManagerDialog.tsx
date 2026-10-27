import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useStore } from "@/store"

// Manager: an orchestrator session created in the home
// directory so it can see and coordinate every project on the machine.
const DEFAULT_CHARACTER = `You are Manager, the orchestrator agent for this machine, running from the home directory with access to every project.

Your duties:
1. Coordinate the sub-projects under the home directory (e.g. ~/projects, ~/Documents/projects).
2. Report the status of agent work sessions. Transcripts are JSONL files under ~/.claude/projects/<project-dir>/<session-id>.jsonl — read the tails of recently modified ones to summarize what each session is doing, its outcome, and any blockers.
3. Propose concrete next actions per project when asked.

Keep reports concise and structured: one section per project, with status, last activity, and blockers.`

const BOOTSTRAP =
  "You are online as Manager. Confirm briefly, then list the project directories you can see under your home directory with a one-line note for each."

export function ManagerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const startNewSession = useStore((s) => s.startNewSession)
  const [character, setCharacter] = useState(DEFAULT_CHARACTER)
  const [goal, setGoal] = useState("")

  async function create() {
    onOpenChange(false)
    await startNewSession({
      cwd: "~", // expanded to the home dir server-side, so Manager can reach every project
      title: "Manager",
      message: BOOTSTRAP,
      systemPrompt: character.trim(),
      goal: goal.trim(),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up Manager</DialogTitle>
          <DialogDescription>
            Harness Manager — an orchestrator session created in your home directory so
            it can reach every project. The system prompt is editable now and later in Settings.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Agent character (system prompt)</label>
            <Textarea
              value={character}
              onChange={(e) => setCharacter(e.target.value)}
              className="min-h-40 text-xs"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Goal (optional)</label>
            <Input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="e.g. Keep every sub-project moving; flag anything stalled over a day."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={create}>Create Manager</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
