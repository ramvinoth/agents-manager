/** Canvas: the on-demand visual pane an agent opens beside the chat.
 *  Pure logic only — the pane (components/CanvasPane) and slice (store/canvas) wire it up. */
import type { Turn } from "./types"

export type CanvasKind = "markdown" | "mermaid" | "html" | "slides"
export interface CanvasMeta {
  title: string
  kind: CanvasKind
  version: number
  size: number
  updated_at: number
}
export interface Canvas extends CanvasMeta {
  content: string
}

/** The MCP tool name as it appears in a transcript's tool_use block. */
export const CANVAS_SHOW_TOOL = "mcp__viewer__canvas_show"

export interface CanvasShow {
  /** The tool_use id — the identity of one show, so a re-render never re-fires it. */
  id: string
  title: string
  /** False while the call is in flight or when the server refused it. */
  ok: boolean
}

/** Every canvas_show the agent made in these turns, oldest first. */
export function canvasShows(turns: Turn[]): CanvasShow[] {
  const out: CanvasShow[] = []
  for (const t of turns) {
    if (t.type !== "assistant") continue
    for (const b of t.blocks) {
      if (b.type !== "tool_use" || b.name !== CANVAS_SHOW_TOOL) continue
      const title = String((b.input as { title?: unknown } | null)?.title ?? "").trim()
      out.push({ id: b.id, title, ok: showSucceeded(b.result, b.isError) })
    }
  }
  return out
}

/** Did a canvas_show tool result land? The MCP returns the server's JSON as
 *  text; a refusal carries `"error"`. No result yet = still running. */
export function showSucceeded(result: unknown, isError?: boolean): boolean {
  if (isError || result == null) return false
  const text = Array.isArray(result)
    ? result.map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text ?? "")).join("")
    : typeof result === "string" ? result : JSON.stringify(result)
  return /"shown"\s*:\s*true/.test(text) && !text.includes('"error"')
}

/** The newest successful show, or null. */
export function latestShow(turns: Turn[]): CanvasShow | null {
  const shows = canvasShows(turns)
  for (let i = shows.length - 1; i >= 0; i--) if (shows[i].ok) return shows[i]
  return null
}

/** Slides are markdown split on a line holding only `---` (code fences kept whole). */
export function splitSlides(content: string): string[] {
  const slides: string[] = []
  let cur: string[] = []
  let fence = false
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (!fence && /^\s*---\s*$/.test(line)) {
      slides.push(cur.join("\n"))
      cur = []
    } else cur.push(line)
  }
  slides.push(cur.join("\n"))
  const kept = slides.map((s) => s.trim()).filter(Boolean)
  return kept.length ? kept : [""]
}

/** The text a "Reply" drops into the composer: it names the canvas so the agent
 *  knows which view the owner is answering. */
export function replyDraft(c: Pick<CanvasMeta, "title" | "version">, slide?: { index: number; count: number }): string {
  const where = slide && slide.count > 1 ? `, slide ${slide.index + 1} of ${slide.count}` : ""
  return `About the canvas "${c.title}" (v${c.version}${where}): `
}
