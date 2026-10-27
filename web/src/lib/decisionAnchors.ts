/**
 * Which chat message raised an open decision — so the canvas "Needs you" list
 * can jump to it the way a Sift excerpt jumps to its passage.
 *
 * Questions, plans and tool approvals carry the tool_use id of the call that
 * raised them. A card is found by the latest card tool call naming it (a move
 * or comment), else the card_create whose result returned its id. A Red org
 * approval is found by the tool result that quoted its id. Anything else —
 * a card the owner made by hand, or a message not in loaded history — is null.
 *
 * Loaded history is only the tail of a long chat, so findKey names the same
 * call for the server's backward scan (?find=), and callSaid is what to show
 * when that call is too far up to page in.
 */
import type { OpenDecision, ToolUseBlock, Turn } from "./types"

function toolCalls(turns: Turn[]): { domId: string; b: ToolUseBlock }[] {
  const out: { domId: string; b: ToolUseBlock }[] = []
  for (const t of turns) {
    if (t.type !== "assistant") continue
    for (const b of t.blocks) if (b.type === "tool_use") out.push({ domId: t.domId, b })
  }
  return out
}

/** A tool result as plain text: a string, or the text parts of a content array. */
export function resultText(r: unknown): string {
  if (typeof r === "string") return r
  if (Array.isArray(r)) return r.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("\n")
  return ""
}

const isTool = (name: string, tool: string) => name === tool || name.endsWith("__" + tool)

export function anchorFor(d: OpenDecision, turns: Turn[]): string | null {
  const calls = toolCalls(turns)
  if (d.kind === "question" || d.kind === "plan" || d.kind === "approval") {
    if (!d.tool_use_id) return null
    return calls.find((c) => c.b.id === d.tool_use_id)?.domId ?? null
  }
  if (d.kind === "card") {
    const id = Number(d.card)
    if (!id) return null
    for (let i = calls.length - 1; i >= 0; i--) {
      const { b } = calls[i]
      if ((isTool(b.name, "card_move") || isTool(b.name, "card_comment")) && Number((b.input as any)?.card_id) === id)
        return calls[i].domId
    }
    const made = new RegExp(`"id"\\s*:\\s*${id}(?!\\d)`)
    return calls.find((c) => isTool(c.b.name, "card_create") && made.test(resultText(c.b.result)))?.domId ?? null
  }
  if (d.kind === "red") {
    if (!d.id) return null
    const ref = String(d.id)
    for (let i = calls.length - 1; i >= 0; i--) if (resultText(calls[i].b.result).includes(ref)) return calls[i].domId
  }
  return null
}

/** A tool call the server found in the transcript (GET /api/session/…?find=). */
export interface FoundCall {
  offset: number
  timestamp?: string
  name: string
  input: any
}

/** The server-side ?find= key for a decision, or null when only the loaded turns can anchor it. */
export function findKey(d: OpenDecision): string | null {
  if (d.kind === "card") return Number(d.card) ? `card:${Number(d.card)}` : null
  if (d.kind === "question" || d.kind === "plan" || d.kind === "approval") return d.tool_use_id ? `tool:${d.tool_use_id}` : null
  return null
}

/** One line on what a found call said, for when it is too far back to scroll to. */
export function callSaid(c: FoundCall): string {
  const i = c.input || {}
  // A created card's title is its question; its body is the long context behind it.
  const text = (isTool(c.name, "card_create") ? i.title : undefined) ?? i.body ?? i.questions?.[0]?.question ?? i.plan ?? i.title ?? i.command ?? i.description
  if (typeof text === "string" && text.trim()) return text.trim()
  if (isTool(c.name, "card_move")) return "Moved the card."
  return c.name.replace(/^mcp__[^_]+__/, "")
}
