/**
 * The React Native wiring for lib/offlineCache: the app's one cache, in the
 * OS cache directory (not backed up to iCloud; iOS may purge it under storage
 * pressure, which only costs a reload). A sign-out or server removal drops
 * that server's saved chats at once.
 */
import * as FileSystem from "expo-file-system"
import { OfflineCache } from "../lib/offlineCache"
import { servers, subscribeServer } from "../state/config"

const DIR = `${FileSystem.cacheDirectory}offline/`
let made: Promise<unknown> | null = null
const ensureDir = () => (made ??= FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {}))

export const offlineCache = new OfflineCache({
  read: (name) => FileSystem.readAsStringAsync(DIR + name).catch(() => null),
  write: async (name, data) => {
    await ensureDir()
    await FileSystem.writeAsStringAsync(DIR + name, data)
  },
  remove: (name) => FileSystem.deleteAsync(DIR + name, { idempotent: true }),
})

// Only on a server-list change (sign-in/out, switch, removal) — never at module
// load, where the list may not be hydrated yet and would read as "no servers".
subscribeServer(() => {
  offlineCache.pruneServers(servers().filter((s) => s.token).map((s) => s.id))
})
