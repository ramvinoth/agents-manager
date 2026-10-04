/**
 * A WebSocket handle returned synchronously while the real socket is still
 * being chosen. Opening a socket to a server first has to decide HOW to reach
 * it (direct address or Harman relay — an async probe, see
 * src/api/transport.ts), but every consumer (voice, call, terminal) wants a
 * socket object right away to hang its handlers on. This forwards to the real
 * one once attached, and behaves like a socket that never opened if the
 * choice fails.
 *
 * Pure: no react-native import, node-tested.
 */

/** The WebSocket surface the app's socket consumers use. Both the RN
 *  WebSocket and relayTransport's RelaySocket satisfy it. */
export interface AppSocket {
  binaryType: string
  readonly readyState: number
  send(data: string | ArrayBuffer | Uint8Array): void
  close(code?: number): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: { message?: string }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
}

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

export class DeferredSocket implements AppSocket {
  binaryType = "arraybuffer"
  readyState = CONNECTING
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: { message?: string }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null

  private inner: AppSocket | null = null

  /** Hand over the real socket. If it closes without ever opening, `retry`
   *  may attach a replacement (the relay, when the direct address turned out
   *  unreachable) and return true; the consumer then never sees the failed
   *  attempt. Otherwise its error and close are reported as usual. */
  attach(inner: AppSocket, retry?: () => boolean) {
    if (this.readyState === CLOSED) {
      // The consumer gave up while the route was being chosen.
      try {
        inner.close()
      } catch {
        // never opened
      }
      return
    }
    this.inner = inner
    inner.binaryType = "arraybuffer"
    let opened = false
    let earlyError: { message?: string } | null = null
    inner.onopen = (ev) => {
      opened = true
      if (this.inner !== inner || this.readyState !== CONNECTING) return
      this.readyState = OPEN
      this.onopen?.(ev)
    }
    inner.onmessage = (ev) => {
      if (this.inner === inner) this.onmessage?.(ev)
    }
    inner.onerror = (ev) => {
      if (this.inner !== inner) return
      if (opened) this.onerror?.(ev)
      else earlyError = ev // held until we know whether a retry absorbs it
    }
    inner.onclose = (ev) => {
      if (this.inner !== inner) return
      if (!opened && this.readyState === CONNECTING && retry?.()) return
      if (earlyError) this.onerror?.(earlyError)
      this.closed(ev)
    }
  }

  /** The route could not be chosen or dialed: report it like a socket that
   *  failed to connect. */
  fail(err: Error) {
    if (this.readyState === CLOSED) return
    this.onerror?.({ message: err.message })
    this.closed({ code: 1006, reason: err.message })
  }

  send(data: string | ArrayBuffer | Uint8Array) {
    if (this.readyState !== OPEN || !this.inner) throw new Error("WebSocket is not open")
    this.inner.send(data)
  }

  close(code?: number) {
    if (this.readyState >= CLOSING) return
    if (!this.inner) {
      this.closed({ code: code ?? 1000, reason: "" })
      return
    }
    this.readyState = CLOSING
    this.inner.close(code)
  }

  private closed(ev: { code?: number; reason?: string }) {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.onclose?.(ev)
  }
}
