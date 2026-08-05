/**
 * bargeCommand — pure parser for spoken barge-in commands in call mode.
 *
 * During barge-in the user talks over Harman with the wake word "Harman" followed
 * by an instruction. This turns a raw transcript into a typed command so the call
 * state machine can act:
 *   - "Harman, stop"            → { kind: "stop" }        (halt speech, keep listening)
 *   - "Harman, end the call"    → { kind: "end" }         (hang up)
 *   - "Harman, what's the time" → { kind: "ask", tail }   (new turn with `tail`)
 *   - anything without the wake word (or wake word alone with no clear intent that
 *     isn't stop) → { kind: "none" }
 *
 * Pure (string in → command out) so the classification is unit-testable without
 * audio. STT is imperfect, so wake + keyword matching is fuzzy (edit-distance-ish
 * variants), mirroring the server's `_is_wake_token`.
 */

export type BargeCommand =
  | { kind: "none" }
  | { kind: "stop" }
  | { kind: "end" }
  | { kind: "ask"; tail: string }

/** Wake-word spellings STT commonly produces for "Harman". */
const WAKE_VARIANTS = ["harman", "harmon", "herman", "hardman", "harmony", "harmen"]

/** Phrases (after the wake word) that mean "stop talking". */
const STOP_PHRASES = ["stop", "stop it", "be quiet", "quiet", "shut up", "shush", "cancel", "nevermind", "never mind", "enough"]

/** Phrases that mean "end the call / hang up". */
const END_PHRASES = ["end the call", "end call", "hang up", "hangup", "hang up the call", "goodbye", "bye bye", "end the conversation", "stop the call"]

function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[.,!?;:'"()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Strip a leading wake word (with a following comma/space) if present. Returns
 *  { hadWake, tail } where tail is everything after the wake word. */
export function stripWake(text: string): { hadWake: boolean; tail: string } {
  const words = normalize(text).split(" ").filter(Boolean)
  if (!words.length) return { hadWake: false, tail: "" }
  // Wake word must be the first token (barge-in always leads with "Harman").
  if (WAKE_VARIANTS.includes(words[0])) {
    return { hadWake: true, tail: words.slice(1).join(" ") }
  }
  return { hadWake: false, tail: normalize(text) }
}

function matchesAny(tail: string, phrases: string[]): boolean {
  // Exact, or the tail STARTS WITH the phrase (e.g. "stop it now" matches "stop").
  return phrases.some((p) => tail === p || tail.startsWith(p + " "))
}

/**
 * Parse a transcript into a barge-in command. Requires the wake word to lead
 * (during barge-in the mic is hot while Harman speaks, so we only act on an
 * explicit "Harman …" to avoid false triggers on stray speech / residual echo).
 */
export function parseBargeCommand(text: string): BargeCommand {
  const { hadWake, tail } = stripWake(text)
  if (!hadWake) return { kind: "none" }
  return classifyTail(tail)
}

/**
 * Classify the command tail AFTER the wake word has already been stripped — used
 * for the server `/wakeguard` path, where the box returns `{wake:true, text:tail}`
 * with "Harman" already removed. `parseBargeCommand` (on-device path) strips the
 * wake word itself and then defers here, so both paths share one classifier.
 */
export function parseBargeTail(tail: string): BargeCommand {
  return classifyTail(normalize(tail))
}

function classifyTail(tail: string): BargeCommand {
  // Order matters: check END before STOP ("stop the call" is an end, and "stop"
  // alone is a stop). END phrases are checked first so multi-word intents win.
  if (matchesAny(tail, END_PHRASES)) return { kind: "end" }
  if (matchesAny(tail, STOP_PHRASES)) return { kind: "stop" }

  // Wake word alone (no tail) is treated as a stop — the user grabbed attention.
  if (!tail) return { kind: "stop" }

  // Otherwise it's a fresh question/instruction to run as a new turn.
  return { kind: "ask", tail }
}
