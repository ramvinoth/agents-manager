/**
 * audioSession — the SINGLE owner of the iOS AVAudioSession (pure state machine).
 *
 * The app has two audio libraries that each want the one hardware audio session:
 * expo-av (recording, for STT) and react-native-track-player (streaming TTS
 * playback). If both mutate the session independently, the classic failure is
 * "recorder not prepared" on the second turn — playback still holds the session
 * when the next recording tries to start.
 *
 * This class is the ONLY place allowed to drive record/playback transitions. It
 * enforces one invariant:
 *
 *     recording and playback are mutually exclusive, and every transition is
 *     fully awaited — a recording cannot begin until playback has emitted its
 *     terminal event AND released the session, and vice-versa.
 *
 * Correctness comes from ORDERING, not from retries or sleeps. All public calls
 * run through a single serialized queue (`chain`) so overlapping requests from
 * the UI (e.g. speak() then record()) can never interleave their native calls.
 *
 * This file has NO react-native imports so it runs under the plain-Node test
 * harness. The native backend (expo-av + track-player) is injected via
 * `AudioBackend`; the real wiring + app singleton live in `audioSessionNative.ts`.
 */

export type SessionState = "idle" | "recording" | "playing"

/** A live recording handle — just the subset the app needs. Matches
 *  Audio.Recording so the real backend can return one directly. */
export interface RecordingHandle {
  stopAndUnloadAsync(): Promise<unknown>
  getURI(): string | null
}

/**
 * The native operations the coordinator drives. Injecting this interface keeps
 * the state machine pure and testable; the real impl wires expo-av + track-player.
 */
export interface AudioBackend {
  requestPermission(): Promise<boolean>
  /** Put the session into record+play mode (the ONE canonical config). */
  setRecordMode(): Promise<void>
  /** Create + start a recorder in the already-set record mode. */
  startRecorder(options: unknown): Promise<RecordingHandle>
  /** Start playback of a URL and RESOLVE ONLY when playback has finished AND the
   *  player has released the audio session. */
  playToEnd(url: string, headers: Record<string, string>): Promise<void>
  /** Force playback to stop and release the session now (barge-in / teardown). */
  stopPlayback(): Promise<void>
}

export class AudioSession {
  private state: SessionState = "idle"
  private recorder: RecordingHandle | null = null
  private configured = false
  private backend: AudioBackend
  // Serializes every public transition so native calls never interleave.
  private chain: Promise<unknown> = Promise.resolve()

  constructor(backend: AudioBackend) {
    this.backend = backend
  }

  getState(): SessionState {
    return this.state
  }

  isConfigured(): boolean {
    return this.configured
  }

  /** Run `fn` after all previously-queued transitions complete. This is the
   *  mutual-exclusion mechanism: one operation's native calls fully finish before
   *  the next begins, so record/play can never race for the session. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    // Keep the chain alive regardless of individual success/failure.
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** Release a stranded recorder, swallowing errors. */
  private async dropRecorder(): Promise<void> {
    const rec = this.recorder
    this.recorder = null
    if (!rec) return
    try {
      await rec.stopAndUnloadAsync()
    } catch {
      /* already stopped/unloaded */
    }
  }

  /** Ensure no playback holds the session, then enter record mode. In-queue. */
  private async toRecordMode(): Promise<void> {
    if (this.state === "playing") {
      await this.backend.stopPlayback()
      this.state = "idle"
    }
    await this.backend.setRecordMode()
  }

  /** Request mic permission once and set the canonical record mode. Returns
   *  whether the mic is available. Idempotent. */
  configure(): Promise<boolean> {
    return this.enqueue(async () => {
      const granted = await this.backend.requestPermission()
      if (!granted) return false
      await this.backend.setRecordMode()
      this.configured = true
      return true
    })
  }

  /**
   * Start recording. If playback is active it is stopped and the session released
   * FIRST (awaited), so the recorder always prepares against a free session — no
   * retry, no sleep. Returns the live recorder handle.
   */
  record(options: unknown): Promise<RecordingHandle> {
    return this.enqueue(async () => {
      await this.dropRecorder()
      await this.toRecordMode()
      const rec = await this.backend.startRecorder(options)
      this.recorder = rec
      this.state = "recording"
      return rec
    })
  }

  /** Stop the current recording and return its file URI (or null). → idle. */
  stopRecording(): Promise<string | null> {
    return this.enqueue(async () => {
      const rec = this.recorder
      this.recorder = null
      if (!rec) {
        if (this.state === "recording") this.state = "idle"
        return null
      }
      try {
        await rec.stopAndUnloadAsync()
      } catch {
        /* already stopped */
      }
      this.state = "idle"
      return rec.getURI()
    })
  }

  /**
   * Play a TTS stream to completion. If a recording is active it is stopped FIRST.
   * Resolves only after playback finishes and the session is released, so a
   * following record() sees a free session.
   */
  play(url: string, headers: Record<string, string>): Promise<void> {
    return this.enqueue(async () => {
      await this.dropRecorder()
      this.state = "playing"
      try {
        await this.backend.playToEnd(url, headers)
      } finally {
        this.state = "idle"
      }
    })
  }

  /** Stop any playback now (barge-in). → idle. Idempotent. */
  stopPlayback(): Promise<void> {
    return this.enqueue(async () => {
      await this.backend.stopPlayback()
      if (this.state === "playing") this.state = "idle"
    })
  }

  /** Re-assert record mode without starting a recorder (used before a metered
   *  hands-free window whose recorder the caller constructs). */
  ensureRecordMode(): Promise<void> {
    return this.enqueue(() => this.toRecordMode())
  }

  /** Release everything (screen unmount). Idempotent, awaited. */
  reset(): Promise<void> {
    return this.enqueue(async () => {
      await this.dropRecorder()
      await this.backend.stopPlayback()
      this.state = "idle"
    })
  }
}
