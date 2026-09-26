/**
 * nemotronNative — real RN wiring for the pure NemotronCall state machine
 * (see ./nemotron.ts): opens the authenticated WebSocket the same way
 * voice.ts/duplexMic.ts/terminalSession.ts do (RN's WebSocket 3rd-arg headers,
 * carrying the Bearer token on the handshake — never a query param), and
 * persists a reply WAV to a private cache file for audioSession to play.
 */
import * as FileSystem from "expo-file-system"
import type { NemotronBindings, NemotronSocket } from "./nemotron"

const REPLY_DIR = FileSystem.cacheDirectory + "nemotron/"

// Base64 encode without String.fromCharCode.apply(null, hugeArray) — that blows
// the call stack on the multi-MB replies this can carry (up to ~180s of 22.05kHz
// PCM16, see deploy/voicechat_service.py MAX_OUTPUT). Table-based, 3 bytes -> 4
// chars at a time, like every other from-scratch base64 encoder.
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
function encodeBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined
    out += B64_CHARS[b0 >> 2]
    out += B64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)]
    out += b1 === undefined ? "=" : B64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)]
    out += b2 === undefined ? "=" : B64_CHARS[b2 & 0x3f]
  }
  return out
}

let dirReady: Promise<void> | null = null
function ensureReplyDir(): Promise<void> {
  if (!dirReady) {
    dirReady = FileSystem.makeDirectoryAsync(REPLY_DIR, { intermediates: true }).catch(() => {
      /* already exists */
    })
  }
  return dirReady
}

/** Real bindings for NemotronCall: an authenticated RN WebSocket + a private
 *  cache-dir WAV file per reply. `saveAudio` never throws (see NemotronBindings) —
 *  a failed write rejects the TURN (see nemotron.ts), never crashes the call.
 *  `deleteAudio` is best-effort/idempotent: used both for normal post-playback
 *  cleanup and for a save that lands after its turn was already invalidated. */
export function nemotronNativeBindings(): NemotronBindings {
  return {
    openSocket(url, headers) {
      const WS = WebSocket as unknown as {
        new (url: string, protocols: undefined, options: { headers: Record<string, string> }): WebSocket
      }
      const ws = new WS(url, undefined, { headers })
      ws.binaryType = "arraybuffer" // otherwise RN may hand back a blob-like object
      return ws as unknown as NemotronSocket
    },
    async saveAudio(data: ArrayBuffer): Promise<string | null> {
      try {
        await ensureReplyDir()
        const uri = `${REPLY_DIR}reply-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
        await FileSystem.writeAsStringAsync(uri, encodeBase64(data), {
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
