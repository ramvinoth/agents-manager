/** The call's running transcript: every turn, both sides, in order. Pure so it is
 *  unit-tested without a simulator; the call screen only renders it. */

export type ReplyMeta = {
  /** The model that actually produced this reply (server-reported, never guessed). */
  servedBy?: string
  /** Why a different model than planned answered, when one did. */
  fallback?: string
}

export type TranscriptLine = ReplyMeta & {
  id: number
  who: "you" | "harman"
  text: string
}

const MAX_LINES = 200

export function addLine(
  lines: TranscriptLine[],
  who: TranscriptLine["who"],
  text: string,
  meta: ReplyMeta = {}
): TranscriptLine[] {
  const clean = text.trim()
  if (!clean) return lines
  const id = (lines.length ? lines[lines.length - 1].id : 0) + 1
  const line: TranscriptLine = { id, who, text: clean }
  if (meta.servedBy) line.servedBy = meta.servedBy
  if (meta.fallback) line.fallback = meta.fallback
  return [...lines, line].slice(-MAX_LINES)
}

/** The brain label: who answered the latest reply, else the engine the server
 *  announced at call start. An old server sends no served_by, so this degrades
 *  to the engine name rather than inventing one. */
export function brainLabel(engineModel: string | null, lines: TranscriptLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].who === "harman" && lines[i].servedBy) return lines[i].servedBy!
  }
  return engineModel === null ? null : engineModel || "call brain"
}

/** The fallback warning for the latest reply, if that reply was a fallback. */
export function latestFallback(lines: TranscriptLine[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].who === "harman") return lines[i].fallback || ""
  }
  return ""
}
