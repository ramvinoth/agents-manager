import { useEffect, useMemo, useRef, useState } from "react"
import { Send, Square, X, CheckCircle2, AlertCircle, Bookmark, Zap, ListPlus, Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useStore, useAgentLabel } from "@/store"
import { api } from "@/lib/api"

// Model + permission options are per-agent. Claude uses --permission-mode +
// its model aliases; Copilot maps to native --mode (interactive/plan/autopilot)
// and its own model ids (the CLI can't enumerate models, so this is curated).
const PERM_MODES_CLAUDE = [
  { v: "acceptEdits", label: "Accept edits" },
  { v: "default", label: "Ask" },
  { v: "plan", label: "Plan" },
  { v: "bypassPermissions", label: "Bypass" },
]
const PERM_MODES_COPILOT = [
  { v: "autopilot", label: "Autopilot" },
  { v: "plan", label: "Plan" },
]
const MODELS_CLAUDE = [
  { v: "default", label: "Default model" },
  { v: "opus", label: "Opus" },
  { v: "sonnet", label: "Sonnet" },
  { v: "haiku", label: "Haiku" },
]
// Copilot's selectable models are fetched dynamically per-plan from its /models
// API (see caps.models) — a Pro/Pro+ account's Opus/GPT-5 appear automatically,
// a free plan returns none (only Default + Auto apply). "Custom model ID…" is
// the escape hatch for any id not surfaced. "" omits --model (CLI default).
const CUSTOM_MODEL = "__custom__"
const MODELS_COPILOT_BASE = [
  { v: "default", label: "Default model" },
  { v: "auto", label: "Auto (Copilot picks)" },
]

const SELECT_TRIGGER =
  "h-7 w-auto gap-1 rounded-md border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-0 dark:bg-transparent dark:hover:bg-accent [&_svg]:size-3 [&_svg]:opacity-70"

function StatusLine() {
  const status = useStore((s) => s.chatStatus)
  // The "running" state is shown as a spinner in the transcript, not here.
  if (!status || status.kind === "running") return null
  const Icon = status.kind === "done" ? CheckCircle2 : AlertCircle
  return (
    <div
      className={cn(
        "mb-2 flex items-center gap-2 text-xs",
        status.kind === "error" ? "text-destructive" : "text-muted-foreground"
      )}
    >
      <Icon className="size-3.5" />
      {status.text}
    </div>
  )
}

function QueueRow() {
  const queue = useStore((s) => s.queue)
  const removeQueued = useStore((s) => s.removeQueued)
  if (!queue.length) return null
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {queue.map((q, i) => (
        <Badge key={i} variant="secondary" className="max-w-64 gap-1 font-normal">
          <span className="truncate">{q}</span>
          <button onClick={() => removeQueued(i)} className="shrink-0 hover:text-destructive">
            <X className="size-3" />
          </button>
        </Badge>
      ))}
    </div>
  )
}

function StashButton({
  text,
  onRestore,
  onStashCurrent,
}: {
  text: string
  onRestore: (s: string) => void
  onStashCurrent: () => void
}) {
  const stash = useStore((s) => s.stash)
  const removeStash = useStore((s) => s.removeStash)
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          title="Stash drafts"
        >
          <Bookmark className="size-3.5" />
          {stash.length > 0 && <span className="tabular-nums">{stash.length}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1">
        <button
          disabled={!text.trim()}
          onClick={onStashCurrent}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
        >
          <ListPlus className="size-3.5" /> Stash current draft
        </button>
        <div className="my-1 h-px bg-border" />
        {stash.length ? (
          <div className="max-h-64 overflow-y-auto">
            {stash.map((s, i) => (
              <div key={i} className="group flex items-start gap-1 rounded-md px-2 py-1.5 hover:bg-accent">
                <button
                  className="min-w-0 flex-1 truncate text-left text-xs"
                  title={s}
                  onClick={() => {
                    onRestore(s)
                    setOpen(false)
                  }}
                >
                  {s}
                </button>
                <button
                  onClick={() => removeStash(i)}
                  className="shrink-0 text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100"
                  aria-label="Remove"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            No stashed drafts. Park a message to reuse later.
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function Composer() {
  const [text, setText] = useState("")
  const [slashSel, setSlashSel] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const currentSessionPath = useStore((s) => s.currentSessionPath)
  const chatRunning = useStore((s) => s.chatRunning)
  const sendChat = useStore((s) => s.sendChat)
  const steerMessage = useStore((s) => s.steerMessage)
  const interruptRun = useStore((s) => s.interruptRun)
  const addStash = useStore((s) => s.addStash)
  const permMode = useStore((s) => s.permMode)
  const setPermMode = useStore((s) => s.setPermMode)
  const model = useStore((s) => s.model)
  const setModel = useStore((s) => s.setModel)
  const slashCommands = useStore((s) => s.slashCommands)
  const currentAgent = useStore((s) => s.currentAgent)
  const currentHost = useStore((s) => s.currentHost)
  const caps = useStore((s) => s.caps)
  const continueInteractively = useStore((s) => s.continueInteractively)
  const pendingDraft = useStore((s) => s.pendingDraft)
  const clearPendingDraft = useStore((s) => s.clearPendingDraft)
  const agentLabel = useAgentLabel()

  // Claude has full driving (steer/queue). Pi and Codex are driven one-shot
  // (send + stop, no steer/queue). Other agents stay view-only for now.
  const canSteer = currentAgent === "claude"
  const viewOnly = !["claude", "pi", "codex", "copilot"].includes(currentAgent)
  const disabled = !currentSessionPath || viewOnly

  // Per-agent model + permission options. Effective values guard against a
  // leftover value from another agent (e.g. Claude "opus" while on Copilot) —
  // the backend also validates, so a stale value can never break a run.
  const isCopilot = currentAgent === "copilot"
  const permModes = isCopilot ? PERM_MODES_COPILOT : PERM_MODES_CLAUDE
  const copilotModels = useMemo(
    () => [
      ...MODELS_COPILOT_BASE,
      ...(Array.isArray(caps?.models) ? caps.models : []),
      { v: CUSTOM_MODEL, label: "Custom model ID…" },
    ],
    [caps]
  )
  const models = isCopilot ? copilotModels : MODELS_CLAUDE
  const permVal = permModes.some((m) => m.v === permMode) ? permMode : permModes[0].v
  const modelSel = model || "default"
  const modelVal = models.some((m) => m.v === modelSel) ? modelSel : "default"

  // Copilot only: a typed model id (not in the shortcut list) shows as "Custom".
  const [customModel, setCustomModel] = useState(false)
  const curatedModelVals = models.filter((m) => m.v !== CUSTOM_MODEL).map((m) => m.v)
  const showCustomModel = isCopilot && (customModel || (!!model && !curatedModelVals.includes(model)))

  useEffect(() => {
    // Normalise the stored value to the current agent on switch, without wiping
    // a legitimate Copilot custom model id (so it survives reloads too).
    if (!permModes.some((m) => m.v === permMode)) setPermMode(permModes[0].v)
    if (isCopilot) {
      // Only strip a leftover Claude alias; keep "", "auto", and custom ids.
      if (["opus", "sonnet", "haiku"].includes(model)) setModel("")
    } else if (!models.some((m) => m.v === (model || "default"))) {
      // Entering a fixed-list agent: drop a Copilot "auto"/custom id it can't use.
      setModel("")
    }
    setCustomModel(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentAgent])

  // Draft persistence — restore per-session on load, save as you type.
  useEffect(() => {
    setText(currentSessionPath ? localStorage.getItem("draft:" + currentSessionPath) || "" : "")
  }, [currentSessionPath])
  useEffect(() => {
    if (!currentSessionPath) return
    if (text) localStorage.setItem("draft:" + currentSessionPath, text)
    else localStorage.removeItem("draft:" + currentSessionPath)
  }, [text, currentSessionPath])

  // Fork/revert hand the removed message back to the composer to edit & resend.
  useEffect(() => {
    if (pendingDraft != null) {
      setText(pendingDraft)
      clearPendingDraft()
      taRef.current?.focus()
    }
  }, [pendingDraft, clearPendingDraft])

  const term = useMemo(() => {
    const m = text.match(/^\/([\w:.-]*)$/)
    return m ? m[1].toLowerCase() : null
  }, [text])

  const slashMatches = useMemo(() => {
    if (term === null) return []
    return slashCommands
      .filter((c) => c.name.toLowerCase().includes(term))
      .sort((a, b) => {
        const as = a.name.toLowerCase().startsWith(term) ? 0 : 1
        const bs = b.name.toLowerCase().startsWith(term) ? 0 : 1
        return as - bs || a.name.localeCompare(b.name)
      })
      .slice(0, 12)
  }, [term, slashCommands])

  const slashOpen = slashMatches.length > 0

  useEffect(() => {
    setSlashSel(0)
  }, [term])

  function selectSlash(name: string) {
    setText("/" + name + " ")
    taRef.current?.focus()
  }

  async function send() {
    const msg = text.trim()
    if (!msg || disabled) return
    setText("")
    const restore = await sendChat(msg)
    if (restore) setText(restore)
  }
  async function steer() {
    const msg = text.trim()
    if (!msg) return
    setText("")
    const restore = await steerMessage(msg)
    if (restore) setText(restore)
  }
  function stashCurrent() {
    if (!text.trim()) return
    addStash(text)
    setText("")
  }
  // Launch this Copilot session in a persistent interactive terminal — the full
  // TUI (all slash commands, ask_user questions, per-tool allow/deny) that the
  // one-shot -p driving can't offer. Survives refresh (reattaches to the PTY).
  // The backend resolves the copilot binary + cwd (its PATH varies per host).
  async function openInteractive() {
    if (!currentSessionPath) return
    const id = currentSessionPath.split("/")[0].replace(/\.jsonl$/, "")
    const key = `copilot:${currentHost}:${id}`
    try {
      const r = await api.copilotInteractive(currentSessionPath)
      continueInteractively(r?.cmd || `copilot --resume=${id}`, key)
    } catch {
      continueInteractively(`copilot --resume=${id}`, key)
    }
  }

  return (
    <div className="border-t border-border bg-background p-3">
      <div className="relative mx-auto max-w-3xl">
        {slashOpen && (
          <div className="absolute bottom-full left-0 z-30 mb-2 max-h-64 w-full overflow-auto rounded-md border border-border bg-popover p-1 shadow-md">
            {slashMatches.map((c, i) => (
              <button
                key={c.name}
                onMouseEnter={() => setSlashSel(i)}
                onClick={() => selectSlash(c.name)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                  i === slashSel && "bg-accent"
                )}
              >
                <span className="shrink-0 font-medium">/{c.name}</span>
                <span className="truncate text-xs text-muted-foreground">{c.description}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {c.source}
                  {c.interactive ? " · terminal only" : ""}
                </span>
              </button>
            ))}
          </div>
        )}
        <StatusLine />
        <QueueRow />

        {/* Full-width input box */}
        <div className="rounded-lg border border-input bg-transparent focus-within:ring-1 focus-within:ring-ring">
          <Textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (slashOpen) {
                if (e.key === "ArrowDown") {
                  e.preventDefault()
                  setSlashSel((s) => (s + 1) % slashMatches.length)
                  return
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault()
                  setSlashSel((s) => (s - 1 + slashMatches.length) % slashMatches.length)
                  return
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault()
                  selectSlash(slashMatches[slashSel].name)
                  return
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={
              viewOnly
                ? `Viewing ${agentLabel} — sending is read-only for now`
                : disabled
                ? "Load a session to chat"
                : chatRunning
                ? "Steer the current turn, or queue for the next…"
                : `Message ${agentLabel}…  (/ for commands, Enter to send)`
            }
            disabled={disabled}
            className="max-h-52 min-h-14 resize-none border-0 shadow-none focus-visible:ring-0"
          />
        </div>

        {/* Controls below the box */}
        <div className="mt-2 flex items-center justify-between gap-1">
          <div className="flex items-center gap-1">
            <StashButton
              text={text}
              onRestore={(s) => {
                setText(s)
                taRef.current?.focus()
              }}
              onStashCurrent={stashCurrent}
            />
            {isCopilot && currentSessionPath && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={openInteractive}
                title="Open this session in an interactive terminal — full slash commands, questions & tool approvals"
              >
                <Terminal className="size-3.5" /> Interactive
              </Button>
            )}
          </div>

          <div className="flex items-center gap-1">
            {chatRunning ? (
              <>
                {canSteer && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={steer}
                      disabled={!text.trim()}
                      title={`Inject into the current turn — ${agentLabel} picks it up between tool calls`}
                    >
                      <Zap className="size-3.5" /> Steer
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="gap-1.5"
                      onClick={send}
                      disabled={!text.trim()}
                      title="Queue for the next turn (or press Enter)"
                    >
                      <ListPlus className="size-3.5" /> Queue
                    </Button>
                  </>
                )}
                <Button size="sm" variant="destructive" onClick={interruptRun} title="Stop the run">
                  <Square className="size-3.5" />
                </Button>
              </>
            ) : (
              <>
                <Select value={permVal} onValueChange={setPermMode}>
                  <SelectTrigger size="sm" className={SELECT_TRIGGER}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {permModes.map((m) => (
                      <SelectItem key={m.v} value={m.v}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {showCustomModel ? (
                  <div className="flex items-center gap-1">
                    <input
                      autoFocus
                      value={model}
                      onChange={(e) => setModel(e.target.value.trim())}
                      placeholder="model id (e.g. claude-opus-4.8)"
                      title="Copilot model id — passed to --model"
                      className="h-7 w-48 rounded-md border border-input bg-transparent px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    <button
                      onClick={() => {
                        setCustomModel(false)
                        setModel("")
                      }}
                      className="text-muted-foreground hover:text-foreground"
                      title="Back to model list"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ) : (
                  <Select
                    value={modelVal}
                    onValueChange={(v) => {
                      if (v === CUSTOM_MODEL) {
                        setCustomModel(true)
                        setModel("")
                      } else {
                        setCustomModel(false)
                        setModel(v === "default" ? "" : v)
                      }
                    }}
                  >
                    <SelectTrigger size="sm" className={SELECT_TRIGGER}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      {models.map((m) => (
                        <SelectItem key={m.v} value={m.v}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button
                  size="sm"
                  className="ml-1 gap-1.5"
                  onClick={send}
                  disabled={disabled || !text.trim()}
                >
                  Send <Send className="size-3.5" />
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
