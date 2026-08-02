/**
 * Voice I/O helpers for VoiceScreen — the mechanics of recording a spoken turn
 * and speaking a reply, kept out of the screen so the component stays about UI.
 *
 * Recording uses expo-av (Audio.Recording) → an .m4a file the server transcribes
 * (its ffmpeg fallback decodes m4a). Playback writes the server's WAV bytes to a
 * temp file (expo-av can't stream a POST response) and plays it via Audio.Sound.
 *
 * All audio stays between the app, the user's viewer, and their GPU box — no
 * third party. See viewer/voice.py + deploy/speech_service.py.
 */
import { Audio } from "expo-av"
import * as FileSystem from "expo-file-system"
import TrackPlayer, { Event, State } from "react-native-track-player"
import { api } from "../api/client"

// TrackPlayer must be set up once per app run before use.
let _tpReady = false
async function ensureTrackPlayer(): Promise<void> {
  if (_tpReady) return
  try {
    await TrackPlayer.setupPlayer()
  } catch {
    /* already set up (setupPlayer throws if called twice) — fine */
  }
  _tpReady = true
}

/** The audio-session mode used throughout: record + play, audible with the ring
 *  switch off, and — critically for hands-free — kept alive when the app is
 *  backgrounded or the screen is locked (paired with UIBackgroundModes:["audio"]
 *  in app.json). iOS may still suspend under memory pressure; VAD-light windowing
 *  keeps the cost down. */
const AUDIO_MODE = {
  allowsRecordingIOS: true,
  playsInSilentModeIOS: true,
  staysActiveInBackground: true,
} as const

/** Ask for mic permission and put the audio session into record+play mode
 *  (playsInSilentModeIOS so TTS is audible even with the ring switch off, and
 *  staysActiveInBackground so hands-free keeps listening when backgrounded). */
export async function prepareAudio(): Promise<boolean> {
  const perm = await Audio.requestPermissionsAsync()
  if (!perm.granted) return false
  await Audio.setAudioModeAsync(AUDIO_MODE)
  return true
}

// expo-av permits only ONE prepared Audio.Recording globally. If a prior one
// wasn't unloaded (an error, or an unmount mid-record), createAsync throws
// "Only one Recording object can be prepared at a given time." Track the live
// recorder here and force-release any leftover before starting a new one.
let _active: Audio.Recording | null = null

async function _release(rec: Audio.Recording | null) {
  if (!rec) return
  try {
    await rec.stopAndUnloadAsync()
  } catch {
    /* already stopped/unloaded — fine */
  }
}

/** Start a new recording and return the live handle (caller stops it via
 *  stopAndTranscribe). Any stranded prior recorder is cleaned up first so the
 *  expo-av single-recorder constraint can't wedge push-to-talk. */
export async function startRecording(): Promise<Audio.Recording> {
  await _release(_active)
  _active = null
  // Re-assert record mode in case a prior playback left the session in play-only.
  await Audio.setAudioModeAsync(AUDIO_MODE)
  const { recording } = await Audio.Recording.createAsync(
    Audio.RecordingOptionsPresets.HIGH_QUALITY
  )
  _active = recording
  return recording
}

// Silence floor (dBFS) for the on-device VAD. expo-av meters loudness in dBFS —
// roughly -160 (pure silence) up to 0 (clipping). A window whose PEAK stays
// below this never contained speech, so we skip it entirely (no upload / decode /
// STT) — that's what cuts the battery cost of always-listening at rest. Env-ish
// tunable via setVadThreshold(); -45 is a conservative default that still catches
// normal speaking volume across a room.
let _vadFloorDb = -45

/** Adjust the on-device VAD silence floor (dBFS, negative). Lower = more
 *  sensitive (sends quieter windows). */
export function setVadThreshold(db: number): void {
  _vadFloorDb = db
}

/** Recording options with metering enabled so each window reports a peak dB level
 *  for the VAD gate (HIGH_QUALITY already meters on iOS, but we set it explicitly
 *  for both platforms). */
const METERED_OPTIONS: Audio.RecordingOptions = {
  ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
}

/** Force-release any live recorder (call on screen unmount / error recovery so
 *  the next startRecording() can't hit the single-recorder constraint). */
export async function resetRecorder(): Promise<void> {
  const rec = _active
  _active = null
  await _release(rec)
}

/**
 * Stop the recording and transcribe it. Returns the recognized text (may be ""
 * for silence). Cleans up the temp recording file afterward.
 */
export async function stopAndTranscribe(recording: Audio.Recording): Promise<string> {
  await recording.stopAndUnloadAsync()
  if (_active === recording) _active = null // this recorder is done; clear the tracker
  const uri = recording.getURI()
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

/** Record ~`seconds` of speech and return it as a Blob (m4a), or null if the
 *  recorder couldn't produce a file. Used by enrollment (one clean clip). */
async function _recordClipBlob(seconds: number): Promise<Blob | null> {
  const rec = await startRecording()
  await new Promise((r) => setTimeout(r, Math.max(300, seconds * 1000)))
  await rec.stopAndUnloadAsync()
  if (_active === rec) _active = null
  const uri = rec.getURI()
  if (!uri) return null
  try {
    const res = await fetch(uri)
    return await res.blob()
  } finally {
    FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
  }
}

/** Record ~`seconds` and return the raw m4a bytes as an ArrayBuffer, or null.
 *  Used by the hands-free listen loop: RN frames an ArrayBuffer as a binary
 *  WebSocket message reliably across versions (more so than a Blob), which the
 *  server reads as opcode 0x2 and decodes standalone.
 *
 *  On-device VAD: with metering enabled we watch the window's PEAK loudness while
 *  recording. If the whole window stayed below the silence floor (`_vadFloorDb`),
 *  we return {silent:true} WITHOUT reading/encoding the file — the caller then
 *  skips the upload + server STT for that window, which is what makes always-on
 *  listening cheap at rest. Only windows that actually contained sound are sent. */
async function _recordListenWindow(
  seconds: number
): Promise<{ buf: ArrayBuffer | null; silent: boolean }> {
  await _release(_active)
  _active = null
  await Audio.setAudioModeAsync(AUDIO_MODE)
  let peak = -160
  const rec = new Audio.Recording()
  try {
    await rec.prepareToRecordAsync(METERED_OPTIONS)
    rec.setProgressUpdateInterval(120)
    rec.setOnRecordingStatusUpdate((s) => {
      if (s.isRecording && typeof s.metering === "number" && s.metering > peak) {
        peak = s.metering
      }
    })
    _active = rec
    await rec.startAsync()
    await new Promise((r) => setTimeout(r, Math.max(300, seconds * 1000)))
    await rec.stopAndUnloadAsync()
    if (_active === rec) _active = null
  } catch {
    if (_active === rec) _active = null
    try {
      await rec.stopAndUnloadAsync()
    } catch {
      /* already unloaded */
    }
    return { buf: null, silent: false }
  }
  const uri = rec.getURI()
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

/** Enroll the user's voiceprint from a fresh ~`seconds`-second recording. The
 *  server stores a speaker embedding so hands-free listening can verify it's
 *  really them saying "Harman". Returns true on success. */
export async function enrollVoice(seconds = 5, speakerId = "default"): Promise<boolean> {
  const blob = await _recordClipBlob(seconds)
  if (!blob) return false
  try {
    const { ok } = await api.voiceEnroll(blob, speakerId, "audio/m4a")
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

// One live hands-free session at a time. `_listenStop` cancels the record loop;
// `_listenWs` is the open socket.
let _listenStop: (() => void) | null = null

/**
 * Start HANDS-FREE listening: continuously record short audio windows and stream
 * each one to the server's /api/voice/ws, which runs wake-word + strict speaker
 * verification on the GPU box. `onEvent` fires for every window's verdict; the
 * caller acts only on {type:"utterance"} (the enrolled user said "Harman …").
 *
 * Reuses expo-av (already linked) — no new native audio dependency. Each window
 * is a self-contained m4a the box decodes standalone, so there's no stream
 * reassembly. Returns a stop() function.
 *
 * NOTE: recording and TTS playback share the one audio session, so the caller
 * pauses listening (stop()) while speaking a reply, then restarts it.
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

  // Wait for OPEN, then loop: record a window, send it, repeat. Recording is
  // inherently serial (one recorder), which naturally paces the stream.
  ws.onopen = async () => {
    await Audio.setAudioModeAsync(AUDIO_MODE).catch(
      () => {}
    )
    while (!stopped && ws.readyState === WebSocket.OPEN) {
      let res: { buf: ArrayBuffer | null; silent: boolean } = { buf: null, silent: false }
      try {
        res = await _recordListenWindow(windowSeconds)
      } catch {
        res = { buf: null, silent: false }
      }
      if (stopped || ws.readyState !== WebSocket.OPEN) break
      // On-device VAD: a silent window is dropped here — no upload, no server STT.
      // This is the battery win: at rest, most windows are silence and cost only
      // the local recording, never the radio or the GPU box.
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

/** Fetch one sentence's TTS audio and write it to a temp WAV; returns the path
 *  (or null on failure so the pipeline can skip it). */
async function fetchTts(sentence: string): Promise<string | null> {
  try {
    const blob = await api.voiceTts(sentence)
    const base64 = await blobToBase64(blob)
    const path = `${FileSystem.cacheDirectory}harman-tts-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`
    await FileSystem.writeAsStringAsync(path, base64, { encoding: FileSystem.EncodingType.Base64 })
    return path
  } catch {
    return null
  }
}

/**
 * Speak `text` by STREAMING it: react-native-track-player plays the viewer's
 * live AAC stream (Pocket generate_audio_stream -> ffmpeg), so the first audio
 * arrives in ~0.5s and long replies start speaking almost immediately instead
 * of waiting for the whole thing to generate. Resolves when playback finishes.
 *
 * NOTE: track-player owns the audio session while playing; we re-assert the
 * expo-av record mode afterward so the next mic press still records.
 */
export async function speak(text: string): Promise<void> {
  if (!text.trim()) return
  await ensureTrackPlayer()
  const { url, headers } = api.voiceTtsStreamUrl(text)
  try {
    await TrackPlayer.reset()
    await TrackPlayer.add({ id: "tts", url, headers, title: "Reply", artist: "Harman" })
    await TrackPlayer.play()
    // Resolve when playback reaches the end (or errors), polling player state.
    await new Promise<void>((resolve) => {
      let started = false
      const sub = TrackPlayer.addEventListener(Event.PlaybackState, async (e) => {
        if (e.state === State.Playing) started = true
        // Ended / stopped after it actually started -> done.
        if (started && (e.state === State.Ended || e.state === State.Stopped || e.state === State.None)) {
          sub.remove()
          resolve()
        }
      })
      // Safety: also resolve if a queue-ended event fires.
      const sub2 = TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => {
        sub.remove(); sub2.remove(); resolve()
      })
    })
  } catch {
    /* streaming failed — swallow so the mic re-enables */
  } finally {
    await TrackPlayer.reset().catch(() => {})
    // Hand the audio session back to the recorder for the next turn.
    await Audio.setAudioModeAsync(AUDIO_MODE).catch(() => {})
  }
}

/** Stop any in-progress TTS playback (the "read aloud" toggle / new turn). The
 *  active speak() promise resolves via its PlaybackState listener. */
export async function stopSpeaking(): Promise<void> {
  await TrackPlayer.reset().catch(() => {})
}

/** RN Blob → base64 string (FileReader is available in the RN runtime). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error("failed to read audio blob"))
    reader.onloadend = () => {
      // result is a data URL: "data:audio/wav;base64,XXXX" — strip the prefix.
      const s = String(reader.result)
      resolve(s.slice(s.indexOf(",") + 1))
    }
    reader.readAsDataURL(blob)
  })
}
