/**
 * Voice I/O helpers for VoiceScreen — the mechanics of recording a spoken turn
 * and speaking a reply, kept out of the screen so the component stays about UI.
 *
 * Recording produces an .m4a the server transcribes (its ffmpeg fallback decodes
 * m4a). Playback streams the viewer's live AAC via react-native-track-player.
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
import * as SecureStore from "expo-secure-store"
import { api } from "../api/client"
import { audioSession } from "./audioSessionNative"

/** Ask for mic permission and configure the (single) audio session. Returns
 *  whether the mic is available. */
export async function prepareAudio(): Promise<boolean> {
  return audioSession.configure()
}

/** Start a push-to-talk recording; the coordinator guarantees any prior playback
 *  has released the session first. Returns the live recorder handle. */
export async function startRecording(): Promise<Audio.Recording> {
  return audioSession.record(Audio.RecordingOptionsPresets.HIGH_QUALITY) as Promise<Audio.Recording>
}

/** Force-release the recorder + any playback (screen unmount / loop stop). */
export async function resetRecorder(): Promise<void> {
  await audioSession.reset()
}

// Silence floor (dBFS) for the on-device VAD. expo-av meters loudness in dBFS —
// roughly -160 (pure silence) up to 0 (clipping). A window whose PEAK stays
// below this never contained speech, so we skip it entirely (no upload / decode /
// STT) — that's what cuts the battery cost of always-listening at rest. Tunable
// via setVadThreshold(); -45 is conservative but still catches room-level speech.
let _vadFloorDb = -45

/** Adjust the on-device VAD silence floor (dBFS, negative). Lower = more
 *  sensitive (sends quieter windows). */
export function setVadThreshold(db: number): void {
  _vadFloorDb = db
}

/** Recording options with metering enabled so each window reports a peak dB level
 *  for the VAD gate. */
const METERED_OPTIONS: Audio.RecordingOptions = {
  ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
}

/**
 * Stop the current recording (via the session owner) and transcribe it. Returns
 * the recognized text (may be "" for silence). Cleans up the temp file.
 *
 * The `recording` arg is accepted for call-site clarity but the owner tracks the
 * live recorder, so we stop through it to keep session state consistent.
 */
export async function stopAndTranscribe(_recording: Audio.Recording): Promise<string> {
  const uri = await audioSession.stopRecording()
  if (!uri) return ""
  try {
    const res = await fetch(uri)
    const blob = await res.blob()
    const { text } = await api.voiceStt(blob, "audio/m4a")
    return text
  } finally {
    FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
  }
}

/** Record ~`seconds` of speech and return it as a Blob (m4a), or null. Used by
 *  enrollment (one clean clip). Goes through the session owner. */
async function _recordClipBlob(seconds: number): Promise<Blob | null> {
  await audioSession.record(METERED_OPTIONS)
  await new Promise((r) => setTimeout(r, Math.max(300, seconds * 1000)))
  const uri = await audioSession.stopRecording()
  if (!uri) return null
  try {
    const res = await fetch(uri)
    return await res.blob()
  } finally {
    FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
  }
}

/**
 * Record ~`seconds` and return the raw m4a bytes as an ArrayBuffer, plus whether
 * the window was silent. Used by the hands-free listen loop.
 *
 * On-device VAD: with metering enabled we watch the window's PEAK loudness. If it
 * never rose above the silence floor, we return {silent:true} WITHOUT reading the
 * file — the caller skips the upload + server STT for that window (the battery
 * win). The recorder is obtained from the session owner (so it's serialized with
 * playback); the metering callback is a read-only observation set on the handle.
 */
async function _recordListenWindow(
  seconds: number
): Promise<{ buf: ArrayBuffer | null; silent: boolean }> {
  let peak = -160
  const rec = (await audioSession.record(METERED_OPTIONS)) as Audio.Recording
  rec.setProgressUpdateInterval(120)
  rec.setOnRecordingStatusUpdate((s) => {
    if (s.isRecording && typeof s.metering === "number" && s.metering > peak) {
      peak = s.metering
    }
  })
  await new Promise((r) => setTimeout(r, Math.max(300, seconds * 1000)))
  const uri = await audioSession.stopRecording()
  // VAD gate: window never rose above the silence floor -> skip it (no upload).
  if (peak < _vadFloorDb) {
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

/** Whether the user has enrolled a voiceprint before (persisted across app
 *  launches + sessions so re-opening the voice screen doesn't force re-enroll).
 *  The voiceprint itself lives on the server, keyed by speaker_id; this is just a
 *  local "we've done it" flag. */
const ENROLLED_KEY = "harman.voice.enrolled"

export async function isEnrolled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(ENROLLED_KEY)) === "1"
  } catch {
    return false
  }
}

/** Enroll the user's voiceprint from a fresh ~`seconds`-second recording. The
 *  server stores a speaker embedding so hands-free listening can verify it's
 *  really them saying "Harman". Returns true on success and remembers it. */
export async function enrollVoice(seconds = 5, speakerId = "default"): Promise<boolean> {
  const blob = await _recordClipBlob(seconds)
  if (!blob) return false
  try {
    const { ok } = await api.voiceEnroll(blob, speakerId, "audio/m4a")
    if (ok) await SecureStore.setItemAsync(ENROLLED_KEY, "1").catch(() => {})
    return ok
  } catch {
    return false
  }
}

/** A parsed message from the hands-free WS. */
export type ListenEvent =
  | { type: "utterance"; text: string; score?: number }
  | { type: "idle" }
  | { type: "unenrolled" }
  | { type: "error"; error?: string }

// One live hands-free session at a time. `_listenStop` cancels the record loop.
let _listenStop: (() => void) | null = null

/**
 * Start HANDS-FREE listening: continuously record short audio windows and stream
 * each one to the server's /api/voice/ws, which runs wake-word + strict speaker
 * verification on the GPU box. `onEvent` fires for every window's verdict; the
 * caller acts only on {type:"utterance"} (the enrolled user said "Harman …").
 *
 * Each window is a self-contained m4a the box decodes standalone, so there's no
 * stream reassembly. Recording goes through the session owner, so it's serialized
 * with any TTS playback. Returns a stop() function.
 */
export async function startListening(
  onEvent: (e: ListenEvent) => void,
  opts: { windowSeconds?: number; speakerId?: string } = {}
): Promise<() => void> {
  await stopListening() // never run two loops at once
  const windowSeconds = opts.windowSeconds ?? 2.5
  const speakerId = opts.speakerId ?? "default"
  const { url, headers } = api.voiceWsUrl(speakerId)

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

  // On OPEN, loop: record a window, send it, repeat. audioSession serializes each
  // record, which naturally paces the stream.
  ws.onopen = async () => {
    while (!stopped && ws.readyState === WebSocket.OPEN) {
      let res: { buf: ArrayBuffer | null; silent: boolean } = { buf: null, silent: false }
      try {
        res = await _recordListenWindow(windowSeconds)
      } catch {
        res = { buf: null, silent: false }
      }
      if (stopped || ws.readyState !== WebSocket.OPEN) break
      // On-device VAD: a silent window is dropped here — no upload, no server STT.
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

/** Stop the hands-free listen loop (if any) and release the recorder. */
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

/** Stop any in-progress TTS playback (barge-in / new turn). */
export async function stopSpeaking(): Promise<void> {
  await audioSession.stopPlayback()
}
