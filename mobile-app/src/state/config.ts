/**
 * Persisted app config: the saved servers (each with its own auth token) and the
 * usual UI prefs.
 *
 * A server's token is the `viewer_session` value from POST /api/auth/signin
 * (`wantToken: true`), stored in the OS keystore (Keychain / Android Keystore)
 * via expo-secure-store. It is server-specific — issued by and valid for only
 * one backend — so it travels with that server's entry in the list rather than
 * as a single global value. The ACTIVE server's url + token are what the API
 * client reads via serverUrl()/token(); switching servers just re-points those.
 */
import * as SecureStore from "expo-secure-store"
import {
  addToList,
  activeEntry,
  migrateLegacy,
  parseState,
  removeFromList,
  setActiveToken,
  switchInList,
  EMPTY_STATE,
  type ServerEntry,
  type ServerState,
} from "../lib/servers"

export type { ServerEntry } from "../lib/servers"

// Current schema: the whole server list lives under SERVERS_KEY as JSON. The
// legacy single-server keys are read once for migration, then left untouched.
const SERVERS_KEY = "servers"
const SERVER_KEY = "serverUrl" // legacy (pre-multi-server) — migration source only
const TOKEN_KEY = "token" // legacy — migration source only
const HOST_KEY = "currentHost"
const SEEN_KEY = "seenMap"
const PREFS_KEY = "composerPrefs"
const THEME_KEY = "themePref"
const DRAWER_KEY = "drawerSections"
const NOTIFY_KEY = "notifyEveryReply"
const DRAFTS_KEY = "composerDrafts"

export type ThemePref = "system" | "light" | "dark"

// In-memory mirror so synchronous callers (the API client) can read without an
// await on every request. Hydrated once at startup by loadConfig(). The active
// server's url + token are derived from this list on demand.
let _servers: ServerState = EMPTY_STATE
let _host = "local"
let _seen: Record<string, number> = {}
// Unsent composer text per session (keyed by path/id), so a draft survives
// navigating back and app restarts. Kept small via trimDrafts.
let _drafts: Record<string, string> = {}
let _prefs: { mode: string; model: string } = { mode: "default", model: "default" }
let _theme: ThemePref = "system"
let _drawer: Record<string, boolean> = {}
let _notify = true

// Tiny pub-sub so a theme change repaints the whole tree without prop-drilling.
const _themeListeners = new Set<() => void>()
export function subscribeTheme(fn: () => void): () => void {
  _themeListeners.add(fn)
  return () => _themeListeners.delete(fn)
}

// Pub-sub for the active server, so the server picker + Profile row repaint the
// moment the selection changes (same shape as the theme listeners above).
const _serverListeners = new Set<() => void>()
export function subscribeServer(fn: () => void): () => void {
  _serverListeners.add(fn)
  return () => _serverListeners.delete(fn)
}
function notifyServer() {
  _serverListeners.forEach((fn) => fn())
}

// Persist the whole server list (best-effort). In-memory state is the source of
// truth for the session, so a keychain failure never breaks the running app.
async function persistServers() {
  try {
    await SecureStore.setItemAsync(SERVERS_KEY, JSON.stringify(_servers))
  } catch {
    /* not persisted */
  }
}

// Shared chat-filter state (active host + project). The Hosts/Projects tabs set
// these and the Chats tab subscribes, so switching in one tab reflects in
// another without prop-drilling across the tab navigator. Project is
// session-only (not persisted); host persists via HOST_KEY below.
let _project: string | null = null
const _filterListeners = new Set<() => void>()
export function subscribeChatFilter(fn: () => void): () => void {
  _filterListeners.add(fn)
  return () => _filterListeners.delete(fn)
}
function notifyFilter() {
  _filterListeners.forEach((fn) => fn())
}

/** The project filter applied to the chat list (null = all chats). */
export function activeProject(): string | null {
  return _project
}
export function setActiveProject(p: string | null): void {
  _project = p
  notifyFilter()
}

// The set of projects discovered on the active host. Chats derives this from
// its session list and publishes it so the Projects tab can render the same
// filter options without re-fetching.
let _projects: string[] = []
export function knownProjects(): string[] {
  return _projects
}
export function setKnownProjects(p: string[]): void {
  _projects = p
  notifyFilter()
}

export async function loadConfig(): Promise<{ serverUrl: string; token: string }> {
  // Best-effort: if the secure store is unavailable, fall back to empty
  // in-memory state rather than throwing (which would brick app startup).
  try {
    _servers = await loadServers()
    _host = (await SecureStore.getItemAsync(HOST_KEY)) || "local"
    try {
      _seen = JSON.parse((await SecureStore.getItemAsync(SEEN_KEY)) || "{}")
    } catch {
      _seen = {}
    }
    try {
      _prefs = { ..._prefs, ...JSON.parse((await SecureStore.getItemAsync(PREFS_KEY)) || "{}") }
    } catch {
      /* defaults stand */
    }
    const tp = (await SecureStore.getItemAsync(THEME_KEY)) as ThemePref | null
    _theme = tp === "light" || tp === "dark" ? tp : "system"
    try {
      _drawer = JSON.parse((await SecureStore.getItemAsync(DRAWER_KEY)) || "{}")
    } catch {
      _drawer = {}
    }
    _notify = (await SecureStore.getItemAsync(NOTIFY_KEY)) !== "0"
    try {
      _drafts = JSON.parse((await SecureStore.getItemAsync(DRAFTS_KEY)) || "{}")
    } catch {
      _drafts = {}
    }
  } catch {
    _servers = EMPTY_STATE
    _host = "local"
  }
  return { serverUrl: serverUrl(), token: token() }
}

/**
 * Hydrate the server list: prefer the current SERVERS_KEY blob; if absent (an
 * upgrade from the pre-multi-server build), migrate the legacy scalar
 * serverUrl + token into a one-entry list and persist it so the migration runs
 * exactly once. Returns EMPTY_STATE on a fresh install.
 */
async function loadServers(): Promise<ServerState> {
  const stored = parseState(await SecureStore.getItemAsync(SERVERS_KEY))
  if (stored) return stored
  const legacyUrl = (await SecureStore.getItemAsync(SERVER_KEY)) || ""
  const legacyToken = (await SecureStore.getItemAsync(TOKEN_KEY)) || ""
  const migrated = migrateLegacy(legacyUrl, legacyToken)
  if (migrated.servers.length) {
    try {
      await SecureStore.setItemAsync(SERVERS_KEY, JSON.stringify(migrated))
    } catch {
      /* best-effort; in-memory migration still drives this session */
    }
  }
  return migrated
}

/** The host whose sessions the chat list shows (a host id, or "local"). */
export function currentHost(): string {
  return _host
}

export async function setCurrentHost(h: string): Promise<void> {
  _host = h || "local"
  _project = null // a different host has different projects; clear the filter
  notifyFilter()
  try {
    await SecureStore.setItemAsync(HOST_KEY, _host)
  } catch {
    /* not persisted */
  }
}

/** The active server's base URL (empty when no server is configured). This is
 *  what src/api/client.ts prefixes onto every request. */
export function serverUrl(): string {
  return activeEntry(_servers)?.url || ""
}

/** The active server's auth token (empty when signed out / no server). Sent as
 *  `Authorization: Bearer <token>` on every request. */
export function token(): string {
  return activeEntry(_servers)?.token || ""
}

/** All saved servers (for the picker). */
export function servers(): ServerEntry[] {
  return _servers.servers
}

/** The id of the active server ("" when none). */
export function activeServerId(): string {
  return _servers.activeId
}

/**
 * Add a server to the list (or return the existing entry with the same URL,
 * updating its nickname). Does NOT switch to it — call switchServer next. New
 * entries start tokenless, so the caller routes to Login. Returns the entry.
 */
export async function addServer(url: string, name?: string): Promise<ServerEntry> {
  const { state, entry } = addToList(_servers, url, name)
  _servers = state
  await persistServers()
  notifyServer()
  return entry
}

/**
 * Make a saved server active. Hosts and the project filter belong to a server,
 * so reset them: switch host back to "local" and clear the project filter, then
 * notify both the server and filter subscribers.
 */
export async function switchServer(id: string): Promise<void> {
  _servers = switchInList(_servers, id)
  _host = "local"
  _project = null
  await persistServers()
  try {
    await SecureStore.setItemAsync(HOST_KEY, _host)
  } catch {
    /* not persisted */
  }
  notifyServer()
  notifyFilter()
}

/** Remove a saved server. If it was active, the active selection falls back to
 *  the first remaining server (or none). */
export async function removeServer(id: string): Promise<void> {
  _servers = removeFromList(_servers, id)
  await persistServers()
  notifyServer()
  notifyFilter()
}

/**
 * Legacy shim: set "the" server URL. Preserved so the cold-start ServerScreen
 * keeps working unchanged — it adds the server and switches to it in one call.
 */
export async function setServerUrl(url: string): Promise<void> {
  const entry = await addServer(url)
  await switchServer(entry.id)
}

/** Store the auth token onto the ACTIVE server (sign-in), or clear it (sign-out
 *  when passed null). No active server → no-op. */
export async function setToken(t: string | null): Promise<void> {
  _servers = setActiveToken(_servers, t || "")
  await persistServers()
  notifyServer()
}

import { trimSeen } from "../lib/search"

/** When each chat (by path) was last opened — drives the unread indicators. */
export function seenMap(): Record<string, number> {
  return _seen
}

export async function markSeen(path: string): Promise<void> {
  _seen = trimSeen({ ..._seen, [path]: Date.now() / 1000 })
  try {
    await SecureStore.setItemAsync(SEEN_KEY, JSON.stringify(_seen))
  } catch {
    /* best-effort; in-memory map still works this session */
  }
}

/** Unsent composer draft for a session (empty string if none). */
export function draftFor(key: string): string {
  return (key && _drafts[key]) || ""
}

/** Save/clear the composer draft for a session. Empty text clears the entry. */
export async function setDraft(key: string, text: string): Promise<void> {
  if (!key) return
  if (text) _drafts = { ..._drafts, [key]: text }
  else {
    const next = { ..._drafts }
    delete next[key]
    _drafts = next
  }
  // Bound the map so it can't grow without limit (reuse trimSeen's LRU-ish
  // trim by stamping recency): keep it simple — cap at 50 most-recent keys.
  const keys = Object.keys(_drafts)
  if (keys.length > 50) {
    _drafts = Object.fromEntries(keys.slice(-50).map((k) => [k, _drafts[k]]))
  }
  try {
    await SecureStore.setItemAsync(DRAFTS_KEY, JSON.stringify(_drafts))
  } catch {
    /* best-effort; in-memory draft still works this session */
  }
}

/** Composer preferences (permission mode + model). Persisted so a choice like
 *  Bypass sticks across threads and launches — muscle memory, not per-screen state. */
export function composerPrefs(): { mode: string; model: string } {
  return _prefs
}

export async function setComposerPrefs(p: Partial<{ mode: string; model: string }>): Promise<void> {
  _prefs = { ..._prefs, ...p }
  try {
    await SecureStore.setItemAsync(PREFS_KEY, JSON.stringify(_prefs))
  } catch {
    /* best-effort */
  }
}

/** Theme preference: "system" follows the OS, "light"/"dark" force a scheme.
 *  Changing it notifies subscribers so the whole app repaints immediately. */
export function themePref(): ThemePref {
  return _theme
}

export async function setThemePref(v: ThemePref): Promise<void> {
  _theme = v
  _themeListeners.forEach((fn) => fn())
  try {
    await SecureStore.setItemAsync(THEME_KEY, v)
  } catch {
    /* best-effort; in-memory value still drives this session */
  }
}

/** Which drawer sections are collapsed (by key). Missing key = expanded. */
export function drawerSections(): Record<string, boolean> {
  return _drawer
}

export async function setDrawerSection(key: string, open: boolean): Promise<void> {
  _drawer = { ..._drawer, [key]: open }
  try {
    await SecureStore.setItemAsync(DRAWER_KEY, JSON.stringify(_drawer))
  } catch {
    /* best-effort */
  }
}

/** Whether to fire a local notification on every agent reply. Default on.
 *  When true, the thread notifies even while foregrounded (per user request). */
export function notifyEveryReply(): boolean {
  return _notify
}

export async function setNotifyEveryReply(v: boolean): Promise<void> {
  _notify = v
  try {
    await SecureStore.setItemAsync(NOTIFY_KEY, v ? "1" : "0")
  } catch {
    /* best-effort */
  }
}
