/**
 * Harman release feed — the private download point customer servers update
 * from (Card 121, option b: code stays private, nothing on public GitHub).
 *
 * Read-only by design. Publishing happens from the release Mac with
 * `wrangler r2 object put` (deploy/release-feed.sh), so this Worker exposes no
 * write path at all.
 *
 *   GET /latest.json              signed manifest (deploy/release_manifest.py)
 *   GET /bundles/<X.Y.Z>.bundle   the git bundle that manifest names
 *
 * Every request needs `Authorization: Bearer <customer token>`. A token is
 * valid while R2 holds `tokens/<sha256(token)>`; revoking one customer is
 * deleting that object. Only hashes are stored, so a bucket read leaks no
 * usable token.
 *
 * Integrity is NOT this Worker's job: boxes verify the ed25519 signature and
 * the bundle's sha256 themselves, so a compromised feed can withhold updates
 * but cannot make a box install unsigned code.
 */
export interface Env {
  RELEASES: R2Bucket;
}

const BUNDLE_RE = /^\/bundles\/(\d+\.\d+\.\d+)\.bundle$/;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token.length < 32) return false;
  // R2 lookup by hash: an existence check, so no string comparison to time.
  return (await env.RELEASES.head(`tokens/${await sha256Hex(token)}`)) !== null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    if (!(await authorized(request, env))) return new Response("unauthorized", { status: 401 });

    const path = new URL(request.url).pathname;
    let key: string | null = null;
    if (path === "/latest.json") key = "latest.json";
    else {
      const m = BUNDLE_RE.exec(path);
      if (m) key = `bundles/${m[1]}.bundle`;
    }
    if (!key) return new Response("not found", { status: 404 });

    const obj = await env.RELEASES.get(key);
    if (!obj) return new Response("not found", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "Content-Type": key.endsWith(".json") ? "application/json" : "application/octet-stream",
        "Content-Length": String(obj.size),
        // Per-customer auth: never let a shared cache serve one customer's response to another.
        "Cache-Control": "private, no-store",
      },
    });
  },
} satisfies ExportedHandler<Env>;
