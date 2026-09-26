import { useEffect, useState } from "react"
import { ChevronRight, Power, Repeat, ScrollText, Server } from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { useStore } from "@/store"
import { aiError, aiSummary, type AIConfig } from "@/lib/aiSelection"
import type { LoopMode } from "@/lib/types"
import { AISelectionDialog } from "./settings/AISelectionDialog"

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
  const systemPreamble = useStore((s) => s.systemPreamble)
  const setSystemPreamble = useStore((s) => s.setSystemPreamble)
  const providers = useStore((s) => s.providers)
  const currentHost = useStore((s) => s.currentHost)

  // New-chat AI defaults: one server-owned document per user (/api/ai/defaults).
  // Read here for the summary row; the dialog does the editing and hands back
  // the saved document so the row updates without a refetch.
  const [aiDefaults, setAiDefaults] = useState<AIConfig | null>(null)
  const [aiErr, setAiErr] = useState("")
  const [aiOpen, setAiOpen] = useState(false)
  useEffect(() => {
    let alive = true
    api
      .aiConfig({ host: currentHost })
      .then((c) => alive && setAiDefaults(c))
      .catch((e) => alive && setAiErr(aiError(e)))
    return () => {
      alive = false
    }
  }, [currentHost])

  const [autoBusy, setAutoBusy] = useState(false)
  const [autoErr, setAutoErr] = useState("")
  const [loopBusy, setLoopBusy] = useState(false)
  const [loopErr, setLoopErr] = useState("")
  // Local draft of the preamble so typing doesn't fight the shared cache; seeded
  // from the server value once it loads and re-seeded whenever the server value
  // changes (e.g. after an approval applied someone else's edit).
  const [draft, setDraft] = useState("")
  const [preBusy, setPreBusy] = useState(false)
  const [preMsg, setPreMsg] = useState("")
  useEffect(() => {
    if (systemPreamble !== null) setDraft(systemPreamble)
  }, [systemPreamble])

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

  async function savePreamble() {
    if (preBusy || systemPreamble === null || draft === systemPreamble) return
    setPreBusy(true)
    setPreMsg("")
    const msg = await setSystemPreamble(draft)
    setPreMsg(msg || "Saved.")
    setPreBusy(false)
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
          <SectionHeader icon={Server} title="AI for new chats" />
          <div className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2">
            <Server className="size-4 shrink-0 text-muted-foreground" />
            <button className="min-w-0 flex-1 text-left" onClick={() => setAiOpen(true)} disabled={!aiDefaults}>
              <div className="truncate text-sm font-medium">
                {aiDefaults ? aiSummary(aiDefaults.selection, providers) : aiErr || "Loading…"}
              </div>
              <div className={cn("truncate text-[11px]", aiDefaults?.issue ? "text-destructive" : "text-muted-foreground")}>
                {aiDefaults?.issue
                  ? aiDefaults.issue
                  : aiDefaults && !aiDefaults.configured
                    ? "Not set — new chats use the server's rules. Save once to pin them."
                    : "What every new chat on this server starts with. Existing chats keep their own."}
              </div>
            </button>
            <button className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50" onClick={() => setAiOpen(true)} disabled={!aiDefaults} title="Change new-chat AI">
              <ChevronRight className="size-4" />
            </button>
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

        <section className="py-4">
          <SectionHeader icon={ScrollText} title="System preamble" />
          <p className="mb-2 text-[11px] text-muted-foreground">
            Prepended to every session's system prompt, so each one knows it is a node in
            the system and how its tools are gated. Empty disables it. Applies to sessions
            started after you save.
          </p>
          <textarea
            value={draft}
            disabled={systemPreamble === null || preBusy}
            onChange={(e) => {
              setDraft(e.target.value)
              if (preMsg) setPreMsg("")
            }}
            spellCheck={false}
            rows={10}
            placeholder={systemPreamble === null ? "Loading…" : "No preamble — sessions get no system-awareness text."}
            className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11px] leading-relaxed outline-none focus:border-primary/40 disabled:opacity-50"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className={cn("text-[11px]", preMsg && preMsg !== "Saved." ? "text-destructive" : "text-muted-foreground")}>
              {preMsg}
            </span>
            <button
              disabled={systemPreamble === null || preBusy || draft === systemPreamble}
              onClick={savePreamble}
              className="rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-primary/20 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </section>
      </div>

      {aiOpen && (
        <AISelectionDialog
          scope={{ host: currentHost }}
          title="AI for new chats"
          hint="Every new chat you start on this server begins with these settings. Chats that already exist are unchanged."
          onSaved={setAiDefaults}
          onClose={() => setAiOpen(false)}
        />
      )}
    </div>
  )
}
