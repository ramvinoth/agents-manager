/** Canvas links back to their source: a shape whose link is harman://card/12,
 *  harman://note/3, harman://inbox/<session> or harman://sift/<doc> opens that thing in the app instead of navigating.
 *  The kinds match the server's REF_RE (orchestrator/canvas_summary.py). */

export type CanvasRefKind = "card" | "note" | "inbox" | "sift"
export type CanvasRef = { kind: CanvasRefKind; id: string }

const REF = /^harman:\/\/(card|note|inbox|sift)\/(.+)$/
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
