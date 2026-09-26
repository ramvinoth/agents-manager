/**
 * audioSessionNative — wires the real expo-av calls into the pure AudioSession
 * coordinator, and exposes the app-wide singleton.
 *
 * Playback and recording both go through expo-av (Audio.Sound + Audio.Recording).
 * The coordinator serializes their ownership; cancellation unloads the sound
 * before the next recording starts. Playback accepts either a reply WAV file
 * or the existing read-aloud AAC URL.
 */
import { Audio, type AVPlaybackStatus } from "expo-av"
import { AudioSession, type AudioBackend, type RecordingHandle } from "./audioSession"

// The ONE canonical audio mode: record + play, audible with the ring switch off,
// and kept alive when backgrounded/locked (pairs with UIBackgroundModes:["audio"]
// in app.json for hands-free listening).
export const RECORD_MODE = {
  allowsRecordingIOS: true,
  playsInSilentModeIOS: true,
  staysActiveInBackground: true,
} as const

function defaultBackend(): AudioBackend {
  // The currently-playing TTS sound, tracked so stopPlayback (barge-in / teardown)
  // can unload it. Only one plays at a time (the coordinator serializes).
  let active: Audio.Sound | null = null
  let cancelPlayback: (() => Promise<void>) | null = null

  return {
    async requestPermission() {
      const perm = await Audio.requestPermissionsAsync()
      return perm.granted
    },
    async setRecordMode() {
      await Audio.setAudioModeAsync(RECORD_MODE)
    },
    async adoptRecordMode() {
      // CallKit already activated the AVAudioSession for the call; we only assert
      // OUR record+play mode on top. setAudioModeAsync sets the category/options
      // without owning activation, so it composes with CallKit rather than fighting
      // it. Same expo-av module the recorder/player use, so no cross-module conflict.
      await Audio.setAudioModeAsync(RECORD_MODE)
    },
    async startRecorder(options) {
      const { recording } = await Audio.Recording.createAsync(options as Audio.RecordingOptions)
      return recording as unknown as RecordingHandle
    },
    async playToEnd(url, headers) {
      let cancelled = false
      let sound: Audio.Sound | null = null
      let finish!: () => void
      let playbackError: string | undefined
      const ended = new Promise<void>((resolve) => { finish = resolve })
      // Load paused: stop during a native load must not produce even a brief
      // burst of audio when that load eventually completes.
      const loading = Audio.Sound.createAsync(
        { uri: url, headers }, { shouldPlay: false, volume: 1.0 },
        (status: AVPlaybackStatus) => {
          if (!status.isLoaded && status.error) {
            playbackError = status.error
            finish()
          } else if (status.isLoaded && status.didJustFinish) {
            finish()
          }
        }, false
      )
      let unloading: Promise<void> | null = null
      const unload = (): Promise<void> => {
        if (!unloading) unloading = loading.then(async ({ sound: loaded }) => {
          await loaded.unloadAsync()
        }).catch(() => {})
        return unloading
      }
      const cancel = async () => {
        cancelled = true
        finish()
        // expo-av cannot cancel a pending load. Wait for it and unload without
        // ever starting playback; subsequent recording stays behind cleanup.
        await unload()
      }
      cancelPlayback = cancel
      try {
        sound = (await loading).sound
        if (cancelled) return
        active = sound
        if (playbackError) throw new Error(playbackError)
        await sound.playAsync()
        await ended
        if (playbackError && !cancelled) throw new Error(playbackError)
      } finally {
        if (cancelPlayback === cancel) cancelPlayback = null
        if (active === sound) active = null
        await unload()
      }
    },
    async stopPlayback() {
      await cancelPlayback?.()
    },
    async setPlaybackVolume(v: number) {
      // Duck / restore the live TTS while the user speaks over it. Fire-and-forget
      // against the active sound; harmless if it just unloaded (barge-in halt).
      const sound = active
      if (sound) await sound.setStatusAsync({ volume: Math.max(0, Math.min(1, v)) }).catch(() => {})
    },
  }
}

/** The app-wide single owner of the audio session. */
export const audioSession = new AudioSession(defaultBackend())
