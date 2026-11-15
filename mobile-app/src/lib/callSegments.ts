/**
 * callSegments — what the call does with one call-brain answer.
 *
 * POST /api/call/turn and /api/call/next answer in one of two shapes:
 *   {audio, next}  the brain is SPEAKING (LFM3-Audio): stream segment `audio`,
 *                  then post `next` (with stop when the owner barged in).
 *   {reply}        a text answer (the Qwen brain, or LFM3 falling back) for TTS.
 * Pure, so the hook only wires it up.
 */
import type { CallHistory } from "../api/client"

export type CallAnswer = {
  reply?: string
  audio?: string
  next?: string
  /** /api/call/next only: the words the segment that just ended actually said. */
  said?: string
  /** Who answered, and why a stand-in did (absent from an older server). */
  served_by?: string
  fallback?: string
  history: CallHistory
  tools: string[]
}

export type CallStep =
  | { kind: "play"; audio: string; next: string }
  | { kind: "speak"; text: string }
  | { kind: "done" }

export function callStep(res: CallAnswer): CallStep {
  if (res.audio && res.next) return { kind: "play", audio: res.audio, next: res.next }
  const text = (res.reply || "").trim()
  return text ? { kind: "speak", text } : { kind: "done" }
}
