/** Canvas docs: what an agent shows (canvas_show) lands as a doc tile on the
 *  project canvas. Pure logic only — components/canvas/DocView renders it; the
 *  side-pane width helpers serve the "Needs you" pane (components/CanvasPane). */

export type CanvasKind = "markdown" | "mermaid" | "html" | "slides"
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

/** The pane's width bounds beside the chat (wide screens only; narrow screens use a full sheet). */
export const CANVAS_MIN_W = 280
/** The chat keeps at least this much room. */
export const CANVAS_CHAT_MIN_W = 360
/** Dragged narrower than this, the divider closes the pane instead of resizing it. */
export const CANVAS_CLOSE_W = 180

/** What a divider drag means: the width the pane takes (clamped), or "close" when the owner
 *  dragged it nearly shut. `width` is the viewport's right edge minus the pointer's x. */
export function canvasDragWidth(width: number, viewport: number): number | "close" {
  if (width < CANVAS_CLOSE_W) return "close"
  return Math.round(Math.max(CANVAS_MIN_W, Math.min(viewport - CANVAS_CHAT_MIN_W, width)))
}

/** A stored width, if it is a usable number; anything else falls back to the default layout. */
export function storedCanvasWidth(raw: string | null): number | null {
  const n = Number(raw)
  return raw && Number.isFinite(n) && n >= CANVAS_MIN_W ? Math.round(n) : null
}
