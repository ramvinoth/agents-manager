/**
 * Pure, side-effect-free logic for the saved-server list.
 *
 * The effectful layer (src/state/config.ts) owns SecureStore persistence and the
 * repaint pub-sub; it delegates every list mutation to the functions here so the
 * decision logic stays testable without a keychain or a running app. Each
 * function takes and returns a plain `ServerState` — never mutating its input.
 */
import { validRelay, type RelayRoute } from "./pairLink.ts"

/** One saved backend: its URL, the per-server auth token, an optional
 *  nickname, and the signed-in username. The token is server-specific
 *  (issued by that server's /api/auth), so it travels with the entry rather
 *  than living as a single global value. The username is recorded at sign-in
 *  so actor labels ("user:ram" → you / human) can be rendered client-side
 *  without a round trip — the server's /api/auth response carries it. */
export type ServerEntry = {
  id: string
  url: string
  token: string
  name?: string
  username?: string
  /** How to reach this server through the Manager relay (end-to-end encrypted
   *  to the server's key). Like Paseo's HostProfile.connections, an entry may
   *  carry a direct address, a relay route, or both; the transport picks
   *  direct when it answers and falls back to the relay. */
  relay?: RelayRoute
}

/** The `url` of a relay-only entry: a stable, non-routable identity. Never
 *  fetched — the transport sees `relay` and goes through the channel. */
const RELAY_ONLY = "relay://"

export function relayOnlyUrl(serverId: string): string {
  return RELAY_ONLY + serverId
}

/** The direct HTTP address of an entry, or "" when it is reachable only
 *  through the relay. */
export function directUrl(entry: ServerEntry | undefined): string {
  if (!entry || entry.url.startsWith(RELAY_ONLY)) return ""
  return entry.url
}

/** The address to show a human for an entry — never the synthetic
 *  relay:// identity, which means nothing to them. */
export function displayAddress(entry: ServerEntry): string {
  return directUrl(entry) || "Remote (via Manager relay)"
}

/** The whole persisted server selection: the list plus which entry is active. */
export type ServerState = { servers: ServerEntry[]; activeId: string }

export const EMPTY_STATE: ServerState = { servers: [], activeId: "" }

/** Normalize a server URL for storage + identity: trim surrounding whitespace
 *  and drop trailing slashes so `https://x/` and `https://x` are one server. */
export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "")
}

/** A stable, collision-resistant id for a new entry. Not cryptographic — it only
 *  needs to be unique within one device's small list. Time + randomness suffices. */
export function makeId(): string {
  return `srv_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** The active entry, or undefined if the list is empty / id is stale. */
export function activeEntry(state: ServerState): ServerEntry | undefined {
  return state.servers.find((s) => s.id === state.activeId)
}

/**
 * Add a server (or update the existing one, so the list can't accumulate
 * duplicates). Identity is the relay serverId when a relay route is given —
 * the same machine re-paired from a new network or a new QR is the same
 * server — else the normalized URL. Pass url "" for a relay-only server.
 * Does NOT change which server is active — callers switch explicitly.
 * Returns the new state plus the resolved entry.
 */
export function addToList(
  state: ServerState,
  url: string,
  name?: string,
  relay?: RelayRoute
): { state: ServerState; entry: ServerEntry } {
  const direct = normalizeUrl(url)
  const normUrl = direct || (relay ? relayOnlyUrl(relay.serverId) : "")
  const cleanName = name?.trim() || undefined
  const existing =
    (relay && state.servers.find((s) => s.relay?.serverId === relay.serverId)) ||
    state.servers.find((s) => s.url === normUrl)
  if (existing) {
    // Refresh the routes and nickname, but keep the token. A relay-only
    // re-pair never erases a direct address learned earlier.
    const entry: ServerEntry = { ...existing }
    if (direct) entry.url = direct
    if (relay) entry.relay = relay
    if (cleanName) entry.name = cleanName
    const servers = state.servers.map((s) => (s.id === existing.id ? entry : s))
    return { state: { ...state, servers }, entry }
  }
  const entry: ServerEntry = { id: makeId(), url: normUrl, token: "" }
  if (relay) entry.relay = relay
  if (cleanName) entry.name = cleanName
  return { state: { ...state, servers: [...state.servers, entry] }, entry }
}

/** Make `id` the active server (no-op if it isn't in the list). */
export function switchInList(state: ServerState, id: string): ServerState {
  if (!state.servers.some((s) => s.id === id)) return state
  return { ...state, activeId: id }
}

/**
 * Remove a server. If the removed one was active, fall back to the first
 * remaining entry (or "" when none are left).
 */
export function removeFromList(state: ServerState, id: string): ServerState {
  const servers = state.servers.filter((s) => s.id !== id)
  const activeId =
    state.activeId === id ? (servers[0]?.id ?? "") : state.activeId
  return { servers, activeId }
}

/** Write a token onto the active entry (used after sign-in). No active entry →
 *  unchanged. Passing "" clears the token (sign-out); passing "" or undefined
 *  for username clears / leaves it alone respectively. */
export function setActiveToken(state: ServerState, token: string, username?: string): ServerState {
  if (!activeEntry(state)) return state
  const servers = state.servers.map((s) => {
    if (s.id !== state.activeId) return s
    const next: ServerEntry = { ...s, token }
    if (username !== undefined) next.username = username || undefined
    return next
  })
  return { ...state, servers }
}

/**
 * Build the initial state when upgrading from the pre-list schema: a single
 * server was stored as scalar `serverUrl` + `token`. Seed one active entry from
 * them. Empty url → EMPTY_STATE (fresh install / nothing to migrate).
 */
export function migrateLegacy(url: string, token: string): ServerState {
  const normUrl = normalizeUrl(url || "")
  if (!normUrl) return EMPTY_STATE
  const entry: ServerEntry = { id: makeId(), url: normUrl, token: token || "" }
  return { servers: [entry], activeId: entry.id }
}

/** Parse persisted JSON into a ServerState, tolerating any malformed shape by
 *  returning null (caller then tries legacy migration or empty state). */
export function parseState(raw: string | null): ServerState | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<ServerState>
    if (!Array.isArray(v.servers)) return null
    const servers = v.servers
      .filter(
        (s): s is ServerEntry =>
          !!s && typeof s.id === "string" && typeof s.url === "string" && typeof s.token === "string"
      )
      // A corrupted relay route is dropped, not trusted: the entry falls back
      // to its direct address (or becomes unreachable, prompting a re-pair).
      .map((s) => (s.relay === undefined || validRelay(s.relay) ? s : { ...s, relay: undefined }))
    return { servers, activeId: typeof v.activeId === "string" ? v.activeId : "" }
  } catch {
    return null
  }
}
