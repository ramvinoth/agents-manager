import { useState } from "react"
import { GitBranch, RotateCcw, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useStore, type RestoreMode } from "@/store"

type ModeOpt = { id: RestoreMode; title: string; desc: string; codeOnly?: boolean }

const MODES: ModeOpt[] = [
  { id: "conversation", title: "Restore conversation", desc: "Rewind the chat, keep your current code." },
  { id: "code", title: "Restore code", desc: "Revert edited files, keep the chat.", codeOnly: true },
  { id: "code+conversation", title: "Restore code + conversation", desc: "Roll both back to this point.", codeOnly: true },
]

/** Per-message Fork / Restore, shown on hover of a Claude user turn. */
export function MessageActions({ uuid }: { uuid: string }) {
  const forkFromMessage = useStore((s) => s.forkFromMessage)
  const revertToMessage = useStore((s) => s.revertToMessage)
  const chatRunning = useStore((s) => s.chatRunning)
  // Code restore relies on Claude Code's local file-history snapshots — offer it
  // only for local Claude sessions (Codex/Pi and remote hosts don't keep them).
  const codeSupported = useStore((s) => s.currentAgent === "claude" && s.currentHost === "local")
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<RestoreMode>(codeSupported ? "code+conversation" : "conversation")

  const modes = MODES.filter((m) => codeSupported || !m.codeOnly)

  return (
    <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      <button
        onClick={() => forkFromMessage(uuid)}
        disabled={chatRunning}
        title="Fork a new session from just before this message"
        aria-label="Fork from here"
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <GitBranch className="size-3.5" />
      </button>
      <button
        onClick={() => setOpen(true)}
        disabled={chatRunning}
        title="Restore to just before this message"
        aria-label="Restore to here"
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
      >
        <RotateCcw className="size-3.5" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Restore to before this message</DialogTitle>
            <DialogDescription>
              This message and everything after it are removed. A backup is kept before any change, so
              you can undo it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            {modes.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  mode === m.id
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-accent"
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                    mode === m.id ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
                  )}
                >
                  {mode === m.id && <Check className="size-3" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{m.title}</span>
                  <span className="block text-xs text-muted-foreground">{m.desc}</span>
                </span>
              </button>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Never mind
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false)
                revertToMessage(uuid, mode)
              }}
            >
              Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
