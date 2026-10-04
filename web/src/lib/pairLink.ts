/**
 * The QR pairing link shown by Profile → "Pair a phone":
 * `agents://pair?url=<server>&code=<one-time code>`. The iPhone Camera opens it
 * in the app, which redeems the code (POST /api/auth/pair/redeem) for a token.
 *
 * DUPLICATED (parser side) in mobile-app/src/lib/pairLink.ts; the two apps share no build.
 */
export function buildPairLink(serverUrl: string, code: string): string {
  return `agents://pair?url=${encodeURIComponent(serverUrl.trim().replace(/\/+$/, ""))}&code=${encodeURIComponent(code)}`
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
