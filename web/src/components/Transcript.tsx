import { useMemo } from "react"
import { Wrench, User, Bot, Terminal as TerminalIcon, ChevronDown, AlertTriangle } from "lucide-react"
import { renderMarkdownSegments } from "@/lib/markdown"
import { splitThinking } from "@/lib/thinking"
import { MermaidDiagram } from "./MermaidDiagram"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useStore, useAgentLabel } from "@/store"
import { AuqBlock } from "./AuqBlock"
import { MessageActions } from "./MessageActions"
import { extractImages } from "@/lib/parser"
import type { AssistantTurn, Block, ImagePart, Turn } from "@/lib/types"

function Markdown({ text }: { text: string }) {
  // Split into segments so ```mermaid fences render as React-owned <MermaidDiagram>
  // components (SVG in state) instead of imperatively-injected SVG inside
  // dangerouslySetInnerHTML — the latter was wiped by every streaming re-render /
  // poll / scroll, causing the diagram to flicker and reset to code.
  const dark = document.documentElement.classList.contains("dark")
  const segments = useMemo(() => renderMarkdownSegments(text), [text])
  return (
    <div className="markdown-content">
      {segments.map((seg, i) =>
        seg.type === "mermaid" ? (
          <MermaidDiagram key={i} source={seg.source} dark={dark} />
        ) : (
          <div key={i} dangerouslySetInnerHTML={{ __html: seg.html }} />
        )
      )}
    </div>
  )
}

function Images({ images }: { images: ImagePart[] }) {
  if (!images.length) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {images.map((img, i) => (
        <img
          key={i}
          src={`data:${img.mime};base64,${img.data}`}
          loading="lazy"
          className="max-h-80 max-w-full rounded-md border border-border object-contain"
        />
      ))}
    </div>
  )
}

function toText(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  if (Array.isArray(v))
    return v
      .map((b: any) => {
        if (typeof b === "string") return b
        if (b?.type === "image") return "" // rendered separately as an <img>
        return b?.text ?? JSON.stringify(b)
      })
      .filter(Boolean)
      .join("\n")
  return JSON.stringify(v, null, 2)
}

function ToolCall({ block }: { block: Extract<Block, { type: "tool_use" }> }) {
  const result = toText(block.result)
  const images = extractImages(block.result)
  const isError = !!block.isError
  return (
    <div className="space-y-1.5">
      <details
        className={cn(
          "group rounded-md border text-sm",
          isError ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/40"
        )}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
          {isError ? (
            <AlertTriangle className="size-3.5 text-destructive" />
          ) : (
            <Wrench className="size-3.5 text-muted-foreground" />
          )}
          <span className={cn("font-medium", isError && "text-destructive")}>{block.name}</span>
          {isError && (
            <Badge variant="destructive" className="h-4 px-1.5 text-[10px] font-normal">
              error
            </Badge>
          )}
          <ChevronDown className="ml-auto size-3.5 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className={cn("space-y-2 border-t px-3 py-2", isError ? "border-destructive/30" : "border-border")}>
          {block.input != null && (
            <pre className="overflow-x-auto rounded bg-background/60 p-2 font-mono text-xs text-muted-foreground">
              {typeof block.input === "string" ? block.input : JSON.stringify(block.input, null, 2)}
            </pre>
          )}
          {result && (
            <pre
              className={cn(
                "max-h-80 overflow-auto rounded p-2 font-mono text-xs",
                isError ? "bg-destructive/10 text-destructive" : "bg-background/60"
              )}
            >
              {result.length > 4000 ? result.slice(0, 4000) + "\n… (truncated)" : result}
            </pre>
          )}
        </div>
      </details>
      {/* Images render OUTSIDE the collapsible details so screenshots are always
          visible without expanding the tool-call. */}
      <Images images={images} />
    </div>
  )
}

function blockHasImages(b: Block): boolean {
  return b.type === "tool_use" && extractImages(b.result).length > 0
}

// Some models (Qwen3) emit inline <think>…</think> reasoning before the answer.
// Render it as a collapsed <details> and show only the reply body by default.
function TextBlock({ text }: { text: string }) {
  const { thinking, body } = useMemo(() => splitThinking(text), [text])
  return (
    <>
      {thinking && (
        <details className="mb-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs">
          <summary className="cursor-pointer select-none italic text-muted-foreground">Thinking</summary>
          <div className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-2 text-muted-foreground">
            {thinking}
          </div>
        </details>
      )}
      {body && <Markdown text={body} />}
    </>
  )
}

function AssistantBlocks({ turn }: { turn: AssistantTurn }) {
  const showTools = useStore((s) => s.visible.tools)
  // Even with the Tools filter off, keep tool-calls that carry images (e.g.
  // screenshots) so they don't vanish — the image renders, the details stay
  // collapsed.
  const blocks = showTools
    ? turn.blocks
    : turn.blocks.filter((b) => b.type === "text" || blockHasImages(b))
  return (
    <div className="space-y-2">
      {blocks.map((b, i) =>
        b.type === "text" ? (
          <TextBlock key={i} text={b.text} />
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
          {turn.content && <Markdown text={turn.content} />}
          {turn.images?.length ? <Images images={turn.images} /> : null}
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
