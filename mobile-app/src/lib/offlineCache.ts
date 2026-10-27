/**
 * The last-seen copy of the chat list and recent threads, kept on the device
 * so the app still shows them when it can't reach the server (and paints
 * instantly on a cold start). It is a CACHE, never a source of truth: the
 * server's answer always replaces it, nothing is edited offline, and losing it
 * costs only a reload.
 *
 * Bounded: the chat list per (server, host), plus the newest `maxThreads`
 * threads opened, each trimmed to its last `maxLines` lines and `maxBytes`.
 * Entries belong to a server; pruneServers() drops a signed-out or removed
 * server's copies, so a transcript never outlives the session that could read it.
 *
 * Pure: file I/O is injected (api/offlineCache.ts wires expo-file-system).
 */
export interface CacheIO {
  read(name: string): Promise<string | null>
  write(name: string, data: string): Promise<void>
  remove(name: string): Promise<void>
}

type Entry = { file: string; server: string; at: number }
type Index = { v: 1; entries: Record<string, Entry> }

export type CacheLimits = { maxThreads: number; maxLines: number; maxBytes: number }
export const DEFAULT_LIMITS: CacheLimits = { maxThreads: 20, maxLines: 400, maxBytes: 512 * 1024 }

const INDEX = "index.json"

/** FNV-1a, base36: a filesystem-safe name for any key. */
function fileFor(key: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(36)}-${key.length}.json`
}

/** The newest lines that fit both limits (a thread is read from its tail). */
export function tailLines(lines: string[], maxLines: number, maxBytes: number): string[] {
  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    bytes += lines[i].length + 1
    if (bytes > maxBytes) break
    out.push(lines[i])
  }
  return out.reverse()
}

export class OfflineCache {
  private index: Promise<Index> | null = null
  private written = new Map<string, string>() // key → last body, to skip identical rewrites
  private queue: Promise<unknown> = Promise.resolve()
  private io: CacheIO
  private limits: CacheLimits
  private now: () => number

  constructor(io: CacheIO, limits: Partial<CacheLimits> = {}, now: () => number = Date.now) {
    this.io = io
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.now = now
  }

  saveChats<T>(server: string, host: string, sessions: T[]): Promise<void> {
    return this.put(server, `chats|${server}|${host}`, sessions)
  }
  loadChats<T>(server: string, host: string): Promise<T[] | null> {
    return this.get(`chats|${server}|${host}`)
  }

  saveThread(server: string, host: string, path: string, lines: string[]): Promise<void> {
    const { maxLines, maxBytes } = this.limits
    return this.put(server, `thread|${server}|${host}|${path}`, tailLines(lines, maxLines, maxBytes))
  }
  loadThread(server: string, host: string, path: string): Promise<string[] | null> {
    return this.get(`thread|${server}|${host}|${path}`)
  }

  /** Drop every entry whose server isn't in `keep` (signed out or removed). */
  pruneServers(keep: string[]): Promise<void> {
    return this.serial(async () => {
      const idx = await this.loadIndex()
      const drop = Object.keys(idx.entries).filter((k) => !keep.includes(idx.entries[k].server))
      if (!drop.length) return
      for (const k of drop) await this.dropEntry(idx, k)
      await this.io.write(INDEX, JSON.stringify(idx))
    })
  }

  private async get<T>(key: string): Promise<T | null> {
    const idx = await this.loadIndex()
    const e = idx.entries[key]
    if (!e) return null
    try {
      const raw = await this.io.read(e.file)
      return raw ? (JSON.parse(raw) as T) : null
    } catch {
      return null // unreadable copy = no copy
    }
  }

  private put(server: string, key: string, data: unknown): Promise<void> {
    if (!server) return Promise.resolve()
    const body = JSON.stringify(data)
    if (this.written.get(key) === body) return Promise.resolve()
    return this.serial(async () => {
      const idx = await this.loadIndex()
      const file = fileFor(key)
      await this.io.write(file, body)
      idx.entries[key] = { file, server, at: this.now() }
      this.written.set(key, body)
      // Evict the least-recently-saved threads beyond the cap.
      const threads = Object.keys(idx.entries).filter((k) => k.startsWith("thread|"))
      threads.sort((a, b) => idx.entries[b].at - idx.entries[a].at)
      for (const k of threads.slice(this.limits.maxThreads)) await this.dropEntry(idx, k)
      await this.io.write(INDEX, JSON.stringify(idx))
    }).catch(() => {}) // best-effort: a full disk never breaks the screen
  }

  private async dropEntry(idx: Index, key: string) {
    const e = idx.entries[key]
    delete idx.entries[key]
    this.written.delete(key)
    await this.io.remove(e.file).catch(() => {})
  }

  private loadIndex(): Promise<Index> {
    if (!this.index) {
      this.index = this.io
        .read(INDEX)
        .then((raw) => {
          const parsed = raw ? (JSON.parse(raw) as Index) : null
          return parsed?.v === 1 && parsed.entries ? parsed : { v: 1 as const, entries: {} }
        })
        .catch(() => ({ v: 1 as const, entries: {} }))
    }
    return this.index
  }

  /** Index read-modify-writes run one at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }
}
