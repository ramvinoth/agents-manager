/**
 * callLab — pure logic for the web Voice Lab (compare call engines without a phone build).
 *
 * The call brain answers in one of two shapes (see mobile callSegments.ts):
 *   {audio, next}  the brain is SPEAKING: stream segment `audio`, then post `next`.
 *   {reply}        a text answer.
 * The lab times each turn, keeps owner feedback, and formats it as one note.
 */

export type LabEngine = { engine: string; model?: string }
export type LabVerdict = "up" | "down"

export type LabTurn = {
  id: number
  question: string
  /** ms from send to the first audible sound; null while waiting or for text answers. */
  ttfaMs: number | null
  /** ms from send to the answer being complete. */
  totalMs: number | null
  said: string
  tools: string[]
  interrupted: boolean
  verdict: LabVerdict | null
  note: string
}

export type LabAnswer = { audio?: string; next?: string; reply?: string; said?: string }

export type LabStep =
  | { kind: "play"; audio: string; next: string }
  | { kind: "text"; text: string }
  | { kind: "done" }

export function labStep(res: LabAnswer): LabStep {
  if (res.audio && res.next) return { kind: "play", audio: res.audio, next: res.next }
  const text = (res.reply || "").trim()
  return text ? { kind: "text", text } : { kind: "done" }
}

/** The phone's audio stream for one segment. */
export function audioUrl(path: string, id: string): string {
  return `/api/call/audio?path=${encodeURIComponent(path)}&id=${encodeURIComponent(id)}`
}

export function fmtMs(ms: number | null): string {
  if (ms == null) return "–"
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

export function emptyTurn(id: number, question: string): LabTurn {
  return { id, question, ttfaMs: null, totalMs: null, said: "", tools: [], interrupted: false, verdict: null, note: "" }
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Median time to first audio across turns that produced sound. */
export function medianTtfa(turns: LabTurn[]): number | null {
  return median(turns.flatMap((t) => (t.ttfaMs == null ? [] : [t.ttfaMs])))
}

export function labNoteTitle(e: LabEngine, when: Date): string {
  const model = e.model ? ` ${e.model}` : ""
  return `Voice Lab: ${e.engine}${model} ${when.toISOString().slice(0, 16).replace("T", " ")}`
}

/** One markdown note holding every turn, so two engines can be compared side by side later. */
export function labNoteBody(e: LabEngine, turns: LabTurn[]): string {
  const head = `Engine: ${e.engine}${e.model ? ` (${e.model})` : ""}\nMedian time to first audio: ${fmtMs(medianTtfa(turns))}\n`
  const rows = turns.map((t) => {
    const mark = t.verdict === "up" ? "👍" : t.verdict === "down" ? "👎" : "·"
    const flags = [t.interrupted ? "interrupted" : "", t.tools.length ? `tools: ${t.tools.join(", ")}` : ""].filter(Boolean).join("; ")
    const lines = [
      `${t.id}. ${mark} "${t.question}"`,
      `   first audio ${fmtMs(t.ttfaMs)}, done ${fmtMs(t.totalMs)}${flags ? `; ${flags}` : ""}`,
    ]
    if (t.said) lines.push(`   said: ${t.said}`)
    if (t.note.trim()) lines.push(`   note: ${t.note.trim()}`)
    return lines.join("\n")
  })
  return `${head}\n${rows.join("\n\n")}\n`
}
