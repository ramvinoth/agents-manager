/**
 * The QR pairing link the web Profile shows:
 *   agents://pair?code=<code>[&url=<server>][&relay=<relay>&sid=<serverId>&pk=<publicKey>]
 * Scanning it with the iPhone Camera opens this app, which redeems the one-time
 * code on that server for a session token (POST /api/auth/pair/redeem) — no
 * password typed on the phone. The same text pasted into "Server URL" works too.
 *
 * A link carries at least one route: the server's direct address, the Harman
 * relay (viewer/relay.py) — the relay URL, the server's routing id and its
 * X25519 public key, which is what makes the relayed channel end-to-end
 * encrypted to THIS server — or both.
 *
 * DUPLICATED (builder side) in web/src/lib/pairLink.ts; the two apps share no build.
 */
import { fromBase64 } from "./bytes.ts"

/** How to reach a server through the relay (mirrors Paseo's RelayHostConnection). */
export type RelayRoute = { url: string; serverId: string; publicKey: string }

export type PairLink = { code: string; url?: string; relay?: RelayRoute }

const HTTP_URL = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i
const RELAY_URL = /^(wss|https):\/\/[^\s/?#]+(\/[^\s?#]*)?$/i
const SERVER_ID = /^[A-Za-z0-9_-]{16,64}$/

/** A relay route is usable only if every part is well-formed: a TLS relay
 *  address, a routing id the relay accepts, and a 32-byte public key. */
export function validRelay(r: unknown): r is RelayRoute {
  if (!r || typeof r !== "object") return false
  const { url, serverId, publicKey } = r as Record<string, unknown>
  if (typeof url !== "string" || !RELAY_URL.test(url)) return false
  if (typeof serverId !== "string" || !SERVER_ID.test(serverId)) return false
  if (typeof publicKey !== "string") return false
  try {
    return fromBase64(publicKey).length === 32
  } catch {
    return false
  }
}

/** Parse a pairing link; null for anything else (a plain server URL, junk). */
export function parsePairLink(raw: string): PairLink | null {
  const s = (raw || "").trim()
  const m = /^agents:\/\/pair\?(.*)$/i.exec(s)
  if (!m) return null
  const params: Record<string, string> = {}
  for (const part of m[1].split("&")) {
    const i = part.indexOf("=")
    if (i <= 0) continue
    try {
      params[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1).replace(/\+/g, " "))
    } catch {
      return null
    }
  }
  const code = (params.code || "").trim()
  if (!/^[A-Za-z0-9_-]{16,}$/.test(code)) return null
  const link: PairLink = { code }
  const url = (params.url || "").trim().replace(/\/+$/, "")
  if (url) {
    if (!HTTP_URL.test(url)) return null
    link.url = url
  }
  if (params.relay || params.sid || params.pk) {
    const relay = {
      url: (params.relay || "").trim().replace(/\/+$/, ""),
      serverId: (params.sid || "").trim(),
      publicKey: (params.pk || "").trim(),
    }
    if (!validRelay(relay)) return null
    link.relay = relay
  }
  return link.url || link.relay ? link : null
}
