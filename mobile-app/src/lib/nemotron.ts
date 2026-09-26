/**
 * nemotron — the call state machine for one Nemotron voicechat WebSocket.
 *
 * Mirrors the exact wire contract in viewer/routes/voice.py (_g_voice_nemotron_ws)
 * and viewer/nemotron.py (sanitize_event / open_upstream):
 *   client -> (binary) one complete recorded utterance
 *   server -> (text)   sanitized JSON `kind` events: ready / error / turn_end / ...
 *   server -> (binary) for a turn_end, the reply WAV — sent BEFORE that turn_end's
 *                       JSON frame, so a binary frame always belongs to the turn
 *                       whose turn_end follows it.
 *
 * No STT: the fork only ever returns the ASSISTANT's transcript (turn_end.text) —
 * never what the caller said. No tools, no duplex: the service itself reports
 * tools=false/duplex=false (see /api/voice/nemotron/status), and this class makes
 * no promise beyond exactly turn-based audio in, audio+text out.
 *
 * Hazards this class is deliberately defensive about (single-slot, one turn at a
 * time, server-owned conversation — see deploy/voicechat_service.py):
 *   - A turn that times out client-side must not leave the SOCKET alive: the
 *     server may still be mid-turn, and a late binary/turn_end for the timed-out
 *     turn could otherwise be misattributed to whatever turn is sent next. So a
 *     turn timeout closes the whole call — the caller must reconnect, never just
 *     retry sendTurn on the same instance.
 *   - Idle disconnects/errors (no turn in flight) must still reach the caller —
 *     an `onDown` hook fires on every teardown, not only when a promise is
 *     pending, so the hook-level UI can leave "listening" instead of hanging.
 *   - A close() that races an in-flight `saveAudio` must not leak the persisted
 *     temp file, and must not let that save resolve a turn that already settled
 *     (rejected) — `bindings.deleteAudio` cleans up a save that lands after the
 *     turn was invalidated.
 *   - A turn_end with no preceding binary frame, or a `saveAudio` that fails, is
 *     NEVER downgraded to a "successful" text-only result — the server always
 *     attaches audio to every turn_end (see VoiceChat.event in
 *     deploy/voicechat_service.py), so a missing/unsaved reply means the turn
 *     itself failed and must reject, not silently drop audio.
 *
 * Transport (opening the actual socket) and audio persistence (writing the reply
 * WAV somewhere playable) are injected via `NemotronBindings`, so this file has
 * no react-native or expo import and runs under the plain-Node test harness —
 * see nemotronNative.ts for the real wiring (RN WebSocket + expo-file-system).
 */

/** The subset of a WebSocket this class drives — real RN sockets satisfy it
 *  structurally, and a test can inject a minimal fake. */
export interface NemotronSocket {
  readonly readyState: number
  send(data: ArrayBuffer): void
  close(): void
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
}

/** Mirrors WebSocket.OPEN (1) without requiring the global to exist here. */
export const NEMOTRON_OPEN = 1

export type NemotronEvent =
  | { kind: "ready" }
  | { kind: "turn_end"; text?: unknown }
  | { kind: "error"; message?: unknown }
  | { kind: string; [k: string]: unknown }

export interface NemotronTurnResult {
  /** The assistant's transcript for this turn. Never the caller's speech. */
  text: string
  /** Wherever `saveAudio` persisted the reply WAV. Always set on a resolved
   *  turn — a turn whose audio is missing or fails to save REJECTS instead
   *  (see module doc); a resolved NemotronTurnResult always has real audio. */
  audioUri: string
}

export interface NemotronBindings {
  /** Open the connection; return a socket-like object this class drives. */
  openSocket(url: string, headers: Record<string, string>): NemotronSocket
  /** Persist one reply WAV; return where it landed, or null on failure. Must
   *  never throw — a failed save rejects the turn (see module doc), it never
   *  crashes the call. */
  saveAudio(data: ArrayBuffer): Promise<string | null>
  /** Delete a previously-saved reply that no turn will ever consume (the turn
   *  that requested it was already invalidated by timeout/close before the
   *  save finished). Optional; omit if the platform has no cleanup step. Must
   *  never throw. */
  deleteAudio?(uri: string): Promise<void>
}

function cleanText(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/**
 * One Nemotron call: opens on connect(), accepts turns via sendTurn() until
 * close(). Only one turn may be in flight at a time — the service itself holds
 * one active conversation per socket and is turn-based, not duplex.
 *
 * `onDown`, if set, fires exactly once per call (idle disconnect/error, or an
 * explicit close/timeout) — even when no turn or ready-wait is pending — so a
 * caller can always leave its "connected"/"listening" UI state.
 */
export class NemotronCall {
  onDown: ((err: Error) => void) | null = null

  private socket: NemotronSocket | null = null
  private ready = false
  private downFired = false
  private pendingReady: { resolve: () => void; reject: (e: Error) => void } | null = null
  private pendingTurn: {
    resolve: (r: NemotronTurnResult) => void
    reject: (e: Error) => void
    audio: ArrayBuffer | null
    settled: boolean
  } | null = null

  private bindings: NemotronBindings

  constructor(bindings: NemotronBindings) {
    this.bindings = bindings
  }

  /** True once `ready` has arrived and the socket is still open. A caller must
   *  never send audio before this is true. */
  get isReady(): boolean {
    return this.ready && this.socket?.readyState === NEMOTRON_OPEN
  }

  /** Open the socket and resolve once the service's `ready` event arrives (the
   *  model finished loading for this call). Rejects on error/close/timeout
   *  before that. Startup is bounded to 90s server-side; the default timeout
   *  here leaves headroom above that. */
  connect(url: string, headers: Record<string, string>, timeoutMs = 100000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.bindings.openSocket(url, headers)
      this.socket = socket
      const timer = setTimeout(() => {
        // Let teardown -> handleDown find and reject this.pendingReady itself
        // (below); nulling it here first would mean handleDown sees nothing
        // pending and this connect() promise would never settle at all.
        this.teardown(new Error("Nemotron connection timed out waiting for ready"))
      }, timeoutMs)
      this.pendingReady = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      socket.onmessage = (ev) => this.handleMessage(ev.data)
      socket.onerror = () => this.handleDown(new Error("Nemotron connection error"))
      socket.onclose = () => this.handleDown(new Error("Nemotron connection closed"))
    })
  }

  /** Idle/error/close teardown: reject anything pending AND notify `onDown`
   *  exactly once, even when nothing was pending (the idle-disconnect case a
   *  caller could otherwise miss and be left "listening" forever). */
  private handleDown(err: Error): void {
    this.ready = false
    const pr = this.pendingReady
    this.pendingReady = null
    if (pr) pr.reject(err)
    const pt = this.pendingTurn
    this.pendingTurn = null
    if (pt && !pt.settled) {
      pt.settled = true
      pt.reject(err)
    }
    if (!this.downFired) {
      this.downFired = true
      this.onDown?.(err)
    }
  }

  /** Force-close the socket as part of a teardown (timeout/explicit close) —
   *  distinct from handleDown's reaction to a socket the transport already
   *  dropped, this is what actively invalidates a still-open one. */
  private teardown(err: Error): void {
    const socket = this.socket
    this.socket = null
    this.handleDown(err)
    if (socket) {
      try {
        socket.close()
      } catch {
        /* already closing */
      }
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") {
      // Binary reply audio always arrives BEFORE its turn_end text frame.
      if (this.pendingTurn && !this.pendingTurn.settled) this.pendingTurn.audio = data as ArrayBuffer
      return
    }
    let event: NemotronEvent
    try {
      event = JSON.parse(data)
    } catch {
      return // malformed frame — never crash the call over one bad line
    }
    if (!event || typeof event !== "object") return
    if (event.kind === "ready") {
      this.ready = true
      const pr = this.pendingReady
      this.pendingReady = null
      pr?.resolve()
      return
    }
    if (event.kind === "error") {
      const err = new Error(cleanText((event as { message?: unknown }).message) || "Nemotron error")
      const pr = this.pendingReady
      if (pr) {
        this.pendingReady = null
        pr.reject(err)
        return
      }
      const pt = this.pendingTurn
      if (pt && !pt.settled) {
        this.pendingTurn = null
        pt.settled = true
        pt.reject(err)
      }
      return
    }
    if (event.kind === "turn_end") {
      const pt = this.pendingTurn
      if (!pt || pt.settled) return // stray — nothing awaiting it (e.g. already timed out)
      const text = cleanText((event as { text?: unknown }).text)
      const audio = pt.audio
      if (!audio) {
        // The service always attaches audio to a real turn_end (see module doc);
        // one arriving without it is a failure, never a "text-only" success.
        this.pendingTurn = null
        pt.settled = true
        pt.reject(new Error("Nemotron turn ended without reply audio"))
        return
      }
      // The turn stays pending until the save settles, so a close()/timeout
      // racing the save still finds it (handleDown) and rejects it — a turn
      // must never resolve after its call is already down.
      this.bindings
        .saveAudio(audio)
        .then((audioUri) => {
          if (pt.settled) {
            // This turn was already invalidated (timeout/close) while the save
            // was in flight — the save landed too late to satisfy anything, so
            // clean up the file rather than leak it, and never resolve/reject
            // an already-settled promise.
            if (audioUri) this.bindings.deleteAudio?.(audioUri).catch(() => {})
            return
          }
          this.pendingTurn = null
          pt.settled = true
          if (audioUri) {
            pt.resolve({ text, audioUri })
          } else {
            // A failed save is a failed turn, not a text-only success.
            pt.reject(new Error("Could not save the Nemotron reply audio"))
          }
        })
        .catch(() => {
          if (!pt.settled) {
            this.pendingTurn = null
            pt.settled = true
            pt.reject(new Error("Could not save the Nemotron reply audio"))
          }
        })
      return
    }
    // Any other kind (e.g. a transcript delta) is intermediate — no UI use yet,
    // and specifically never treated as something the user said (no STT here).
  }

  /** Send one complete recorded utterance; resolves with the assistant's reply
   *  once its turn_end arrives (or rejects on error/disconnect/timeout). Matches
   *  the server's own per-turn deadline (130s > the service's 120s) so a real
   *  {"kind":"error"} reaches the caller before this generic timeout would.
   *
   *  A client-side timeout INVALIDATES THE WHOLE CALL (closes the socket): the
   *  server may still be mid-turn, and a late binary/turn_end for this timed-out
   *  turn must never be misattributed to a turn sent after it. Callers must
   *  reconnect (a fresh NemotronCall) rather than retry sendTurn on this one. */
  sendTurn(buf: ArrayBuffer, timeoutMs = 130000): Promise<NemotronTurnResult> {
    if (!this.isReady || !this.socket) return Promise.reject(new Error("Nemotron call is not connected"))
    if (this.pendingTurn) return Promise.reject(new Error("A Nemotron turn is already in flight"))
    const socket = this.socket
    return new Promise((resolve, reject) => {
      const pending = {
        resolve: (r: NemotronTurnResult) => {
          clearTimeout(timer)
          resolve(r)
        },
        reject: (e: Error) => {
          clearTimeout(timer)
          reject(e)
        },
        audio: null as ArrayBuffer | null,
        settled: false,
      }
      const timer = setTimeout(() => {
        if (pending.settled) return
        pending.settled = true
        this.pendingTurn = null
        this.teardown(new Error("Nemotron turn timed out"))
        reject(new Error("Nemotron turn timed out"))
      }, timeoutMs)
      this.pendingTurn = pending
      try {
        socket.send(buf)
      } catch (e) {
        pending.settled = true
        clearTimeout(timer)
        this.pendingTurn = null
        reject(e as Error)
      }
    })
  }

  /** Tear down the socket. Idempotent; any in-flight ready/turn wait rejects
   *  immediately rather than lingering. Does NOT invoke `onDown` a second time
   *  if the call is already down (e.g. the transport beat us to it). */
  close(): void {
    this.teardown(new Error("Nemotron call closed"))
  }
}
