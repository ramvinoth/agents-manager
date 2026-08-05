/**
 * duplexMic — barge-in mic capture that runs WHILE the assistant is speaking.
 *
 * The native HarmanAudio module (modules/harman-audio, voiceProcessingIO) emits
 * echo-cancelled PCM16 frames — the assistant's own TTS is removed by hardware
 * AEC, so the mic doesn't self-trigger on Harman's voice. This module batches
 * those frames into short WAV windows and streams each to the server's
 * `mode=wakeguard` WebSocket, which runs a cheap keyword-spotter and fires only
 * when the user says "Harman …". The transcript tail is handed back for command
 * parsing (bargeCommand.ts).
 *
 * Unlike the half-duplex `startListening()` in voice.ts (which serializes with
 * playback through audioSession), this coexists with `audioSession.play()` — the
 * whole point is to listen during speech. It is only used in call mode barge-in.
 */
import { HarmanAudio, type HarmanAudioFrame } from "../../modules/harman-audio/src"
import { api } from "../api/client"

export interface WakeguardEvent {
  /** true when the wake word "Harman" was detected in this window. */
  wake: boolean
  /** Transcript tail after the wake word (the command / question), if any. */
  text: string
}

const SAMPLE_RATE = 16000
/** Emit a WAV window roughly this often for keyword spotting. Short so barge-in
 *  latency ("Harman stop" → action) stays snappy. */
const WINDOW_MS = 900
// Speech-energy gate for ducking (independent of the server wake check). RMS of a
// PCM16 frame (normalized 0..1) above ON starts "speaking"; below OFF ends it.
// Hysteresis (ON > OFF) stops flicker on the boundary. Tuned for echo-cancelled
// input, where the assistant's voice is already removed so only the user drives it.
const SPEECH_ON = 0.02
const SPEECH_OFF = 0.012

/** rms of a PCM16 little-endian buffer, normalized to 0..1. */
function rms16(bytes: Uint8Array): number {
  const n = bytes.byteLength >> 1
  if (n === 0) return 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) / 32768
    sum += s * s
  }
  return Math.sqrt(sum / n)
}

export interface DuplexMic {
  stop: () => Promise<void>
}

/** Is the native echo-cancelling capture available on this build? (false on
 *  Android / a build without the module, so callers can fall back gracefully.) */
export function duplexAvailable(): boolean {
  return HarmanAudio.isAvailable()
}

/**
 * Start the wake-guard listen stream. Runs concurrently with TTS playback.
 * `onEvent` fires per window with the wakeguard verdict. `onSpeechChange` (optional)
 * fires the instant local speech energy crosses the gate — used to duck TTS volume
 * immediately, before the server round-trip recognizes the wake word. Returns a
 * handle whose `stop()` tears down capture + the socket.
 */
export async function startWakeguard(
  onEvent: (e: WakeguardEvent) => void,
  opts: { speakerId?: string; onSpeechChange?: (speaking: boolean) => void } = {}
): Promise<DuplexMic> {
  const speakerId = opts.speakerId ?? "default"
  const { url, headers } = api.voiceWakeguardWsUrl(speakerId)

  const WS = WebSocket as unknown as {
    new (url: string, protocols: undefined, options: { headers: Record<string, string> }): WebSocket
  }
  const ws = new WS(url, undefined, { headers })

  let stopped = false
  let pcmChunks: Uint8Array[] = []
  let pcmBytes = 0
  let speaking = false // hysteresis state for onSpeechChange (ducking)
  const windowBytes = Math.floor((SAMPLE_RATE * 2 * WINDOW_MS) / 1000) // 16-bit mono

  const flush = () => {
    if (stopped || ws.readyState !== WebSocket.OPEN || pcmBytes === 0) return
    const pcm = concat(pcmChunks, pcmBytes)
    pcmChunks = []
    pcmBytes = 0
    try {
      ws.send(wavFromPcm16(pcm, SAMPLE_RATE))
    } catch {
      /* socket closing — loop guard catches it */
    }
  }

  const frameSub = HarmanAudio.addFrameListener((f: HarmanAudioFrame) => {
    if (stopped) return
    const bytes = base64ToBytes(f.pcm)
    // Per-frame energy → duck the moment the user starts talking (well before the
    // 900ms window ships and the server recognizes the wake word). Hysteresis
    // avoids flicker at the threshold.
    if (opts.onSpeechChange) {
      const level = rms16(bytes)
      if (!speaking && level >= SPEECH_ON) {
        speaking = true
        opts.onSpeechChange(true)
      } else if (speaking && level < SPEECH_OFF) {
        speaking = false
        opts.onSpeechChange(false)
      }
    }
    pcmChunks.push(bytes)
    pcmBytes += bytes.byteLength
    if (pcmBytes >= windowBytes) flush()
  })

  ws.onmessage = (ev: WebSocketMessageEvent) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { type?: string; text?: string }
      // Server sends {type:"wake", text:tail} on a hit, {type:"idle"} otherwise.
      if (msg && msg.type === "wake") {
        onEvent({ wake: true, text: String(msg.text || "") })
      }
    } catch {
      /* ignore malformed frame */
    }
  }
  ws.onerror = () => {}
  ws.onclose = () => { stopped = true }

  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve()
    // Don't hang forever if the socket never opens.
    setTimeout(resolve, 4000)
  })

  await HarmanAudio.start(SAMPLE_RATE)

  const stop = async () => {
    if (stopped) return
    stopped = true
    frameSub.remove()
    try { await HarmanAudio.stop() } catch { /* best-effort */ }
    try { ws.close() } catch { /* already closing */ }
  }

  return { stop }
}

// --- PCM/WAV helpers ---------------------------------------------------------

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/** Wrap raw PCM16 mono in a minimal WAV (RIFF) container — the server's /segment
 *  path decodes self-contained WAV windows. */
function wavFromPcm16(pcm: Uint8Array, sampleRate: number): ArrayBuffer {
  const dataLen = pcm.byteLength
  const buf = new ArrayBuffer(44 + dataLen)
  const view = new DataView(buf)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, "RIFF")
  view.setUint32(4, 36 + dataLen, true)
  writeStr(8, "WAVE")
  writeStr(12, "fmt ")
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate (mono*16bit)
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, "data")
  view.setUint32(40, dataLen, true)
  new Uint8Array(buf, 44).set(pcm)
  return buf
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = typeof atob === "function" ? atob(b64) : ""
  const len = bin.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
