/** Canvas: the visual view an agent shows the owner (server: viewer/routes/canvas.py,
 *  MCP tool canvas_show). Pure logic only — CanvasScreen and the thread's chips wire it up.
 *  Mirrors web/src/lib/canvas.ts. */
import type { Block, ToolBlock } from "./thread"

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

/** Did a canvas_show tool result land? The MCP returns the server's JSON as
 *  text; a refusal carries `"error"`. No result yet = still running. */
export function showSucceeded(result: unknown, isError?: boolean): boolean {
  if (isError || result == null) return false
  const text = Array.isArray(result)
    ? result.map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text ?? "")).join("")
    : typeof result === "string" ? result : JSON.stringify(result)
  return /"shown"\s*:\s*true/.test(text) && !text.includes('"error"')
}

/** The titles this exchange's steps successfully showed, in order, each once. */
export function shownTitles(steps: Block[]): string[] {
  const out: string[] = []
  for (const b of steps) {
    if (b.kind !== "tool" || b.name !== CANVAS_SHOW_TOOL) continue
    const tb = b as ToolBlock
    const title = String((tb.input as { title?: unknown } | null)?.title ?? "").trim()
    if (title && showSucceeded(tb.result, tb.isError) && !out.includes(title)) out.push(title)
  }
  return out
}

export const KIND_LABEL: Record<CanvasKind, string> = {
  markdown: "Document",
  mermaid: "Diagram",
  html: "Interactive",
  slides: "Slides",
}

/** The agent's HTML with app-matching defaults: phone-width viewport, the app's
 *  font and colours, light/dark form controls. Inserted FIRST in <head> so any
 *  style the agent wrote still wins; never before a doctype (that would flip the
 *  page into quirks mode). */
export function themedHtml(content: string, theme: { bg: string; fg: string; dark: boolean }): string {
  const viewport = /<meta[^>]+name=["']?viewport/i.test(content)
    ? "" : '<meta name="viewport" content="width=device-width, initial-scale=1">'
  const base = `${viewport}<style>:root{color-scheme:${theme.dark ? "dark" : "light"}}` +
    `body{margin:16px;font:15px/1.5 system-ui,-apple-system,sans-serif;background:${theme.bg};color:${theme.fg}}</style>`
  const at = (re: RegExp) => {
    const m = re.exec(content)
    return m ? m.index + m[0].length : -1
  }
  let i = at(/<head\b[^>]*>/i)
  if (i < 0) i = at(/<html\b[^>]*>/i)
  if (i < 0) i = at(/<!doctype[^>]*>/i)
  if (i < 0) i = 0
  return content.slice(0, i) + base + content.slice(i)
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

/** A canvas as a note body: diagrams and pages keep their source in a fenced block. */
export function noteBody(c: Pick<Canvas, "kind" | "content">): string {
  if (c.kind === "mermaid") return "```mermaid\n" + c.content + "\n```"
  if (c.kind === "html") return "```html\n" + c.content + "\n```"
  return c.content
}

/** Appending a reply to whatever the owner already typed, never clobbering it. */
export function withReply(draft: string, reply: string): string {
  if (!draft.trim()) return reply
  return draft.replace(/\s+$/, "") + "\n" + reply
}

// A reply waiting for its thread: CanvasScreen queues it and goes back; the
// thread takes it when it regains focus. Keyed by session so a reply never
// lands in a different chat.
const pending = new Map<string, string>()
export function queueReply(session: string, text: string): void {
  if (session) pending.set(session, text)
}
export function takeReply(session: string): string | undefined {
  const v = pending.get(session)
  pending.delete(session)
  return v
}
