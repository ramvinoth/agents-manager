/**
 * File-listing helpers. Pure so they're unit-testable without a simulator.
 */
export type Entry = { name: string; dir: boolean; size: number; mtime: number }

/** Human-readable size. Directories have no meaningful size. */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** Finder-style: directories first, then case-insensitive name order. */
export function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  })
}

/** Join a directory and a child name into a path, without doubling slashes. */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`
}

/** The last path segment, for a compact screen title. */
export function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path || "/"
}

export type NavHistory = { stack: string[]; index: number }
export function navInit(path: string): NavHistory { return { stack: [path], index: 0 } }
export function navCurrent(h: NavHistory): string { return h.stack[h.index] }
export function navCanBack(h: NavHistory): boolean { return h.index > 0 }
export function navCanForward(h: NavHistory): boolean { return h.index < h.stack.length - 1 }
export function navVisit(h: NavHistory, path: string): NavHistory {
  if (navCurrent(h) === path) return h
  const stack = [...h.stack.slice(0, h.index + 1), path]
  return { stack, index: stack.length - 1 }
}
export function navBack(h: NavHistory): NavHistory {
  return navCanBack(h) ? { stack: h.stack, index: h.index - 1 } : h
}
export function navForward(h: NavHistory): NavHistory {
  return navCanForward(h) ? { stack: h.stack, index: h.index + 1 } : h
}
/** Keep the server's canonical path without adding a second visit (e.g. ~). */
export function navResolve(h: NavHistory, path: string): NavHistory {
  if (navCurrent(h) === path) return h
  const stack = [...h.stack]
  stack[h.index] = path
  return { stack, index: h.index }
}

/** Claim only inward horizontal drags from an edge, leaving tab swipes alone. */
export function navSwipe(x: number, dx: number, dy: number, width: number, back: boolean, forward: boolean): -1 | 0 | 1 {
  if (Math.abs(dx) <= 14 || Math.abs(dx) <= Math.abs(dy) * 1.6) return 0
  if (x <= 32 && dx > 0 && back) return -1
  if (x >= width - 32 && dx < 0 && forward) return 1
  return 0
}
