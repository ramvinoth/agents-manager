/**
 * Voice I/O helpers for call mode — the mechanics of listening for utterances
 * and speaking a reply, kept out of the screen so the component stays about UI.
 *
 * Listening records endpointed .m4a utterances and streams them over the voice
 * WebSocket (the server transcribes; its ffmpeg fallback decodes m4a). Playback
 * streams the viewer's live AAC via react-native-track-player.
 *
 * IMPORTANT: this module does NOT touch the iOS audio session directly. All
 * recorder/playback/session transitions go through `audioSession` (the single
 * owner) so recording and playback are mutually exclusive and correctly ordered —
 * that's what prevents "recorder not prepared" on the second turn. See
 * src/lib/audioSession.ts (pure state machine) + audioSessionNative.ts (wiring).
 *
 * All audio stays between the app, the user's viewer, and their GPU box — no
 * third party. See viewer/voice.py + deploy/speech_service.py.
 */
import { Audio } from "expo-av"
import * as FileSystem from "expo-file-system"
import { api } from "../api/client"
import { audioSession } from "./audioSessionNative"
import {
  endpointVerdict,
  observeFrame,
  type EndpointOptions,
  type EndpointState,
} from "./endpoint"

/** Ask for mic permission and configure the (single) audio session. Returns
 *  whether the mic is available. */
export async function prepareAudio(): Promise<boolean> {
  return audioSession.configure()
}

/** Force-release the recorder + any playback (screen unmount / loop stop). */
async function resetRecorder(): Promise<void> {
  await audioSession.reset()
}

// Silence floor (dBFS) for the on-device endpointer. expo-av meters loudness in
// dBFS — roughly -160 (pure silence) up to 0 (clipping). An utterance whose PEAK
// stays below this never contained speech, so it is dropped without an upload —
// that's what cuts the battery cost of always-listening at rest. -45 is
// conservative but still catches room-level speech.
const VAD_FLOOR_DB = -45

/** Recording options with metering enabled so each frame reports a dB level for
 *  the endpointer. */
const METERED_OPTIONS: Audio.RecordingOptions = {
  ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
}

/** Endpointing profile for the call loop: forgiving 1.5s silence-hang (tolerates
 *  thinking pauses; resuming speech extends the window), a 15s hard cap, and a 4s
 *  "you never spoke" give-up so a truly silent window is dropped fast (battery). */
const ENDPOINT_OPTS: EndpointOptions = {
  floorDb: VAD_FLOOR_DB,
  silenceHangMs: 1500,
  maxMs: 15000,
  noSpeechTimeoutMs: 4000,
}

/** One endpointed recording window: the m4a bytes (null if unreadable) and
 *  whether the caller never spoke (dropped on-device, nothing uploaded). */
export type Utterance = { buf: ArrayBuffer | null; silent: boolean }

/**
 * Record ONE utterance with silence-based endpointing: keep recording until the
 * speaker finishes (≈`silenceHangMs` of trailing quiet after speech), or the hard
 * cap, or give up if they never spoke. Returns the m4a bytes + whether the window
 * was silent.
 *
 * This is what makes the call feel natural: instead of a fixed 2.5s window that
 * clips mid-sentence, the clip grows to fit what you actually said, and a thinking
 * pause shorter than the hang doesn't end your turn (resuming speech resets the
 * silence timer — barge-in-to-extend, handled purely in `observeFrame`).
 *
 * The endpoint decision is the pure `endpoint.ts` helper fed by expo-av metering
 * frames; timing uses the frame's own `s.durationMillis` (monotonic, no Date).
 *
 * Shared by both call engines: the STT listen loop below streams each window to
 * /api/voice/ws, and the Nemotron loop (useAssistantTurn) sends it as one turn.
 */
export async function recordUtterance(): Promise<Utterance> {
  let state: EndpointState = { heardSpeech: false, lastLoudMs: -1 }
  let stopReason: "endpoint" | "max" | "no-speech" | null = null
  const rec = (await audioSession.record(METERED_OPTIONS)) as Audio.Recording
  rec.setProgressUpdateInterval(100)

  await new Promise<void>((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    rec.setOnRecordingStatusUpdate((s) => {
      if (!s.isRecording || typeof s.metering !== "number" || typeof s.durationMillis !== "number") return
      const now = s.durationMillis
      state = observeFrame(state, s.metering, now, ENDPOINT_OPTS.floorDb)
      const v = endpointVerdict(state, now, now, ENDPOINT_OPTS)
      if (v.done) {
        stopReason = v.reason
        done()
      }
    })
    // Absolute safety net in case status updates stall: cap slightly above maxMs.
    setTimeout(done, ENDPOINT_OPTS.maxMs + 1000)
  })

  const uri = await audioSession.stopRecording()
  // Never spoke → drop it like a silent VAD window (no upload / server STT).
  if (stopReason === "no-speech" || !state.heardSpeech) {
    if (uri) FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
    return { buf: null, silent: true }
  }
  if (!uri) return { buf: null, silent: false }
  try {
    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    })
    return { buf: _base64ToArrayBuffer(b64), silent: false }
  } catch {
    return { buf: null, silent: false }
  } finally {
    FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
  }
}


/** Decode a base64 string to an ArrayBuffer (atob is available in the RN/Hermes
 *  runtime; falls back to a manual decode if not). */
function _base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = typeof atob === "function" ? atob(b64) : _atobPolyfill(b64)
  const len = bin.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

const _B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
function _atobPolyfill(input: string): string {
  const str = input.replace(/=+$/, "")
  let out = ""
  for (let bc = 0, bs = 0, buffer, i = 0; (buffer = str.charAt(i++)); ) {
    const idx = _B64.indexOf(buffer)
    if (idx === -1) continue
    bs = bc % 4 ? bs * 64 + idx : idx
    if (bc++ % 4) out += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)))
  }
  return out
}

/** A parsed message from the hands-free WS. */
export type ListenEvent =
  | { type: "utterance"; text: string }
  | { type: "idle" }
  | { type: "error"; error?: string }

// One live hands-free session at a time. `_listenStop` cancels the record loop.
let _listenStop: (() => void) | null = null

/**
 * Start listening for a call: continuously record endpointed utterances and
 * stream each one to the server's /api/voice/ws (call mode: the GPU box
 * transcribes any speech; no wake word). `onEvent` fires for every window's
 * verdict; the caller acts only on {type:"utterance"}.
 *
 * Each window is a self-contained m4a the box decodes standalone, so there's no
 * stream reassembly. Recording goes through the session owner, so it's serialized
 * with any TTS playback. Returns a stop() function.
 */
export async function startListening(onEvent: (e: ListenEvent) => void): Promise<() => void> {
  await stopListening() // never run two loops at once
  const { url, headers } = api.voiceWsUrl()

  let stopped = false
  // RN's WebSocket runtime accepts a 3rd `options` arg carrying request headers
  // (so the Bearer token rides the handshake, like the terminal WS) — but the TS
  // lib types only declare (url, protocols). Cast the constructor to add it.
  const WS = WebSocket as unknown as {
    new (url: string, protocols: undefined, options: { headers: Record<string, string> }): WebSocket
  }
  const ws = new WS(url, undefined, { headers })

  const stop = () => {
    if (stopped) return
    stopped = true
    _listenStop = null
    try {
      ws.close()
    } catch {
      /* already closing */
    }
    resetRecorder().catch(() => {})
  }
  _listenStop = stop

  ws.onmessage = (ev: WebSocketMessageEvent) => {
    try {
      onEvent(JSON.parse(String(ev.data)) as ListenEvent)
    } catch {
      /* ignore malformed frame */
    }
  }
  ws.onerror = () => onEvent({ type: "error", error: "listen socket error" })
  ws.onclose = () => {
    stopped = true
    _listenStop = null
  }

  // On OPEN, loop: record ONE endpointed utterance (grows to fit what was said,
  // ends on a natural pause), send it, repeat. audioSession serializes each record,
  // which naturally paces the stream.
  ws.onopen = async () => {
    while (!stopped && ws.readyState === WebSocket.OPEN) {
      let res: Utterance = { buf: null, silent: false }
      try {
        res = await recordUtterance()
      } catch {
        res = { buf: null, silent: false }
      }
      if (stopped || ws.readyState !== WebSocket.OPEN) break
      // On-device endpointer: a silent window is dropped here — no upload, no server STT.
      if (res.silent) continue
      if (res.buf && res.buf.byteLength > 0) {
        try {
          ws.send(res.buf) // RN frames an ArrayBuffer as a binary message
        } catch {
          /* socket went away — loop condition will catch it */
        }
      }
    }
  }

  return stop
}

/** Stop the listen loop (if any) and release the recorder. */
export async function stopListening(): Promise<void> {
  if (_listenStop) _listenStop()
  await resetRecorder().catch(() => {})
}

/**
 * Speak `text` by STREAMING it through the session owner: track-player plays the
 * viewer's live AAC stream (Pocket generate_audio_stream -> ffmpeg), so the first
 * audio arrives in ~0.5s. Resolves when playback finishes AND the session has been
 * released — so a following recording sees a free session.
 */
export async function speak(text: string): Promise<void> {
  if (!text.trim()) return
  const { url, headers } = api.voiceTtsStreamUrl(text)
  await audioSession.play(url, headers)
}

/** Play an already-persisted reply file (a Nemotron turn's WAV) to completion
 *  through the session owner — same exclusivity with recording as `speak`. */
export async function playFile(uri: string): Promise<void> {
  await audioSession.play(uri, {})
}

/** Stop any in-progress TTS playback (barge-in / new turn). */
export async function stopSpeaking(): Promise<void> {
  await audioSession.stopPlayback()
}
