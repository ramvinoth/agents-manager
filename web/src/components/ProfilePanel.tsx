import { useState } from "react"
import { Power, Repeat } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStore } from "@/store"
import type { LoopMode } from "@/lib/types"

// Loop-firing modes, in escalating order of what's licensed to run — the
// plain-language version of loops.LOOP_MODES. Mirrors the mobile Profile screen.
const LOOP_OPTS: { v: LoopMode; label: string }[] = [
  { v: "none", label: "None" },
  { v: "user", label: "Yours" },
  { v: "harman", label: "Agent" },
  { v: "both", label: "Both" },
]

function SectionHeader({ icon: Icon, title }: { icon: React.ComponentType<{ className?: string }>; title: string }) {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
    </div>
  )
}

/** A pill toggle built from a plain button — the web has no Switch primitive. */
function Toggle({
  on,
  disabled,
  onClick,
}: {
  on: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-50",
        on ? "bg-primary" : "bg-muted"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-5 rounded-full bg-background shadow transition-transform",
          on ? "translate-x-[18px]" : "translate-x-0.5"
        )}
      />
    </button>
  )
}

/**
 * Profile tab (web control point) — mirrors mobile ProfileScreen's orchestration
 * controls: the AUTOMATION master switch and the SCHEDULED LOOPS mode picker.
 * Both read/write the ONE shared store cache, so toggling here immediately
 * updates the session-list pinned Harman entry. Server is the source of truth;
 * every write re-syncs from it.
 */
export function ProfilePanel() {
  const harman = useStore((s) => s.harman)
  const loopControl = useStore((s) => s.loopControl)
  const setAutomation = useStore((s) => s.setAutomation)
  const setLoopMode = useStore((s) => s.setLoopMode)

  const [autoBusy, setAutoBusy] = useState(false)
  const [autoErr, setAutoErr] = useState("")
  const [loopBusy, setLoopBusy] = useState(false)
  const [loopErr, setLoopErr] = useState("")

  // Three states, not two. A server older than the switch omits the key, and
  // rendering that as "off" would claim the machine is paused when that build
  // has no gate at all and still fires jobs. "Unknown" says so.
  const autoKnown = harman ? typeof harman.automation_enabled === "boolean" : false

  async function toggleAutomation() {
    if (!harman || autoBusy) return
    setAutoBusy(true)
    setAutoErr("")
    const msg = await setAutomation(!(harman.automation_enabled === true))
    setAutoErr(msg)
    setAutoBusy(false)
  }

  async function chooseLoopMode(mode: LoopMode) {
    if (loopBusy || (loopControl && loopControl.mode === mode)) return
    setLoopBusy(true)
    setLoopErr("")
    const msg = await setLoopMode(mode)
    setLoopErr(msg)
    setLoopBusy(false)
  }

  const autoHint = autoErr
    ? autoErr
    : !harman
      ? "Can't reach the server — state unknown."
      : !autoKnown
        ? "This server is too old to have the switch — it still runs jobs on their own. Update it."
        : harman.automation_enabled
          ? "On — scheduled jobs and the autonomous manager can start work on their own."
          : "Off — nothing runs unless you ask. Scheduled jobs and the manager are paused."

  const loopHint = loopErr
    ? loopErr
    : !loopControl
      ? "Can't reach the server — loop state unknown."
      : loopControl.mode === "none"
        ? "Paused — no scheduled loops fire, yours or the agents'."
        : loopControl.mode === "user"
          ? "Only your own scheduled loops fire. Agent-created loops stay paused."
          : loopControl.mode === "harman"
            ? "Only agent-created loops fire. Your own scheduled loops stay paused."
            : "Every scheduled loop fires — yours and the agents'."

  return (
    <div className="h-full overflow-y-auto">
      <div className="divide-y divide-border/70 px-4">
        <section className="py-4">
          <SectionHeader icon={Power} title="Automation" />
          <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Run work on its own</div>
              <div className={cn("text-[11px]", autoErr || (harman && !autoKnown) ? "text-destructive" : "text-muted-foreground")}>
                {autoHint}
              </div>
            </div>
            <Toggle
              on={harman?.automation_enabled === true}
              disabled={!autoKnown || autoBusy}
              onClick={toggleAutomation}
            />
          </div>
        </section>

        <section className="py-4">
          <SectionHeader icon={Repeat} title="Scheduled loops" />
          <div className="grid grid-cols-4 gap-1.5">
            {LOOP_OPTS.map((o) => {
              const active = loopControl?.mode === o.v
              return (
                <button
                  key={o.v}
                  disabled={!loopControl || loopBusy}
                  onClick={() => chooseLoopMode(o.v)}
                  className={cn(
                    "rounded-md border py-1.5 text-xs transition-colors disabled:opacity-50",
                    active
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
          <div className={cn("mt-2 text-[11px]", loopErr ? "text-destructive" : "text-muted-foreground")}>{loopHint}</div>
        </section>
      </div>
    </div>
  )
}
