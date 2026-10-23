// Fetch a file from the Files API into the phone's cache and open the share
// sheet on it (Quick Look, Save to Files, AirDrop…). Used by the Files screen
// and by file links in a chat reply (ThreadScreen).
import * as FileSystem from "expo-file-system"
import * as Sharing from "expo-sharing"
import { api, type FsScope } from "../api/client"
import { baseName } from "./files"

export async function downloadAndShare(scope: FsScope, path: string): Promise<void> {
  const dest = FileSystem.cacheDirectory + encodeURIComponent(baseName(path))
  const status = await api.fsDownload(scope, path, dest)
  if (status >= 400) {
    // The body on disk is the server's JSON error, not the file: surface
    // its message and don't leave it in the cache under the file's name.
    const body = await FileSystem.readAsStringAsync(dest).catch(() => "")
    await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {})
    let msg = `Download failed (HTTP ${status})`
    try { msg = JSON.parse(body).error || msg } catch {}
    throw new Error(msg)
  }
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(dest)
}
