import { useEffect, useState } from "react"
import {
  Repeat,
  Trash2,
  User,
  Bot,
  Wrench,
  Terminal,
  FileText,
  Target,
  Filter,
  Check,
  Plus,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { fmtInterval, parseInterval } from "@/lib/format"
import { useStore, useAgentLabel } from "@/store"
import type { VisibleTypes } from "@/lib/types"

function SectionHeader({
  icon: Icon,
  title,
  saved,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  saved?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </span>
      {saved && (
        <span className="flex items-center gap-0.5 text-[10px] text-emerald-500">
          <Check className="size-3" /> Saved
        </span>
      )}
      {children && <span className="ml-auto">{children}</span>}
    </div>
  )
}

const TYPE_META: Record<keyof VisibleTypes, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  user: { label: "You", icon: User },
  assistant: { label: "Assistant", icon: Bot },
  tools: { label: "Tools", icon: Wrench },
  system: { label: "System", icon: Terminal },
}
const TYPES: (keyof VisibleTypes)[] = ["user", "assistant", "tools", "system"]

const HELP = "mt-2 text-[11px] leading-relaxed text-muted-foreground/60"

export function SettingsPanel() {
  const meta = useStore((s) => s.meta)
  const saveMeta = useStore((s) => s.saveMeta)
  const loops = useStore((s) => s.loops)
  const createLoop = useStore((s) => s.createLoop)
  const deleteLoop = useStore((s) => s.deleteLoop)
  const visible = useStore((s) => s.visible)
  const toggleVisible = useStore((s) => s.toggleVisible)
  const currentSessionPath = useStore((s) => s.currentSessionPath)
  const agentLabel = useAgentLabel()

  const [sysPrompt, setSysPrompt] = useState("")
  const [goal, setGoal] = useState("")
  const [loopPrompt, setLoopPrompt] = useState("")
  const [loopInterval, setLoopInterval] = useState("1h")
  const [saved, setSaved] = useState<"systemPrompt" | "goal" | null>(null)

  useEffect(() => {
    setSysPrompt(meta?.systemPrompt || "")
    setGoal(meta?.goal || "")
  }, [meta?.systemPrompt, meta?.goal])

  function save(field: "systemPrompt" | "goal", value: string) {
    if ((field === "systemPrompt" ? meta?.systemPrompt : meta?.goal) === value) return
    saveMeta(field, value)
    setSaved(field)
    setTimeout(() => setSaved((f) => (f === field ? null : f)), 1600)
  }

  if (!currentSessionPath) {
    return <div className="p-4 text-xs text-muted-foreground">No session loaded.</div>
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="divide-y divide-border/70 px-4">
        {/* Message-type filter */}
        <section className="py-4">
          <SectionHeader icon={Filter} title="Filter transcript" />
          <div className="grid grid-cols-2 gap-1.5">
            {TYPES.map((t) => {
              const { label, icon: Icon } = TYPE_META[t]
              const on = visible[t]
              return (
                <button
                  key={t}
                  onClick={() => toggleVisible(t)}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-md border py-1.5 text-xs transition-colors",
                    on
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <Icon className="size-3.5" />
                  {label}
                </button>
              )
            })}
          </div>
        </section>

        {/* System prompt */}
        <section className="py-4">
          <SectionHeader icon={FileText} title="System prompt" saved={saved === "systemPrompt"} />
          <Textarea
            value={sysPrompt}
            onChange={(e) => setSysPrompt(e.target.value)}
            onBlur={() => save("systemPrompt", sysPrompt)}
            placeholder="Add instructions for this session…"
            className="min-h-20 resize-none text-xs leading-relaxed"
          />
          <p className={HELP}>Appended to {agentLabel}'s system prompt on the next message.</p>
        </section>

        {/* Goal */}
        <section className="py-4">
          <SectionHeader icon={Target} title="Goal" saved={saved === "goal"} />
          <Input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onBlur={() => save("goal", goal)}
            placeholder="What is this session for?"
            className="h-9 text-sm"
          />
        </section>

        {/* Loops */}
        <section className="py-4">
          <SectionHeader icon={Repeat} title="Loops">
            {loops.length > 0 && (
              <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1.5 text-[10px] tabular-nums">
                {loops.length}
              </Badge>
            )}
          </SectionHeader>

          {loops.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {loops.map((l) => (
                <div
                  key={l.id}
                  className="group flex items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-2 text-xs"
                >
                  <Repeat className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate" title={l.prompt}>
                    {l.prompt}
                  </span>
                  <Badge variant="outline" className="shrink-0 px-1.5 text-[10px] font-normal tabular-nums">
                    {fmtInterval(l.interval)}
                  </Badge>
                  <button
                    onClick={() => deleteLoop(l.id)}
                    className="shrink-0 text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100"
                    aria-label="Delete loop"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <Textarea
              value={loopPrompt}
              onChange={(e) => setLoopPrompt(e.target.value)}
              placeholder="Prompt to run on a schedule…"
              className="min-h-16 resize-none text-xs leading-relaxed"
            />
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-[11px] text-muted-foreground">Runs every</span>
              <Input
                value={loopInterval}
                onChange={(e) => setLoopInterval(e.target.value)}
                placeholder="1h"
                className="h-8 w-14 px-2 text-center text-xs tabular-nums"
                title="Interval — e.g. 30s, 5m, 1h"
              />
              <Button
                size="sm"
                className="ml-auto h-8 gap-1 px-3 text-xs"
                disabled={!loopPrompt.trim()}
                onClick={() => {
                  createLoop(loopPrompt, parseInterval(loopInterval), "")
                  setLoopPrompt("")
                }}
              >
                <Plus className="size-3.5" /> Add loop
              </Button>
            </div>
          </div>
          {loops.length === 0 && (
            <p className={HELP}>Automatically re-runs a prompt on a schedule.</p>
          )}
        </section>
      </div>
    </div>
  )
}
