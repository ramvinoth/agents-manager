/**
 * Tests for the AudioSession coordinator — the single owner of the audio session.
 *
 * Runs in plain Node, no simulator, no install:
 *     node --experimental-strip-types src/lib/audioSession.test.ts
 *
 * audioSession.ts has NO react-native imports so this stays possible. It proves
 * the invariant that fixes "recorder not prepared" on the 2nd turn: recording and
 * playback are mutually exclusive and a record() during/after play() only starts
 * once playback has released the session — by ORDERING, not retries.
 */
import assert from "node:assert"
import { AudioSession, type AudioBackend, type RecordingHandle } from "./audioSession.ts"

let passed = 0
function test(name: string, fn: () => Promise<void> | void) {
  Promise.resolve()
    .then(fn)
    .then(
      () => {
        passed++
      },
      (e) => {
        console.error(`✖ ${name}\n  ${(e as Error).message}`)
        process.exitCode = 1
      }
    )
}

const tick = () => new Promise((r) => setTimeout(r, 5))

/** A mock backend that RECORDS the exact order of native operations and refuses
 *  to allow a recorder to start while playback holds the session — mirroring iOS,
 *  which throws "recorder not prepared" in exactly that situation. If ordering is
 *  wrong, the mock throws, so the test catches the real-world failure. */
function makeBackend() {
  const log: string[] = []
  let sessionHeldByPlayback = false
  let endPlayback: (() => void) | null = null

  const backend: AudioBackend = {
    async requestPermission() {
      log.push("permission")
      return true
    },
    async setRecordMode() {
      await tick()
      log.push("setRecordMode")
    },
    async adoptRecordMode() {
      await tick()
      log.push("adoptRecordMode")
    },
    async startRecorder() {
      await tick()
      // This is the crux: iOS throws here if playback still owns the session.
      if (sessionHeldByPlayback) {
        throw new Error("recorder not prepared (session held by playback)")
      }
      log.push("startRecorder")
      const rec: RecordingHandle = {
        async stopAndUnloadAsync() {
          log.push("stopRecorder")
        },
        getURI: () => "file:///clip.m4a",
      }
      return rec
    },
    async playToEnd() {
      log.push("playStart")
      sessionHeldByPlayback = true
      // Playback stays open until the test releases it, modelling a real reply.
      await new Promise<void>((resolve) => {
        endPlayback = () => {
          sessionHeldByPlayback = false
          log.push("playReleased")
          resolve()
        }
      })
    },
    async stopPlayback() {
      if (sessionHeldByPlayback && endPlayback) endPlayback()
      else log.push("stopPlaybackNoop")
    },
  }
  return {
    backend,
    log,
    finishPlayback: () => endPlayback?.(),
    isHeld: () => sessionHeldByPlayback,
  }
}

// ---- Tests ------------------------------------------------------------------

test("record → play → record → play serializes; 2nd record waits for release", async () => {
  const m = makeBackend()
  const s = new AudioSession(m.backend)

  await s.configure()
  // Turn 1: record then stop.
  const r1 = await s.record({})
  assert.equal(s.getState(), "recording")
  await s.stopRecording()
  assert.equal(s.getState(), "idle")

  // Play the reply — but DON'T let it finish yet.
  const playing = s.play("wss://tts", {})
  await tick()
  assert.equal(s.getState(), "playing")
  assert.ok(m.isHeld(), "playback should hold the session")

  // Turn 2: request record WHILE playback is still active. The coordinator must
  // NOT start the recorder until playback releases — otherwise the mock throws.
  const r2p = s.record({})
  await tick()
  // Still held: record must be queued, not started.
  assert.ok(m.isHeld(), "record must wait — playback still holds session")

  // Now let playback finish; the queued record should then succeed cleanly.
  m.finishPlayback()
  await playing
  const r2 = await r2p
  assert.equal(s.getState(), "recording")
  assert.ok(r2, "second recorder started after release")

  await s.stopRecording()

  // The order proves correctness: playback fully released BEFORE the 2nd recorder.
  assert.deepEqual(m.log, [
    "permission",
    "setRecordMode",
    "setRecordMode",
    "startRecorder",
    "stopRecorder",
    "playStart",
    "playReleased",
    "setRecordMode",
    "startRecorder",
    "stopRecorder",
  ])
  assert.ok(r1 && r2)
})

test("play() while recording stops the recorder first", async () => {
  const m = makeBackend()
  const s = new AudioSession(m.backend)
  await s.configure()
  await s.record({})
  assert.equal(s.getState(), "recording")
  const playing = s.play("wss://tts", {})
  await tick()
  assert.equal(s.getState(), "playing")
  m.finishPlayback()
  await playing
  assert.equal(s.getState(), "idle")
  // Recorder was stopped before playback started.
  assert.ok(m.log.indexOf("stopRecorder") < m.log.indexOf("playStart"))
})

test("overlapping record() calls never interleave — last one wins the session", async () => {
  const m = makeBackend()
  const s = new AudioSession(m.backend)
  await s.configure()
  // Fire two records without awaiting — the queue must serialize them.
  const a = s.record({})
  const b = s.record({})
  await Promise.all([a, b])
  assert.equal(s.getState(), "recording")
  // startRecorder must appear exactly twice, each preceded by setRecordMode, and
  // the first recorder is released before the second starts.
  const starts = m.log.filter((x) => x === "startRecorder").length
  assert.equal(starts, 2)
  assert.ok(m.log.indexOf("stopRecorder") < m.log.lastIndexOf("startRecorder"))
})

test("reset() releases recorder and playback", async () => {
  const m = makeBackend()
  const s = new AudioSession(m.backend)
  await s.configure()
  await s.record({})
  await s.reset()
  assert.equal(s.getState(), "idle")
  assert.ok(m.log.includes("stopRecorder"))
})

test("adoptActiveSession uses the CallKit path (adoptRecordMode, no re-activate)", async () => {
  const m = makeBackend()
  const s = new AudioSession(m.backend)
  // CallKit fires didActivateAudioSession -> adopt. It must set OUR record mode via
  // adoptRecordMode() (the non-activating path), NOT the plain setRecordMode().
  await s.adoptActiveSession()
  assert.ok(s.isConfigured(), "adopting marks the session configured")
  assert.ok(m.log.includes("adoptRecordMode"), "used the CallKit adopt path")
  assert.ok(!m.log.includes("setRecordMode"), "did not use the activating path")
  // A record right after adopting starts cleanly (session is hot from CallKit).
  const r = await s.record({})
  assert.equal(s.getState(), "recording")
  assert.ok(r)
})

test("adoptActiveSession falls back to setRecordMode when adopt path is absent", async () => {
  const m = makeBackend()
  // A backend WITHOUT the optional CallKit path (e.g. non-call use).
  delete (m.backend as { adoptRecordMode?: () => Promise<void> }).adoptRecordMode
  const s = new AudioSession(m.backend)
  await s.adoptActiveSession()
  assert.ok(m.log.includes("setRecordMode"), "fell back to the plain path")
})

// Report after the microtask/timer queue drains.
setTimeout(() => {
  if (!process.exitCode) console.log(`${passed} passing`)
}, 100)
