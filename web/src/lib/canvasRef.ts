/** Canvas links back to their source: a shape whose link is agents://card/12,
 *  agents://note/3, agents://inbox/<session>, agents://sift/<doc> or
 *  agents://code/<path> opens that thing in the app instead of navigating.
 *  The kinds match the server's REF_RE (viewer/canvas_summary.py). */

export type CanvasRefKind = "card" | "note" | "inbox" | "sift" | "code"
export type CanvasRef = { kind: CanvasRefKind; id: string }

const REF = /^agents:\/\/(card|note|inbox|sift|code)\/(.+)$/
const INT_KINDS = new Set(["card", "note"])

export function parseCanvasRef(link?: string | null): CanvasRef | null {
  const m = REF.exec((link ?? "").trim())
  if (!m) return null
  let id: string
  try {
    id = decodeURIComponent(m[2])
  } catch {
    return null
  }
  if (INT_KINDS.has(m[1]) && !/^\d+$/.test(id)) return null
  return { kind: m[1] as CanvasRefKind, id }
}
