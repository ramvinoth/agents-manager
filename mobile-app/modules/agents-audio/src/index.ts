import { requireNativeModule, EventEmitter, type Subscription } from "expo-modules-core"

/** One PCM frame emitted by the native voiceProcessingIO tap. `pcm` is base64
 *  16-bit signed little-endian mono at `sampleRate`. */
export interface AgentsAudioFrame {
  pcm: string
  sampleRate: number
  frames: number
}

interface AgentsAudioNative {
  start(sampleRate: number): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
}

// Autolinked local Expo module (modules/agents-audio). On a platform without the
// native module (Android today, or web), requireNativeModule throws — callers
// (duplexMic.ts) guard with `isAvailable`.
let native: AgentsAudioNative | null = null
try {
  native = requireNativeModule<AgentsAudioNative>("AgentsAudio")
} catch {
  native = null
}

const emitter = native ? new EventEmitter(native as any) : null

export const AgentsAudio = {
  /** Whether the native echo-cancelling capture module is present on this build. */
  isAvailable(): boolean {
    return native != null
  },

  /** Start echo-cancelled capture, emitting `onFrame` at `sampleRate` (Hz). */
  async start(sampleRate = 16000): Promise<void> {
    if (!native) throw new Error("AgentsAudio native module unavailable")
    await native.start(sampleRate)
  },

  /** Stop capture and tear down the audio engine tap. */
  async stop(): Promise<void> {
    if (!native) return
    await native.stop()
  },

  isRunning(): boolean {
    return native ? native.isRunning() : false
  },

  /** Subscribe to PCM frames. Returns a Subscription — call `.remove()` to stop. */
  addFrameListener(cb: (frame: AgentsAudioFrame) => void): Subscription {
    if (!emitter) return { remove() {} } as Subscription
    return emitter.addListener<AgentsAudioFrame>("onFrame", cb)
  },

  addErrorListener(cb: (e: { message?: string }) => void): Subscription {
    if (!emitter) return { remove() {} } as Subscription
    return emitter.addListener("onError", cb)
  },
}
