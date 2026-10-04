/**
 * nemotronNative — real RN wiring for the pure NemotronCall state machine
 * (see ./nemotron.ts): opens the call socket through the app's server
 * transport (direct or relayed, like every other socket), and persists a reply
 * WAV to a private cache file for audioSession to play.
 */
import * as FileSystem from "expo-file-system"
import { api } from "../api/client"
import type { NemotronBindings } from "./nemotron"
import { toBase64 } from "./bytes"

const REPLY_DIR = FileSystem.cacheDirectory + "nemotron/"

let dirReady: Promise<void> | null = null
function ensureReplyDir(): Promise<void> {
  if (!dirReady) {
    dirReady = FileSystem.makeDirectoryAsync(REPLY_DIR, { intermediates: true }).catch(() => {
      /* already exists */
    })
  }
  return dirReady
}

/** Real bindings for NemotronCall: the authenticated call socket + a private
 *  cache-dir WAV file per reply. `saveAudio` never throws (see NemotronBindings) —
 *  a failed write rejects the TURN (see nemotron.ts), never crashes the call.
 *  `deleteAudio` is best-effort/idempotent: used both for normal post-playback
 *  cleanup and for a save that lands after its turn was already invalidated. */
export function nemotronNativeBindings(): NemotronBindings {
  return {
    openSocket: (path) => api.nemotronSocket(path),
    async saveAudio(data: ArrayBuffer): Promise<string | null> {
      try {
        await ensureReplyDir()
        const uri = `${REPLY_DIR}reply-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
        await FileSystem.writeAsStringAsync(uri, toBase64(data), {
          encoding: FileSystem.EncodingType.Base64,
        })
        return uri
      } catch {
        return null
      }
    },
    async deleteAudio(uri: string): Promise<void> {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
    },
  }
}

/** Delete a reply WAV written by `saveAudio` above. Best-effort, idempotent —
 *  called after playback finishes (or fails) so temp files never accumulate.
 *  Exported separately (not just via bindings.deleteAudio) because playback
 *  cleanup happens in useAssistantTurn, after the NemotronCall/turn has
 *  already resolved — a different call site than the bindings object. */
export async function deleteNemotronReply(uri: string): Promise<void> {
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
}
