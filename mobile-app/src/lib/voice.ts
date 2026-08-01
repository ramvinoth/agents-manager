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
import { api } from "../api/client"

/** Ask for mic permission and put the audio session into record+play mode
 *  (playsInSilentModeIOS so TTS is audible even with the ring switch off). */
export async function prepareAudio(): Promise<boolean> {
  const perm = await Audio.requestPermissionsAsync()
  if (!perm.granted) return false
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
  })
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
  await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true })
  const { recording } = await Audio.Recording.createAsync(
    Audio.RecordingOptionsPresets.HIGH_QUALITY
  )
  _active = recording
  return recording
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

/** Split a reply into speakable sentences, keeping terminal punctuation so each
 *  chunk reads naturally. Newlines (list items/headers from the markdown
 *  cleaner) are hard breaks. Short trailing fragments merge into the prior
 *  sentence so we never synthesize a lone "OK." with big overhead. */
function splitSentences(text: string): string[] {
  const parts = text
    .replace(/\s*\n+\s*/g, " . ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    // Glue very short fragments onto the previous chunk to cut per-call overhead.
    if (out.length && p.length < 12) out[out.length - 1] += " " + p
    else out.push(p)
  }
  return out
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
 * Speak `text`, STREAMING sentence by sentence: play each sentence as soon as
 * its audio is ready while the NEXT sentence is already being synthesized in the
 * background. Time-to-first-audio is one sentence (~1.5s) instead of the whole
 * reply, so long answers start speaking almost immediately. Resolves when the
 * last sentence finishes playing (so the caller can re-enable the mic).
 */
export async function speak(text: string): Promise<void> {
  const sentences = splitSentences(text)
  if (!sentences.length) return
  // Lookahead of 1: kick off the first fetch, then always prefetch the next
  // while the current one plays.
  let nextAudio = fetchTts(sentences[0])
  for (let i = 0; i < sentences.length; i++) {
    const path = await nextAudio
    nextAudio = i + 1 < sentences.length ? fetchTts(sentences[i + 1]) : Promise.resolve(null)
    if (!path) continue
    const { sound } = await Audio.Sound.createAsync({ uri: path }, { shouldPlay: true })
    await new Promise<void>((resolve) => {
      sound.setOnPlaybackStatusUpdate((s) => {
        if (s.isLoaded && s.didJustFinish) resolve()
        if (!s.isLoaded && s.error) resolve()
      })
    })
    await sound.unloadAsync().catch(() => {})
    FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {})
  }
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
