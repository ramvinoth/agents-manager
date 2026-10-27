/**
 * bargeCommand — pure classifier for spoken barge-in commands in call mode.
 *
 * During barge-in the user talks over Harman with the wake word "Harman" followed
 * by an instruction. The server's `/wakeguard` keyword-spotter detects the wake
 * word (fuzzy, `_is_wake_token`) and returns the tail after it; this turns that
 * tail into a typed command so the call state machine can act:
 *   - "stop"              → { kind: "stop" }   (halt speech, keep listening)
 *   - "end the call"      → { kind: "end" }    (hang up)
 *   - "what's the time"   → { kind: "ask", tail } (new turn with `tail`)
 *   - ""  (wake word alone) → { kind: "stop" }
 *
 * Pure (string in → command out) so the classification is unit-testable without audio.
 */
export type BargeCommand =
  | { kind: "stop" }
  | { kind: "end" }
  | { kind: "ask"; tail: string }

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

function matchesAny(tail: string, phrases: string[]): boolean {
  // Exact, or the tail STARTS WITH the phrase (e.g. "stop it now" matches "stop").
  return phrases.some((p) => tail === p || tail.startsWith(p + " "))
}

/** Classify the tail the server returns as `{wake:true, text:tail}` ("Harman" already removed). */
export function parseBargeTail(raw: string): BargeCommand {
  const tail = normalize(raw)
  // Order matters: check END before STOP ("stop the call" is an end, and "stop"
  // alone is a stop). END phrases are checked first so multi-word intents win.
  if (matchesAny(tail, END_PHRASES)) return { kind: "end" }
  if (matchesAny(tail, STOP_PHRASES)) return { kind: "stop" }

  // Wake word alone (no tail) is treated as a stop — the user grabbed attention.
  if (!tail) return { kind: "stop" }

  // Otherwise it's a fresh question/instruction to run as a new turn.
  return { kind: "ask", tail }
}
