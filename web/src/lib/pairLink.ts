/**
 * The QR pairing link shown by Profile → "Pair a phone":
 *
 *   agents://pair?code=<one-time code>[&url=<server>][&relay=<wss url>&sid=<serverId>&pk=<key>]
 *
 * The iPhone Camera opens it in the app, which redeems the code
 * (POST /api/auth/pair/redeem) for a token. `url` is a direct address the
 * phone can reach; `relay`/`sid`/`pk` come from the server's relay offer
 * (viewer/relay.py offer()) and let the phone reach a server that has no
 * public address at all, end-to-end encrypted to `pk`. At least one of the
 * two routes is present; when both are, the phone keeps both.
 *
 * DUPLICATED (parser side) in mobile-app/src/lib/pairLink.ts; the two apps share no build.
 */
export type RelayOffer = { url: string; serverId: string; publicKey: string }
/** GET/POST /api/relay — `pinned` means HARMAN_RELAY_URL decides, not the app. */
export type RelayStatus = { enabled: boolean; pinned: boolean; url: string; connected: boolean }

export function buildPairLink(serverUrl: string, code: string, relay?: RelayOffer | null): string {
  const q = [`code=${encodeURIComponent(code)}`]
  const url = serverUrl.trim().replace(/\/+$/, "")
  if (url) q.push(`url=${encodeURIComponent(url)}`)
  if (relay)
    q.push(`relay=${encodeURIComponent(relay.url)}`, `sid=${encodeURIComponent(relay.serverId)}`,
      `pk=${encodeURIComponent(relay.publicKey)}`)
  return `agents://pair?${q.join("&")}`
}

/** Why a phone could NOT reach `serverUrl`, or "" when it looks reachable.
 *  The page's own origin is the default, and `localhost` means this computer —
 *  to a phone that's itself. */
export function unreachableReason(serverUrl: string): string {
  let u: URL
  try {
    u = new URL(serverUrl.trim())
  } catch {
    return "Enter the address your phone uses, like http://100.x.y.z:8091 or https://you.example.com."
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "The address must start with http:// or https://."
  const h = u.hostname.replace(/^\[|\]$/g, "")
  if (h === "localhost" || h === "::1" || h.startsWith("127.") || h === "0.0.0.0")
    return "This address only works on this computer. Use the one your phone reaches it by (Tailscale IP or your domain)."
  return ""
}
