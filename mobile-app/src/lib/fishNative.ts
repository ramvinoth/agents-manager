/**
 * fishNative — binds the native HarmanAudio module (echo-cancelled capture and
 * playback on ONE engine) to the FishAudio interface fishCall.ts expects.
 */
import { HarmanAudio } from "../../modules/harman-audio/src"
import type { FishAudio } from "./fishCall"

export const fishAudioAvailable = (): boolean => HarmanAudio.isAvailable()

export const nativeFishAudio: FishAudio = {
  start: (rate) => HarmanAudio.start(rate),
  stop: () => HarmanAudio.stop(),
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
