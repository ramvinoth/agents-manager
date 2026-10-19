import { useMemo, useState } from "react"
import { Wrench, User, Bot, Terminal as TerminalIcon, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react"
import { splitThinking } from "@/lib/thinking"
import { Markdown } from "./Markdown"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useStore, useAgentLabel } from "@/store"
import { AuqBlock } from "./AuqBlock"
import { PlanBlock } from "./PlanBlock"
import { MessageActions } from "./MessageActions"
import { Collapsible } from "./Collapsible"
import { extractImages } from "@/lib/parser"
import { ZoomViewer } from "./ZoomViewer"
import { groupExchanges, stepsLabel, type Exchange } from "@/lib/exchange"
import type { Block, ImagePart, SystemTurn, Turn, UserTurn } from "@/lib/types"

// Click an image (a screenshot, a Read of a .png) to open it full screen with pan/zoom.
function Images({ images }: { images: ImagePart[] }) {
  const [openAt, setOpenAt] = useState<number | null>(null)
  if (!images.length) return null
  const src = (img: ImagePart) => `data:${img.mime};base64,${img.data}`
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {images.map((img, i) => (
        <button key={i} type="button" className="chat-image" title="Open full screen to zoom" onClick={() => setOpenAt(i)}>
          <img src={src(img)} loading="lazy" alt="" className="max-h-80 max-w-full rounded-md border border-border object-contain" />
        </button>
      ))}
      {openAt != null && images[openAt] && (
        <ZoomViewer source={{ src: src(images[openAt]) }} open onOpenChange={(o) => { if (!o) setOpenAt(null) }} />
      )}
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
function TextBlock({ text, live }: { text: string; live?: boolean }) {
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
      {/* The turn still being streamed is never collapsed: its text is still
          growing, and a bubble that folded itself shut mid-stream would hide the
          very output the reader is watching. */}
      {body &&
        (live ? (
          <Markdown text={body} />
        ) : (
          <Collapsible text={body}>{(shown) => <Markdown text={shown} />}</Collapsible>
        ))}
    </>
  )
}

/** One block of an exchange: text, a surfaced question/plan card, or a tool call. */
function BlockView({ block, live }: { block: Block; live?: boolean }) {
  if (block.type === "text") return <TextBlock text={block.text} live={live} />
  if (block.name === "AskUserQuestion") return <AuqBlock block={block} />
  if (block.name === "ExitPlanMode") return <PlanBlock block={block} />
  return <ToolCall block={block} />
}

/** What an exchange shows with the Tools filter off: narration and image-bearing calls only. */
function visibleSteps(ex: Exchange, showTools: boolean): Block[] {
  return showTools ? ex.steps : ex.steps.filter((b) => b.type === "text" || blockHasImages(b))
}

/**
 * One agent reply: every API turn of the run folded into a single message, like
 * the mobile thread. The work (tool calls + narration) sits behind an "N steps"
 * toggle above the answer — open on the latest reply (and while a search hit is
 * in it), collapsed on older ones so scrolling history reads as answers.
 */
function ExchangeRow({ ex, latest, live, highlighted }: { ex: Exchange; latest: boolean; live: boolean; highlighted: boolean }) {
  const agentLabel = useAgentLabel()
  const showTools = useStore((s) => s.visible.tools)
  const [open, setOpen] = useState<boolean | null>(null)
  const isOpen = open ?? (latest || highlighted)
  const steps = visibleSteps(ex, showTools)
  // Tools hidden: no toggle, just the narration and screenshots inline.
  const toggle = showTools && steps.length > 0
  const stepImages = useMemo(() => ex.steps.flatMap((b) => (b.type === "tool_use" ? extractImages(b.result) : [])), [ex.steps])
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Bot className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{agentLabel}</span>
          {ex.model && <span className="font-mono">{ex.model.replace("claude-", "")}</span>}
        </div>
        {toggle ? (
          <div>
            <button
              type="button"
              onClick={() => setOpen(!isOpen)}
              aria-expanded={isOpen}
              data-track="steps toggle"
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-accent"
            >
              <ChevronRight className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} />
              {stepsLabel(ex.steps)}
            </button>
            {isOpen ? (
              <div className="mt-1.5 space-y-2 border-l-2 border-border pl-3">
                {steps.map((b, i) => (
                  <BlockView key={i} block={b} />
                ))}
              </div>
            ) : (
              // Screenshots stay on screen even with the steps folded away.
              <Images images={stepImages} />
            )}
          </div>
        ) : (
          steps.map((b, i) => <BlockView key={i} block={b} />)
        )}
        {ex.surfaced.map((b, i) => (
          <BlockView key={"s" + i} block={b} />
        ))}
        {ex.answer.map((b, i) => (
          <BlockView key={"a" + i} block={b} live={live} />
        ))}
      </div>
    </div>
  )
}

function TurnRow({ turn }: { turn: UserTurn | SystemTurn }) {
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
          {turn.content && (
            <Collapsible text={turn.content} fadeTo="var(--card)">
              {(shown) => <Markdown text={shown} />}
            </Collapsible>
          )}
          {turn.images?.length ? <Images images={turn.images} /> : null}
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
  const chatRunning = useStore((s) => s.chatRunning)
  // Tool-only turns are NOT dropped here even with the Tools filter off: they
  // belong to an exchange, which keeps their screenshots (see visibleSteps).
  const shown = useMemo(
    () =>
      turns.filter((t) =>
        t.type === "user" ? visible.user : t.type === "system" ? visible.system : visible.assistant
      ),
    [turns, visible.user, visible.system, visible.assistant]
  )
  const items = useMemo(() => groupExchanges(shown), [shown])
  // An exchange with nothing left to show (tool-only, Tools filter off) takes no row.
  const rows = items.filter(
    (it) =>
      it.type !== "exchange" ||
      it.answer.length > 0 ||
      it.surfaced.length > 0 ||
      visibleSteps(it, visible.tools).length > 0
  )
  if (!rows.length) {
    return (
      <div className={cn("flex h-full items-center justify-center text-sm text-muted-foreground", className)}>
        {turns.length ? "No messages match the current filter." : "No messages in this session."}
      </div>
    )
  }
  const lastExchange = rows.findLastIndex((it) => it.type === "exchange")
  return (
    <div className={cn("mx-auto flex max-w-3xl flex-col gap-8 px-4 py-6", className)}>
      {rows.map((it, i) => {
        const ids = it.type === "exchange" ? it.memberIds : [it.domId]
        const highlighted = !!highlightId && ids.includes(highlightId)
        return (
          <div
            key={it.domId}
            id={`turn-${it.domId}`}
            className={cn(
              "scroll-mt-6 rounded-lg transition-shadow",
              highlighted && "ring-2 ring-primary ring-offset-4 ring-offset-background"
            )}
          >
            {/* Search scrolls to "turn-<id>" of ANY member turn; the folded
                ones keep an anchor here. */}
            {ids.slice(1).map((id) => (
              <span key={id} id={`turn-${id}`} className="block scroll-mt-6" />
            ))}
            {it.type === "exchange" ? (
              // Only the last reply can still be growing, and only while the
              // agent is running — that one renders uncollapsed.
              <ExchangeRow
                ex={it}
                latest={i === lastExchange}
                live={chatRunning && i === rows.length - 1}
                highlighted={highlighted}
              />
            ) : (
              <TurnRow turn={it} />
            )}
          </div>
        )
      })}
      <div className="pt-2 text-center">
        <Badge variant="outline" className="text-muted-foreground">
          {turns.length} turns
        </Badge>
      </div>
    </div>
  )
}
