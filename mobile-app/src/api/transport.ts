/**
 * The React Native wiring for lib/serverTransport: one ServerTransport for the
 * ACTIVE server, built from its saved routes (direct address, relay route or
 * both) and rebuilt whenever those change — a server switch, a re-pair that
 * adds a relay route, a removal. Every request and socket in the app goes
 * through here; nothing else builds a server URL.
 */
import * as Crypto from "expo-crypto"
import * as FileSystem from "expo-file-system"
import { fromBase64, toBase64 } from "../lib/bytes"
import type { AppSocket } from "../lib/deferredSocket"
import type { WireSocket } from "../lib/relayTransport"
import { directUrl } from "../lib/servers"
import { ServerTransport, type DirectIO, type FilePart, type MediaSource, type Reply } from "../lib/serverTransport"
import { activeServer, token } from "../state/config"

/** RN's WebSocket takes a 3rd `options` arg carrying handshake headers (so the
 *  Bearer token never rides the URL); the TS lib types only declare two. */
const HeaderedWebSocket = WebSocket as unknown as {
  new (url: string, protocols: undefined, options: { headers: Record<string, string> }): AppSocket
}

const direct: DirectIO = {
  fetch: (url, init) => fetch(url, init),
  upload(url, headers, file) {
    const form = new FormData()
    // @ts-expect-error RN FormData accepts the {uri,name,type} file shape and
    // streams the file from disk; fetch adds the multipart boundary itself.
    form.append(file.field, { uri: file.uri, name: file.name, type: file.type })
    return fetch(url, { method: "POST", headers, body: form })
  },
  async download(url, headers, dest) {
    return (await FileSystem.downloadAsync(url, dest, { headers })).status
  },
  socket: (url, headers) => new HeaderedWebSocket(url, undefined, { headers }),
}

const files = {
  read: async (uri: string) =>
    fromBase64(await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })),
  write: (uri: string, data: Uint8Array) =>
    FileSystem.writeAsStringAsync(uri, toBase64(data), { encoding: FileSystem.EncodingType.Base64 }),
}

let current: { key: string; transport: ServerTransport } | null = null

/** The transport for the active server's current routes. */
function transport(): ServerTransport {
  const entry = activeServer()
  const routes = { direct: directUrl(entry), relay: entry?.relay }
  const key = JSON.stringify(routes)
  if (current?.key !== key) {
    current?.transport.close()
    current = {
      key,
      transport: new ServerTransport(routes, {
        direct,
        files,
        relay: { WebSocket: WebSocket as unknown as new (url: string) => WireSocket, randomBytes: Crypto.getRandomBytes },
      }),
    }
  }
  return current.transport
}

export function authHeaders(): Record<string, string> {
  const t = token()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

/** An authenticated request to the active server. */
export function serverFetch(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return transport().fetch(method, path, { ...authHeaders(), ...headers }, body)
}

/** Upload one local file as a multipart part named `field`. */
export function serverUpload(path: string, file: FilePart): Promise<Reply> {
  return transport().upload(path, authHeaders(), file)
}

/** Save an authenticated GET to `dest`; resolves the HTTP status. */
export function serverDownload(path: string, dest: string): Promise<number> {
  return transport().download(path, authHeaders(), dest)
}

/** Where to play an authenticated audio stream from (see ServerTransport.media). */
export function serverMedia(path: string, dest: string): Promise<MediaSource> {
  return transport().media(path, authHeaders(), dest)
}

/** An authenticated WebSocket to `path` (an /api/ route). */
export function serverSocket(path: string): AppSocket {
  return transport().openSocket(path, authHeaders())
}
