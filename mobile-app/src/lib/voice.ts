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
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true }).catch(() => {})
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
