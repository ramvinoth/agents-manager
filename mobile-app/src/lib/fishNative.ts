/**
 * fishNative — binds the native AgentsAudio module (echo-cancelled capture and
 * playback on ONE engine) to the FishAudio interface fishCall.ts expects.
 */
import { AgentsAudio } from "../../modules/agents-audio/src"
import type { FishAudio } from "./fishCall"

let errorSub: { remove(): void } | null = null

export const fishAudioAvailable = (): boolean => AgentsAudio.isAvailable()

export const nativeFishAudio: FishAudio = {
  start: async (rate) => {
    // Native capture/engine failures used to vanish; surface them in the device log.
    errorSub?.remove()
    errorSub = AgentsAudio.addErrorListener((e) => console.warn("[agents-audio]", e.message ?? "unknown error"))
    await AgentsAudio.start(rate)
  },
  stop: async () => {
    errorSub?.remove()
    errorSub = null
    await AgentsAudio.stop()
  },
  onFrame: (cb) => {
    const sub = AgentsAudio.addFrameListener((f) => cb(f.pcm))
    return () => sub.remove()
  },
  onDrained: (cb) => {
    const sub = AgentsAudio.addDrainedListener(cb)
    return () => sub.remove()
  },
  enqueue: (pcm, rate) => AgentsAudio.enqueue(pcm, rate),
  flush: () => AgentsAudio.flushPlayback(),
}
