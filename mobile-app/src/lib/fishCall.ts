/**
 * fishCall — phone side of the server's live call bridge (/api/call/live).
 *
 * One WebSocket carries everything: mic PCM16 16 kHz up, TTS PCM16 up-rate down,
 * plus small JSON events. The server's live engine (Fish, or the Speakrail box's
 * LFM3/Breeze) does the ASR, turn detection and TTS; the phone only captures,
 * plays, and tells the server when playback has drained.
 * Speech and tool work run concurrently server-side, so the caller can keep talking
 * while a tool runs. Capture and playback share one echo-cancelled engine, which is
 * why barge-in works without a keyword spotter.
 *
 * Pure of React and native modules: the socket and audio engine are injected so the
 * protocol is unit-tested without a simulator.
 */
import { fromBase64, toBase64 } from "./bytes.ts"
import type { ReplyMeta } from "./callTranscript.ts"

export type FishPhase = "waiting" | "thinking" | "speaking"

export interface FishSocket {
  readonly readyState: number
  binaryType: string
  send(data: string | ArrayBuffer | Uint8Array): void
  close(code?: number): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: { message?: string }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
}

export interface FishAudio {
  start(sampleRate: number): Promise<void>
  stop(): Promise<void>
  onFrame(cb: (pcmBase64: string) => void): () => void
  onDrained(cb: () => void): () => void
  enqueue(pcmBase64: string, sampleRate: number): boolean
  flush(): void
}

export interface FishHandlers {
  onPhase(phase: FishPhase): void
  onHeard(text: string): void
  onReply(text: string, meta?: ReplyMeta): void
  /** The call ended on its own (server error or socket drop), not via stop(). */
  onFailed(message: string): void
}

export const MIC_RATE = 16000
export const PING_MS = 20000
const OPEN = 1

/** A parsed server event, or null for anything we do not understand. */
export type FishEvent =
  | { type: "ready"; sampleRate: number }
  | { type: "heard"; text: string }
  | ({ type: "reply"; text: string } & ReplyMeta)
  | { type: "audio_end"; gen: number | null }
  | { type: "barge" | "pong" }
  | { type: "error"; message: string }

export function parseFishEvent(raw: unknown): FishEvent | null {
  if (typeof raw !== "string") return null
  let m: Record<string, unknown>
  try {
    m = JSON.parse(raw)
  } catch {
    return null
  }
  switch (m?.type) {
    case "ready":
      return { type: "ready", sampleRate: Number(m.sample_rate) || 24000 }
    case "heard":
      return { type: "heard", text: String(m.text ?? "") }
    case "reply":
      return {
        type: "reply",
        text: String(m.text ?? ""),
        ...(typeof m.served_by === "string" && m.served_by ? { servedBy: m.served_by } : {}),
        ...(typeof m.fallback === "string" && m.fallback ? { fallback: m.fallback } : {}),
      }
    case "audio_end":
      return { type: "audio_end", gen: typeof m.gen === "number" ? m.gen : null }
    case "barge":
    case "pong":
      return { type: m.type }
    case "error":
      return { type: "error", message: String(m.message || "The call failed.") }
    default:
      return null
  }
}

export interface FishCall {
  stop(): Promise<void>
}

export async function startFishCall(
  socket: FishSocket,
  audio: FishAudio,
  history: unknown[],
  h: FishHandlers,
  timers: { setInterval: typeof setInterval; clearInterval: typeof clearInterval } = globalThis
): Promise<FishCall> {
  let stopped = false
  let rate = 24000
  let queued = false // audio enqueued since the last drain
  let idle = true // the phone buffer is empty: true after a drain, false after an enqueue
  let endPending = false // server said audio_end; waiting for the buffer to drain
  let endGen: number | null = null // which utterance that audio_end closed; echoed in played
  let carry: number | null = null // odd trailing byte of the last audio chunk
  let ping: ReturnType<typeof setInterval> | null = null
  let unFrame: (() => void) | null = null
  let unDrain: (() => void) | null = null

  const sendJson = (o: object) => {
    if (!stopped && socket.readyState === OPEN) {
      try { socket.send(JSON.stringify(o)) } catch { /* closing */ }
    }
  }

  // Diagnostics only: one line per playback event, printed by the server beside its own log.
  let chunks = 0 // audio chunks enqueued since the last audio_end
  const diag = (ev: string, extra: object = {}) => sendJson({ type: "diag", ev, ...extra })

  const teardown = async () => {
    stopped = true
    if (ping) timers.clearInterval(ping)
    unFrame?.()
    unDrain?.()
    try { audio.flush() } catch { /* best effort */ }
    try { await audio.stop() } catch { /* best effort */ }
    try { socket.close() } catch { /* already closed */ }
  }

  const fail = async (message: string) => {
    if (stopped) return
    await teardown()
    h.onFailed(message)
  }

  /** Tell the server playback finished (it holds the next turn until then). */
  const finishPlayback = () => {
    if (!endPending) return
    endPending = false
    queued = false
    idle = true
    carry = null
    sendJson(endGen === null ? { type: "played" } : { type: "played", gen: endGen })
    h.onPhase("waiting")
  }

  socket.binaryType = "arraybuffer"
  socket.onmessage = (ev) => {
    if (stopped) return
    const d = ev.data
    if (typeof d !== "string") {
      let bytes = d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBuffer)
      // PCM16 samples are 2 bytes: a chunk cut mid-sample would shift every later sample
      // by one byte (white noise). Carry the odd byte into the next chunk.
      if (carry !== null) {
        const joined = new Uint8Array(bytes.byteLength + 1)
        joined[0] = carry
        joined.set(bytes, 1)
        bytes = joined
        carry = null
      }
      if (bytes.byteLength % 2 === 1) {
        carry = bytes[bytes.byteLength - 1]
        bytes = bytes.subarray(0, bytes.byteLength - 1)
      }
      if (bytes.byteLength === 0) return
      if (!audio.enqueue(toBase64(bytes), rate)) {
        // A refused chunk is lost speech; never drop it silently.
        diag("enqueue_refused", { chunks })
        void fail("Call audio stopped playing.")
        return
      }
      chunks += 1
      if (!queued) h.onPhase("speaking")
      queued = true
      idle = false
      return
    }
    const e = parseFishEvent(d)
    if (!e) return
    switch (e.type) {
      case "ready":
        rate = e.sampleRate
        h.onPhase("waiting")
        break
      case "heard":
        h.onHeard(e.text)
        h.onPhase("thinking")
        break
      case "reply":
        h.onReply(e.text, { servedBy: e.servedBy, fallback: e.fallback })
        break
      case "audio_end":
        endPending = true
        endGen = e.gen
        diag("audio_end", { gen: e.gen, chunks, queued, idle })
        chunks = 0
        // Nothing queued, or the buffer already drained before this message arrived (short
        // replies finish playing before the server's audio_end lands): no drain event will
        // come, so ack now. Waiting for one would leave the server holding every later turn.
        if (!queued || idle) finishPlayback()
        break
      case "barge":
        diag("barge", { chunks, queued, idle })
        chunks = 0
        audio.flush()
        endPending = false
        queued = false
        idle = true
        h.onPhase("waiting")
        break
      case "error":
        void fail(e.message)
        break
    }
  }
  socket.onerror = () => { void fail("The call connection failed.") }
  socket.onclose = () => { void fail("The call connection dropped.") }

  await new Promise<void>((resolve, reject) => {
    if (socket.readyState === OPEN) return resolve()
    const t = setTimeout(() => reject(new Error("Could not reach the call server.")), 6000)
    socket.onopen = () => { clearTimeout(t); resolve() }
  }).catch(async (e) => {
    await teardown()
    throw e
  })

  // The engine must be running BEFORE the server may speak: the server starts TTS the
  // moment it gets "start", and a chunk enqueued into a stopped engine is refused.
  // Starting the engine first is what makes turn 1 audible.
  unDrain = audio.onDrained(() => {
    diag("drained", { endPending })
    idle = true
    finishPlayback()
  })
  try {
    await audio.start(MIC_RATE)
  } catch (e) {
    await teardown()
    throw e
  }
  sendJson({ type: "start", history })
  unFrame = audio.onFrame((b64) => {
    if (stopped || socket.readyState !== OPEN) return
    try { socket.send(fromBase64(b64)) } catch { /* closing */ }
  })
  ping = timers.setInterval(() => sendJson({ type: "ping" }), PING_MS)

  return {
    async stop() {
      if (stopped) return
      sendJson({ type: "stop" })
      await teardown()
    },
  }
}
