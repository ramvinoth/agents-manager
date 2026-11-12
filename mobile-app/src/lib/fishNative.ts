/**
 * fishNative — binds the native HarmanAudio module (echo-cancelled capture and
 * playback on ONE engine) to the FishAudio interface fishCall.ts expects.
 */
import { HarmanAudio } from "../../modules/harman-audio/src"
import type { FishAudio } from "./fishCall"

let errorSub: { remove(): void } | null = null

export const fishAudioAvailable = (): boolean => HarmanAudio.isAvailable()

export const nativeFishAudio: FishAudio = {
  start: async (rate) => {
    // Native capture/engine failures used to vanish; surface them in the device log.
    errorSub?.remove()
    errorSub = HarmanAudio.addErrorListener((e) => console.warn("[harman-audio]", e.message ?? "unknown error"))
    await HarmanAudio.start(rate)
  },
  stop: async () => {
    errorSub?.remove()
    errorSub = null
    await HarmanAudio.stop()
  },
  onFrame: (cb) => {
    const sub = HarmanAudio.addFrameListener((f) => cb(f.pcm))
    return () => sub.remove()
  },
  onDrained: (cb) => {
    const sub = HarmanAudio.addDrainedListener(cb)
    return () => sub.remove()
  },
  enqueue: (pcm, rate) => HarmanAudio.enqueue(pcm, rate),
  flush: () => HarmanAudio.flushPlayback(),
}
