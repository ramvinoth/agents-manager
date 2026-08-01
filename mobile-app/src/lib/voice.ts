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

/** Start a new recording and return the live handle (caller stops it). */
export async function startRecording(): Promise<Audio.Recording> {
  const { recording } = await Audio.Recording.createAsync(
    Audio.RecordingOptionsPresets.HIGH_QUALITY
  )
  return recording
}

/**
 * Stop the recording and transcribe it. Returns the recognized text (may be ""
 * for silence). Cleans up the temp recording file afterward.
 */
export async function stopAndTranscribe(recording: Audio.Recording): Promise<string> {
  await recording.stopAndUnloadAsync()
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

/**
 * Speak `text`: fetch WAV bytes from the server, write to a temp file, play it,
 * and resolve when playback finishes (so the caller can re-enable the mic).
 */
export async function speak(text: string): Promise<void> {
  if (!text.trim()) return
  const blob = await api.voiceTts(text)
  const base64 = await blobToBase64(blob)
  const path = `${FileSystem.cacheDirectory}harman-tts-${Date.now()}.wav`
  await FileSystem.writeAsStringAsync(path, base64, { encoding: FileSystem.EncodingType.Base64 })
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
