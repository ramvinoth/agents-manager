/** Canvas chips in a thread: which canvas_show calls this turn landed on the
 *  project canvas (server: viewer canvas_show makes each one a doc tile).
 *  Pure logic only — ThreadItems wires the chips to CanvasScreen. */
import type { Block, ToolBlock } from "./thread"

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
