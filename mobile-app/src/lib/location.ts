// The Files tab's location model: what it shows comes from exactly one place —
// the current host (this machine or an SSH host, the app-wide choice from the
// header) or a cloud drive (a choice of the Files tab alone). The server
// enforces "one of host/drive"; this module is the client's single statement of
// the same rule so the tab, the picker and the API client never disagree.
import type { Drive } from "../api/client"

/** A drive id, or "" for the current host. */
export type Location = string

export const HOST_LOCATION: Location = ""

/** Vendor labels for "Add <vendor>" rows and the location chip. A kind the
 *  client has no word for shows as-is — the server decides which vendors are
 *  connectable, the client only names them. */
const VENDOR_LABELS: Record<string, string> = {
  google: "Google Drive",
  dropbox: "Dropbox",
  onedrive: "OneDrive",
}

export function vendorLabel(kind: string): string {
  return VENDOR_LABELS[kind] || kind
}

/** Chip text for the current location. A selected drive that has since been
 *  removed falls back to the host — a stale id must never render as a place. */
export function describeLocation(loc: Location, drives: Drive[], hostLabel: string): string {
  if (loc === HOST_LOCATION) return hostLabel
  return drives.find((d) => d.id === loc)?.label || hostLabel
}

/** Whether `loc` still names a usable place given the current drive list. */
export function isLiveLocation(loc: Location, drives: Drive[]): boolean {
  return loc === HOST_LOCATION || drives.some((d) => d.id === loc)
}

/** The query/body fields that scope a file call to a location: a drive id
 *  when on a drive, otherwise the host — and no host at all for the implicit
 *  local machine. Exactly one of the two keys is ever present. */
export function fsScope(host: string, loc: Location): { drive: string } | { host: string } | {} {
  if (loc !== HOST_LOCATION) return { drive: loc }
  if (host && host !== "local") return { host }
  return {}
}

/** The starting folder when a location is entered: `~` means "home" on a host
 *  and "root" on a drive. One start path keeps the tab's reset logic
 *  location-agnostic. */
export const START_PATH = "~"
