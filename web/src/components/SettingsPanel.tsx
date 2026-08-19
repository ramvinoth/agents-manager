import { useState } from "react"
import {
  Repeat,
  User,
  Bot,
  Wrench,
  Terminal,
  FileText,
  Target,
  Filter,
  Server,
  GitBranch,
  Pencil,
  X,
  ChevronRight,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useStore } from "@/store"
import { TextFieldDialog } from "./settings/TextFieldDialog"
import { LoopsDialog } from "./settings/LoopsDialog"
import { GitDialog } from "./settings/GitDialog"
import { ModelProviderDialog } from "./settings/ModelProviderDialog"
import type { VisibleTypes } from "@/lib/types"

function SectionHeader({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </span>
      {children && <span className="ml-auto">{children}</span>}
    </div>
  )
}

/** A tappable summary row: icon · title + one-line preview → opens a modal.
 *  Optional edit + clear affordances (clear hidden when there's nothing set). */
function SummaryRow({
  icon: Icon,
  title,
  preview,
  isSet,
  onOpen,
  onClear,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  preview: string
  isSet: boolean
  onOpen: () => void
  onClear?: () => void
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <div className="text-sm font-medium">{title}</div>
        <div className={cn("truncate text-[11px]", isSet ? "text-muted-foreground" : "text-muted-foreground/50 italic")}>
          {preview}
        </div>
      </button>
      <Button variant="ghost" size="icon" className="size-7" onClick={onOpen} title={`Edit ${title.toLowerCase()}`}>
        <Pencil className="size-3.5" />
      </Button>
      {isSet && onClear && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-destructive"
          onClick={onClear}
          title="Clear"
        >
          <X className="size-3.5" />
        </Button>
      )}
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

type Modal = "provider" | "systemPrompt" | "goal" | "loops" | "git" | null

export function SettingsPanel() {
  const meta = useStore((s) => s.meta)
  const saveMeta = useStore((s) => s.saveMeta)
  const loops = useStore((s) => s.loops)
  const visible = useStore((s) => s.visible)
  const toggleVisible = useStore((s) => s.toggleVisible)
  const currentSessionPath = useStore((s) => s.currentSessionPath)
  const providers = useStore((s) => s.providers)
  const git = useStore((s) => s.git)

  const [modal, setModal] = useState<Modal>(null)

  if (!currentSessionPath) {
    return <div className="p-4 text-xs text-muted-foreground">No session loaded.</div>
  }

  const sysPrompt = meta?.systemPrompt || ""
  const goal = meta?.goal || ""
  const providerName = meta?.provider
    ? providers.find((p) => p.id === meta.provider)?.name || "Custom provider"
    : "Default (Claude)"

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

        {/* Model provider — per-session choice from the global library. */}
        <section className="py-4">
          <SectionHeader icon={Server} title="Model provider" />
          <div className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2">
            <Server className="size-4 shrink-0 text-muted-foreground" />
            <button className="min-w-0 flex-1 text-left" onClick={() => setModal("provider")}>
              <div className="text-sm font-medium">{providerName}</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {meta?.provider ? `${meta.convMode || "chat"} mode` : "Uses your Claude login"}
              </div>
            </button>
            <Button variant="ghost" size="icon" className="size-7" onClick={() => setModal("provider")} title="Choose provider">
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </section>

        {/* System prompt / Goal / Loops / Git — summary rows opening modals. */}
        <section className="space-y-2 py-4">
          <SummaryRow
            icon={FileText}
            title="System prompt"
            preview={sysPrompt || "Not set — tap to add instructions"}
            isSet={!!sysPrompt}
            onOpen={() => setModal("systemPrompt")}
            onClear={() => saveMeta("systemPrompt", "")}
          />
          <SummaryRow
            icon={Target}
            title="Goal"
            preview={goal || "Not set — what is this session for?"}
            isSet={!!goal}
            onOpen={() => setModal("goal")}
            onClear={() => saveMeta("goal", "")}
          />
          <div className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2">
            <Repeat className="size-4 shrink-0 text-muted-foreground" />
            <button className="min-w-0 flex-1 text-left" onClick={() => setModal("loops")}>
              <div className="text-sm font-medium">Loops</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {loops.length ? `${loops.length} loop${loops.length === 1 ? "" : "s"} scheduled` : "No loops — tap to add"}
              </div>
            </button>
            {loops.length > 0 && (
              <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1.5 text-[10px] tabular-nums">
                {loops.length}
              </Badge>
            )}
            <Button variant="ghost" size="icon" className="size-7" onClick={() => setModal("loops")} title="Manage loops">
              <ChevronRight className="size-4" />
            </Button>
          </div>
          {git?.repo && (
            <div className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2">
              <GitBranch className="size-4 shrink-0 text-muted-foreground" />
              <button className="min-w-0 flex-1 text-left" onClick={() => setModal("git")}>
                <div className="text-sm font-medium">Git</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {(git.name || "repo") + " · " + (git.branch || "—")}
                </div>
              </button>
              {!!git.dirty && (
                <Badge variant="secondary" className="px-1.5 text-[10px] text-amber-500">{git.dirty}</Badge>
              )}
              <Button variant="ghost" size="icon" className="size-7" onClick={() => setModal("git")} title="Git details">
                <ChevronRight className="size-4" />
              </Button>
            </div>
          )}
        </section>
      </div>

      {modal === "provider" && <ModelProviderDialog onClose={() => setModal(null)} />}
      {modal === "systemPrompt" && (
        <TextFieldDialog
          title="System prompt"
          description="Appended to the agent's system prompt on the next message."
          value={sysPrompt}
          placeholder="Add instructions for this session…"
          onSave={(v) => saveMeta("systemPrompt", v)}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "goal" && (
        <TextFieldDialog
          title="Goal"
          description="What is this session for? The agent keeps working toward it."
          value={goal}
          placeholder="What is this session for?"
          onSave={(v) => saveMeta("goal", v)}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "loops" && <LoopsDialog onClose={() => setModal(null)} />}
      {modal === "git" && <GitDialog onClose={() => setModal(null)} />}
    </div>
  )
}
