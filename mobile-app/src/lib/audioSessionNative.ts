/**
 * audioSessionNative — wires the real expo-av + react-native-track-player calls
 * into the pure AudioSession coordinator, and exposes the app-wide singleton.
 *
 * This is the ONLY module (besides voice.ts's recorder-metering for the VAD
 * window) that touches expo-av's Audio mode / recorder or TrackPlayer. Keeping
 * the native wiring here lets audioSession.ts stay pure + unit-tested.
 */
import { Audio } from "expo-av"
import TrackPlayer, { Event, State } from "react-native-track-player"
import { AudioSession, type AudioBackend, type RecordingHandle } from "./audioSession"

// The ONE canonical audio mode: record + play, audible with the ring switch off,
// and kept alive when backgrounded/locked (pairs with UIBackgroundModes:["audio"]
// in app.json for hands-free listening).
export const RECORD_MODE = {
  allowsRecordingIOS: true,
  playsInSilentModeIOS: true,
  staysActiveInBackground: true,
} as const

let _tpReady = false
async function _ensurePlayer(): Promise<void> {
  if (_tpReady) return
  try {
    await TrackPlayer.setupPlayer()
  } catch {
    /* already set up — setupPlayer throws if called twice */
  }
  _tpReady = true
}

function defaultBackend(): AudioBackend {
  return {
    async requestPermission() {
      const perm = await Audio.requestPermissionsAsync()
      return perm.granted
    },
    async setRecordMode() {
      await Audio.setAudioModeAsync(RECORD_MODE)
    },
    async startRecorder(options) {
      const { recording } = await Audio.Recording.createAsync(options as Audio.RecordingOptions)
      return recording as unknown as RecordingHandle
    },
    async playToEnd(url, headers) {
      await _ensurePlayer()
      await TrackPlayer.reset()
      await TrackPlayer.add({ id: "tts", url, headers, title: "Reply", artist: "Harman" })
      await TrackPlayer.play()
      // Resolve when playback truly ends (started, then reached a terminal state)
      // OR when the queue empties — whichever fires first.
      await new Promise<void>((resolve) => {
        let started = false
        let done = false
        const finish = () => {
          if (done) return
          done = true
          subState.remove()
          subQueue.remove()
          resolve()
        }
        const subState = TrackPlayer.addEventListener(Event.PlaybackState, (e) => {
          if (e.state === State.Playing) started = true
          if (
            started &&
            (e.state === State.Ended || e.state === State.Stopped || e.state === State.None)
          ) {
            finish()
          }
        })
        const subQueue = TrackPlayer.addEventListener(Event.PlaybackQueueEnded, finish)
      })
      // Deterministically release the session before returning, so the caller can
      // immediately transition to recording with the session provably free.
      await TrackPlayer.reset()
    },
    async stopPlayback() {
      await _ensurePlayer()
      await TrackPlayer.reset()
    },
  }
}

/** The app-wide single owner of the audio session. */
export const audioSession = new AudioSession(defaultBackend())
