/**
 * audioSession — the SINGLE owner of the iOS AVAudioSession (pure state machine).
 *
 * The app has one hardware audio session (iOS AVAudioSession). Recording (STT)
 * and playback (TTS) both go through expo-av, so a single native module owns it.
 * Even so, they are mutually exclusive operations, and if recording tried to start
 * before playback released the session the recorder would fail to prepare. This
 * coordinator enforces the ordering.
 *
 * This class is the ONLY place allowed to drive record/playback transitions. It
 * enforces one invariant:
 *
 *     recording and playback are mutually exclusive, and every transition is
 *     fully awaited — a recording cannot begin until playback has emitted its
 *     terminal event AND released the session, and vice-versa.
 *
 * Record/play transitions run through one serialized queue (`chain`). Stop
 * interrupts the active player outside that queue, so it cannot deadlock behind
 * playback; the queued transition still waits for native cleanup.
 *
 * This file has NO react-native imports so it runs under the plain-Node test
 * harness. The native backend (expo-av) is injected via
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
 * the state machine pure and testable; the real implementation uses expo-av.
 */
export interface AudioBackend {
  requestPermission(): Promise<boolean>
  /** Put the session into record+play mode (the ONE canonical config). */
  setRecordMode(): Promise<void>
  /** Apply record mode against a session ALREADY activated by CallKit — sets the
   *  category/mode only, never (re)activates. Optional: backends without CallKit
   *  can omit it and the coordinator falls back to setRecordMode(). */
  adoptRecordMode?(): Promise<void>
  /** Create + start a recorder in the already-set record mode. */
  startRecorder(options: unknown): Promise<RecordingHandle>
  /** Start playback of a URL and RESOLVE ONLY when playback has finished AND the
   *  player has released the audio session. */
  playToEnd(url: string, headers: Record<string, string>): Promise<void>
  /** Force playback to stop and release the session now (barge-in / teardown). */
  stopPlayback(): Promise<void>
  /** Set the volume (0..1) of the currently-playing sound, live — used for barge-in
   *  ducking (lower TTS while the user speaks). No-op if nothing is playing. */
  setPlaybackVolume?(v: number): Promise<void>
}

export class AudioSession {
  private state: SessionState = "idle"
  private recorder: RecordingHandle | null = null
  private configured = false
  private backend: AudioBackend
  // Serializes every public transition so native calls never interleave.
  private chain: Promise<unknown> = Promise.resolve()
  // Bumped by stopPlayback() to invalidate any play() that hasn't reached its
  // native call yet — either still queued behind an earlier transition, or
  // mid-load. Without this, "End" during playback would enqueue BEHIND the
  // very play() it's trying to interrupt (play() only resolves once its own
  // native call finishes) and could never run at all — a real deadlock, not
  // just a slow cancel. So stopPlayback bypasses the queue entirely (like
  // setPlaybackVolume below) and acts immediately, both by telling the
  // backend to release the session now AND by invalidating this token so a
  // play() still waiting its turn in the queue skips straight past instead of
  // starting playback nobody wants anymore.
  private playToken = 0

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
   *
   * Automatically sets playsInSilentModeIOS so read-aloud works even if no
   * Voice/Call screen has configured the session yet.
   */
  play(url: string, headers: Record<string, string>): Promise<void> {
    const token = ++this.playToken
    return this.enqueue(async () => {
      // A stopPlayback() (or a newer play()) already fired while this one sat
      // queued behind an earlier transition — nobody wants this playback
      // anymore, so skip the native call entirely rather than starting audio
      // just to immediately race it back down.
      if (token !== this.playToken) return
      await this.dropRecorder()
      // Ensure the audio mode is set so playback works in silent mode. This is
      // idempotent if configure() already ran (Voice/Call). Without it, a
      // read-aloud tap from the thread (no prior configure) would be silent.
      await this.backend.setRecordMode()
      if (token !== this.playToken) return
      this.state = "playing"
      try {
        await this.backend.playToEnd(url, headers)
      } finally {
        if (this.state === "playing") this.state = "idle"
      }
    })
  }

  /** Stop any playback now (barge-in / end-call). Idempotent. NOT enqueued —
   *  a queued stopPlayback would sit BEHIND the very play() it's trying to
   *  interrupt (play() only resolves once playToEnd itself resolves), which
   *  is a deadlock disguised as a slow cancel, not a real interruption. So
   *  this acts immediately: it invalidates any play() still waiting in the
   *  queue (via playToken, so it never starts) or already loading/playing
   *  (the backend call below stops it), then resolves once the backend
   *  confirms the session is released — same observable contract as before
   *  (await stopPlayback() means "safe to record now"), just not
   *  queue-ordered against play(). */
  async stopPlayback(): Promise<void> {
    const token = ++this.playToken
    await this.backend.stopPlayback()
    if (token === this.playToken && this.state === "playing") this.state = "idle"
  }

  /** Live volume of the current playback (0..1) for barge-in ducking. NOT enqueued
   *  — it's a fire-and-forget tweak on the already-playing sound and must not wait
   *  behind the long-running play() task (which only resolves at end of speech). */
  async setPlaybackVolume(v: number): Promise<void> {
    if (this.backend.setPlaybackVolume) await this.backend.setPlaybackVolume(v)
  }

  /** Re-assert record mode without starting a recorder (used before a metered
   *  hands-free window whose recorder the caller constructs). */
  ensureRecordMode(): Promise<void> {
    return this.enqueue(() => this.toRecordMode())
  }

  /**
   * Adopt an AVAudioSession that CallKit has just activated
   * (`didActivateAudioSession`). CallKit owns activation for a call; we only set
   * OUR record+play mode on top so the hands-free loop can record/play. Never
   * (re)activates the session — that's CallKit's job — which is what keeps the two
   * from fighting over the one session. Falls back to setRecordMode() on backends
   * that don't implement the CallKit-specific path.
   */
  adoptActiveSession(): Promise<void> {
    return this.enqueue(async () => {
      if (this.state === "playing") {
        await this.backend.stopPlayback()
        this.state = "idle"
      }
      if (this.backend.adoptRecordMode) {
        await this.backend.adoptRecordMode()
      } else {
        await this.backend.setRecordMode()
      }
      this.configured = true
    })
  }

  /** Release everything (screen unmount). Idempotent, awaited. */
  reset(): Promise<void> {
    const stopped = this.stopPlayback()
    return this.enqueue(async () => {
      await stopped
      await this.dropRecorder()
      this.state = "idle"
    })
  }
}
