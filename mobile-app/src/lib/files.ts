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
