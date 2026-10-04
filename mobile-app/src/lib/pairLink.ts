/**
 * The QR pairing link the web Profile shows: `agents://pair?url=<server>&code=<code>`.
 * Scanning it with the iPhone Camera opens this app, which redeems the one-time
 * code on that server for a session token (POST /api/auth/pair/redeem) — no
 * password typed on the phone. The same text pasted into "Server URL" works too.
 *
 * DUPLICATED (builder side) in web/src/lib/pairLink.ts; the two apps share no build.
 */
export type PairLink = { url: string; code: string }

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
  const url = (params.url || "").trim().replace(/\/+$/, "")
  const code = (params.code || "").trim()
  if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(url)) return null
  if (!/^[A-Za-z0-9_-]{16,}$/.test(code)) return null
  return { url, code }
}
