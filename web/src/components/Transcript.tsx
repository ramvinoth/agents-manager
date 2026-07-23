import { useMemo } from "react"
import { Wrench, User, Bot, Terminal as TerminalIcon, ChevronDown } from "lucide-react"
import { renderMarkdown } from "@/lib/markdown"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useStore, useAgentLabel } from "@/store"
import { AuqBlock } from "./AuqBlock"
import { MessageActions } from "./MessageActions"
import type { AssistantTurn, Block, Turn } from "@/lib/types"

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className="markdown-content" dangerouslySetInnerHTML={{ __html: html }} />
}

function toText(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  if (Array.isArray(v))
    return v
      .map((b: any) => (typeof b === "string" ? b : b?.text ?? JSON.stringify(b)))
      .join("\n")
  return JSON.stringify(v, null, 2)
}

function ToolCall({ block }: { block: Extract<Block, { type: "tool_use" }> }) {
  const result = toText(block.result)
  return (
    <details className="group rounded-md border border-border bg-muted/40 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
        <Wrench className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{block.name}</span>
        <ChevronDown className="ml-auto size-3.5 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-2 border-t border-border px-3 py-2">
        {block.input != null && (
          <pre className="overflow-x-auto rounded bg-background/60 p-2 font-mono text-xs text-muted-foreground">
            {typeof block.input === "string" ? block.input : JSON.stringify(block.input, null, 2)}
          </pre>
        )}
        {result && (
          <pre className="max-h-80 overflow-auto rounded bg-background/60 p-2 font-mono text-xs">
            {result.length > 4000 ? result.slice(0, 4000) + "\n… (truncated)" : result}
          </pre>
        )}
      </div>
    </details>
  )
}

function AssistantBlocks({ turn }: { turn: AssistantTurn }) {
  const showTools = useStore((s) => s.visible.tools)
  const blocks = showTools ? turn.blocks : turn.blocks.filter((b) => b.type === "text")
  return (
    <div className="space-y-2">
      {blocks.map((b, i) =>
        b.type === "text" ? (
          <Markdown key={i} text={b.text} />
        ) : b.name === "AskUserQuestion" ? (
          <AuqBlock key={i} block={b} />
        ) : (
          <ToolCall key={i} block={b} />
        )
      )}
    </div>
  )
}

function TurnRow({ turn }: { turn: Turn }) {
  const agentLabel = useAgentLabel()
  const currentAgent = useStore((s) => s.currentAgent)
  const currentHost = useStore((s) => s.currentHost)
  // Fork/restore work for Claude (local or remote) and local Codex; other
  // agents / remote Codex stay view-only.
  const canEdit = currentAgent === "claude" || (currentAgent === "codex" && currentHost === "local")
  if (turn.type === "user") {
    return (
      <div className="group flex justify-end">
        <div className="max-w-[85%] rounded-lg border border-border bg-card px-4 py-2.5 shadow-xs">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <User className="size-3" /> You
            {canEdit && turn.uuid && <MessageActions uuid={turn.uuid} />}
          </div>
          <Markdown text={turn.content} />
        </div>
      </div>
    )
  }
  if (turn.type === "assistant") {
    return (
      <div className="flex gap-3">
        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Bot className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{agentLabel}</span>
            {turn.model && (
              <span className="font-mono">{turn.model.replace("claude-", "")}</span>
            )}
          </div>
          <AssistantBlocks turn={turn} />
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-2 text-xs text-muted-foreground">
      <TerminalIcon className="mt-0.5 size-3 shrink-0" />
      <span className="whitespace-pre-wrap">{turn.content}</span>
    </div>
  )
}

export function Transcript({
  turns,
  highlightId,
  className,
}: {
  turns: Turn[]
  highlightId?: string
  className?: string
}) {
  const visible = useStore((s) => s.visible)
  const shown = turns.filter((t) => {
    if (t.type === "user") return visible.user
    if (t.type === "system") return visible.system
    if (t.type === "assistant") {
      if (!visible.assistant) return false
      // hide tool-only assistant turns when tools are hidden
      if (!visible.tools && !t.blocks.some((b) => b.type === "text")) return false
      return true
    }
    return true
  })
  if (!shown.length) {
    return (
      <div className={cn("flex h-full items-center justify-center text-sm text-muted-foreground", className)}>
        {turns.length ? "No messages match the current filter." : "No messages in this session."}
      </div>
    )
  }
  return (
    <div className={cn("mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6", className)}>
      {shown.map((t) => (
        <div
          key={t.domId}
          id={`turn-${t.domId}`}
          className={cn(
            "scroll-mt-6 rounded-lg transition-shadow",
            t.domId === highlightId && "ring-2 ring-primary ring-offset-4 ring-offset-background"
          )}
        >
          <TurnRow turn={t} />
        </div>
      ))}
      <div className="pt-2 text-center">
        <Badge variant="outline" className="text-muted-foreground">
          {turns.length} turns
        </Badge>
      </div>
    </div>
  )
}
