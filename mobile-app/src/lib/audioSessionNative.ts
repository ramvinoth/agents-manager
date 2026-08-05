/**
 * audioSessionNative — wires the real expo-av calls into the pure AudioSession
 * coordinator, and exposes the app-wide singleton.
 *
 * Playback AND recording both go through expo-av (Audio.Sound + Audio.Recording),
 * so a SINGLE native module owns the one iOS AVAudioSession. This is the fix for
 * the "recorder not prepared" error on the 2nd turn: previously TTS used
 * react-native-track-player, which sets the AVAudioSession .playback category via
 * its own native code, while expo-av's recorder manages the session through a
 * separate native manager. Two native modules fighting over the one session left
 * it in a state the recorder couldn't prepare against — a conflict no JS layer
 * could reconcile. With one native module, that conflict is impossible.
 *
 * TTS still streams: Audio.Sound plays the live AAC URL via AVPlayer, so first
 * audio arrives quickly and long replies start speaking without waiting for the
 * whole file.
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
      // Stream the reply via expo-av. AVPlayer handles the live AAC HTTP stream,
      // so playback starts before the whole file arrives.
      const { sound } = await Audio.Sound.createAsync(
        { uri: url, headers },
        { shouldPlay: true },
        null,
        /* downloadFirst */ false
      )
      active = sound
      try {
        // Resolve when playback reaches the end (didJustFinish) or errors/unloads.
        await new Promise<void>((resolve) => {
          let done = false
          const finish = () => {
            if (done) return
            done = true
            resolve()
          }
          sound.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => {
            if (!status.isLoaded) {
              // Unloaded or failed to load -> nothing more will play.
              finish()
              return
            }
            if (status.didJustFinish) finish()
          })
        })
      } finally {
        // Unload the sound so it releases the AVAudioSession before we hand it to
        // the recorder. Same native module, so the session transitions cleanly.
        if (active === sound) active = null
        await sound.unloadAsync().catch(() => {})
      }
    },
    async stopPlayback() {
      // Barge-in / teardown: unload the active sound (if any). Its playToEnd()
      // promise then resolves via the unloaded status, and the coordinator moves on.
      const sound = active
      active = null
      if (sound) await sound.unloadAsync().catch(() => {})
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
