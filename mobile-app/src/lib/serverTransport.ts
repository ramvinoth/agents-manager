/**
 * How the app talks to ONE saved server: over its direct address, through
 * the Harman relay, or direct-with-relay-fallback when the entry has both
 * (Paseo's HostProfile.connections + selectBestConnection).
 *
 * Every request the app makes goes through here, so callers never know which
 * route carried it. Route choice: a direct-only entry goes direct, a
 * relay-only entry through the relay; with both, direct while its /healthz
 * answers (RouteChooser caches that verdict), else the relay. A direct
 * attempt that fails to reach the server marks direct down and — when it is
 * safe to repeat (GET, or a socket that never opened) — retries through the
 * relay at once. A POST is never repeated: it may have reached the server
 * before the connection broke, and a duplicated chat message or approval is
 * worse than one "can't reach the server".
 *
 * Pure: all I/O (RN fetch/WebSocket/FormData, expo-file-system) is injected
 * as DirectIO + FileIO, so the routing policy is node-tested.
 */
import { utf8Decode, utf8Encode, concatBytes } from "./bytes.ts"
import { DeferredSocket, type AppSocket } from "./deferredSocket.ts"
import type { RelayRoute } from "./pairLink.ts"
import { RelayLink, RouteChooser, type RelayDeps, type RelayResponse } from "./relayTransport.ts"

/** An HTTP response, whichever route carried it. */
export interface Reply {
  status: number
  ok: boolean
  text(): Promise<string>
}

/** A local file to send as one multipart part. */
export type FilePart = { uri: string; name: string; type: string; field: string }

/** The direct route's native I/O. Every method REJECTS when the server can't
 *  be reached at all; an HTTP error status resolves normally. */
export interface DirectIO {
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Reply>
  /** Multipart upload of a local file, streamed by the platform. */
  upload(url: string, headers: Record<string, string>, file: FilePart): Promise<Reply>
  /** Save the response body to `dest` (an error body too); resolve its status. */
  download(url: string, headers: Record<string, string>, dest: string): Promise<number>
  socket(url: string, headers: Record<string, string>): AppSocket
}

/** Local files, for routes that must hold a body in memory (the relay). */
export interface FileIO {
  read(uri: string): Promise<Uint8Array>
  write(uri: string, data: Uint8Array): Promise<void>
}

export type TransportDeps = {
  direct: DirectIO
  files: FileIO
  relay: RelayDeps
  /** How long the direct /healthz probe may take before the relay is used. */
  probeMs?: number
  now?: () => number
}

export type ServerRoutes = { direct: string; relay?: RelayRoute }

/** The relay holds whole bodies in memory (the channel has no file
 *  streaming), so a relayed download or upload is capped. */
export const RELAY_FILE_MAX = 25 * 1024 * 1024

/** Where to play an audio stream from: a URL the player fetches itself
 *  (direct), or a local file already fetched through the relay. */
export type MediaSource = { url: string; headers: Record<string, string>; file: boolean }

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"])

function relayReply(res: RelayResponse): Reply {
  return { status: res.status, ok: res.status >= 200 && res.status < 300, text: async () => utf8Decode(res.body) }
}

/** A multipart/form-data body with one file part — what RN's FormData builds
 *  for the direct route, built by hand for the relay. */
export function multipartBody(file: FilePart, data: Uint8Array, boundary: string): Uint8Array {
  const safe = (s: string) => s.replace(/["\r\n\\]/g, "_")
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${safe(file.field)}"; filename="${safe(file.name)}"\r\n` +
    `Content-Type: ${safe(file.type)}\r\n\r\n`
  return concatBytes([utf8Encode(head), data, utf8Encode(`\r\n--${boundary}--\r\n`)])
}

export class ServerTransport {
  readonly routes: ServerRoutes
  private readonly deps: TransportDeps
  private readonly link: RelayLink | null
  private readonly chooser: RouteChooser | null

  constructor(routes: ServerRoutes, deps: TransportDeps) {
    this.routes = routes
    this.deps = deps
    this.link = routes.relay ? new RelayLink(routes.relay, deps.relay) : null
    this.chooser =
      routes.direct && routes.relay
        ? new RouteChooser(() => this.probe(), deps.now ?? Date.now)
        : null
  }

  /** Does the direct address answer as a Harman server, quickly? */
  private async probe(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("probe timed out")), this.deps.probeMs ?? 2500)
    })
    try {
      const res = await Promise.race([
        this.deps.direct.fetch(`${this.routes.direct}/healthz`, { method: "GET", headers: {} }),
        timeout,
      ])
      if (!res.ok) return false
      // A captive portal or some other service at that address is not us.
      return JSON.parse(await res.text())?.ok === true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  private async useDirect(): Promise<boolean> {
    if (!this.routes.direct && !this.link) throw new Error("No server configured")
    if (!this.link) return true
    if (!this.routes.direct) return false
    return this.chooser!.useDirect()
  }

  /** Run `direct`, falling back to `relay` per the policy in the header. */
  private async route<T>(repeatable: boolean, direct: () => Promise<T>, relay: (link: RelayLink) => Promise<T>): Promise<T> {
    if (!(await this.useDirect())) return relay(this.link!)
    try {
      return await direct()
    } catch (e) {
      if (!this.link) throw e
      this.chooser!.directFailed()
      if (!repeatable) throw e
      return relay(this.link)
    }
  }

  fetch(method: string, path: string, headers: Record<string, string>, body?: string): Promise<Reply> {
    return this.route(
      IDEMPOTENT.has(method),
      () => this.deps.direct.fetch(this.routes.direct + path, { method, headers, body }),
      async (link) =>
        relayReply(await link.fetch({ method, path, headers, body: body === undefined ? undefined : utf8Encode(body) }))
    )
  }

  upload(path: string, headers: Record<string, string>, file: FilePart): Promise<Reply> {
    return this.route(
      false,
      () => this.deps.direct.upload(this.routes.direct + path, headers, file),
      async (link) => {
        const data = await this.deps.files.read(file.uri)
        if (data.length > RELAY_FILE_MAX) {
          throw new Error(`Too large to upload through the Harman relay (over ${RELAY_FILE_MAX / 1048576} MB)`)
        }
        const boundary = `harman${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
        const res = await link.fetch({
          method: "POST",
          path,
          headers: { ...headers, "Content-Type": `multipart/form-data; boundary=${boundary}` },
          body: multipartBody(file, data, boundary),
        })
        return relayReply(res)
      }
    )
  }

  /** Save a GET's body to `dest` (an error body too, like the direct route
   *  does); resolves the HTTP status. */
  download(path: string, headers: Record<string, string>, dest: string): Promise<number> {
    return this.route(
      true,
      () => this.deps.direct.download(this.routes.direct + path, headers, dest),
      async (link) => {
        const res = await link.fetch({ method: "GET", path, headers }, RELAY_FILE_MAX)
        await this.deps.files.write(dest, res.body)
        return res.status
      }
    )
  }

  /** Where a player should stream `path` from. Direct: the URL itself, so
   *  playback starts on the first bytes. Relay: fetched whole into `dest`
   *  first (the player can't speak the relay protocol); `file` tells the
   *  caller to delete it after playback. */
  async media(path: string, headers: Record<string, string>, dest: string): Promise<MediaSource> {
    if (await this.useDirect()) return { url: this.routes.direct + path, headers, file: false }
    const status = await this.download(path, headers, dest)
    if (status >= 400) throw new Error(`HTTP ${status}`)
    return { url: dest, headers: {}, file: true }
  }

  /** A WebSocket to `path` (must start with /api/). Returned at once; it
   *  opens on whichever route answers. */
  openSocket(path: string, headers: Record<string, string>): AppSocket {
    const socket = new DeferredSocket()
    const viaRelay = () => socket.attach(this.link!.openSocket(path, headers))
    this.useDirect().then(
      (direct) => {
        if (!direct) return viaRelay()
        const url = this.routes.direct.replace(/^http/i, "ws") + path
        socket.attach(this.deps.direct.socket(url, headers), () => {
          // Never opened: nothing ran server-side, so the relay may try.
          if (!this.link) return false
          this.chooser!.directFailed()
          viaRelay()
          return true
        })
      },
      (e) => socket.fail(e as Error)
    )
    return socket
  }

  /** Drop the relay connection (server removed, switched, or re-paired). */
  close() {
    this.link?.close()
  }
}
