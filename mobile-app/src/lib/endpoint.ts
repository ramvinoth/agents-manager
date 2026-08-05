/**
 * endpoint — pure endpointing decision for the hands-free listen loop.
 *
 * "Endpointing" = deciding when the speaker has FINISHED talking. The old loop
 * used a fixed 2.5s window, which cut people off mid-sentence and had no notion of
 * a natural pause. This replaces the fixed timer with a silence-hang rule: once we
 * have heard speech, we keep recording until ~`silenceHangMs` of continuous
 * below-floor audio, then stop — so pauses shorter than the hang are tolerated and
 * a long request is captured whole.
 *
 * It's pure (loudness samples in → a verdict out) so the timing logic is
 * unit-testable without a recorder. The real recorder feeds it metering frames.
 */
export interface EndpointOptions {
  /** dBFS floor below which a frame counts as silence (e.g. -45). */
  floorDb: number
  /** Stop after this much continuous trailing silence once speech was heard. */
  silenceHangMs: number
  /** Hard cap: stop no matter what after this long (runaway guard). */
  maxMs: number
  /** If NO speech is heard by this time, give up and report the window silent. */
  noSpeechTimeoutMs: number
}

export interface EndpointState {
  /** Whether we've heard any above-floor frame yet this window. */
  heardSpeech: boolean
  /** Timestamp (ms, monotonic) of the last above-floor frame, or -1 if none. */
  lastLoudMs: number
}

export type EndpointVerdict =
  | { done: false }
  | { done: true; reason: "endpoint" | "max" | "no-speech" }

/** Fold one metering frame into the state. `db` is the frame loudness (dBFS),
 *  `nowMs` a monotonic timestamp for that frame. */
export function observeFrame(
  state: EndpointState,
  db: number,
  nowMs: number,
  floorDb: number
): EndpointState {
  if (db >= floorDb) {
    return { heardSpeech: true, lastLoudMs: nowMs }
  }
  return state
}

/**
 * Decide whether to stop recording, given the current state and elapsed time.
 *  - Before any speech: stop (silent) only once we pass `noSpeechTimeoutMs`.
 *  - After speech: stop when the gap since the last loud frame exceeds
 *    `silenceHangMs`, or when we hit the hard `maxMs` cap.
 */
export function endpointVerdict(
  state: EndpointState,
  elapsedMs: number,
  nowMs: number,
  opts: EndpointOptions
): EndpointVerdict {
  if (!state.heardSpeech) {
    if (elapsedMs >= opts.noSpeechTimeoutMs) return { done: true, reason: "no-speech" }
    return { done: false }
  }
  if (elapsedMs >= opts.maxMs) return { done: true, reason: "max" }
  const silentFor = nowMs - state.lastLoudMs
  if (silentFor >= opts.silenceHangMs) return { done: true, reason: "endpoint" }
  return { done: false }
}
