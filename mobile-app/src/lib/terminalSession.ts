import { api } from "../api/client"
import { token } from "../state/config"

/**
 * A process-wide terminal session that outlives the TerminalScreen.
 *
 * Why: the TerminalScreen's WebView (xterm) unmounts whenever you navigate away
 * (back to Files, over to Chat, …). If the WebSocket lived on the screen it would
 * close on unmount and the server would kill the PTY — losing your shell and
 * scrollback. So the socket lives here instead, in a module singleton: it stays
 * open across navigation, keeps the PTY alive, and buffers all server output so a
 * freshly-remounted xterm can replay the scrollback and reattach seamlessly.
 *
 * (This survives NAVIGATION, not full app close — when the app is killed the OS
 * drops the socket and the server reaps the PTY. Persisting across app close would
 * need a server-side reattachable PTY.)
 */

type Listener = (b64: string) => void

// Cap the replay buffer so a chatty process can't grow it without bound. ~512 KB
// of base64 is plenty of scrollback; older chunks fall off the front.
const BUFFER_CAP = 512 * 1024

let ws: WebSocket | null = null
let sessionHost: string | null = null
let buffer: string[] = []
let bufferLen = 0
let listener: Listener | null = null

function b64FromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bytes).toString("base64")
}

function pushBuffer(b64: string) {
  buffer.push(b64)
  bufferLen += b64.length
  while (bufferLen > BUFFER_CAP && buffer.length > 1) {
    bufferLen -= buffer.shift()!.length
  }
}

function openSocket(host: string, cols: number, rows: number) {
  const url = api.terminalWsUrl({ cols, rows, host })
  // RN WebSocket: 3rd arg carries headers (a browser WS can't) — this is what lets
  // the terminal authenticate with a Bearer token on the handshake.
  const WS = WebSocket as unknown as new (url: string, protocols?: string | string[], options?: unknown) => WebSocket
  const sock = new WS(url, undefined, { headers: { Authorization: `Bearer ${token()}` } })
  sock.binaryType = "arraybuffer"
  sock.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return
    const b64 = b64FromArrayBuffer(e.data)
    pushBuffer(b64) // keep for replay even while detached (no WebView attached)
    listener?.(b64)
  }
  sock.onclose = () => {
    if (ws === sock) {
      ws = null
      sessionHost = null
      buffer = []
      bufferLen = 0
    }
  }
  ws = sock
  sessionHost = host
}

/**
 * Attach a live WebView writer to the session, opening the socket if needed.
 * Switching host tears down the old session (its PTY) and starts fresh.
 * Returns the buffered output to replay into the freshly-opened xterm.
 */
export function attachTerminal(host: string, cols: number, rows: number, onData: Listener): string[] {
  if (ws && sessionHost !== host) {
    ws.close()
    ws = null
    sessionHost = null
    buffer = []
    bufferLen = 0
  }
  if (!ws) {
    buffer = []
    bufferLen = 0
    openSocket(host, cols, rows)
  }
  listener = onData
  return buffer.slice()
}

/** Detach the WebView writer but KEEP the socket + buffer alive (navigation away). */
export function detachTerminal(onData: Listener) {
  if (listener === onData) listener = null
}

/** Forward an input/resize frame (already in the server's wire format) to the PTY. */
export function sendTerminal(raw: string) {
  if (ws && ws.readyState === 1) ws.send(raw)
}
