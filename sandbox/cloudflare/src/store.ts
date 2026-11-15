/**
 * The folder store: where a box's workspace and memory live between runs.
 *
 * The box itself pulls and pushes (orchestrator/runtime/backends/box_store.py);
 * this Worker only guards R2. Per volume:
 *
 *   GET  /store/:tenant/:slug/:vol/head        head.json, ETag; 404 when empty
 *   PUT  /store/:tenant/:slug/:vol/head        If-Match or If-None-Match: *, 412 when it moved
 *   GET  /store/:tenant/:slug/:vol/pack/:id    a pack, Range honoured
 *   PUT  /store/:tenant/:slug/:vol/pack/:id    a pack; id must be the sha256 of its bytes
 *
 * Access: the box secret (the viewer), or a capability the viewer minted for
 * one folder: payload.sig, payload = b64url {"t": tenant, "s": scope, "exp"},
 * sig = HMAC-SHA256(HMAC-SHA256(secret, "store-cap"), payload). A capability
 * opens only paths under its scope, so a box can never read another folder.
 *
 * Old packs: after each head commit, packs the head no longer names and older
 * than GRACE are deleted. GRACE covers a box still reading the head before.
 */

export interface StoreEnv {
  STORE: R2Bucket;
  BOX_SECRET: string;
}

const ROUTE = /^\/store\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9-]{1,255})\/(ws|mem)\/(head|pack\/([0-9a-f]{64}))$/;
const MAX_PACK = 64 * 1024 * 1024;
const MAX_HEAD = 64 * 1024 * 1024;
const GRACE_MS = 60 * 60 * 1000;
const enc = new TextEncoder();

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function unb64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function capKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", raw, enc.encode("store-cap"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
}

/** True when the request carries a live capability covering `path`. */
async function capAllows(req: Request, env: StoreEnv, tenant: string, path: string): Promise<boolean> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  const [payload, sig, extra] = token.split(".");
  if (!env.BOX_SECRET || !payload || !sig || extra !== undefined) return false;
  const sigBytes = unb64(sig);
  if (!sigBytes) return false;
  // subtle.verify compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", await capKey(env.BOX_SECRET), sigBytes, enc.encode(payload)))) return false;
  const body = unb64(payload);
  if (!body) return false;
  let cap: { t?: unknown; s?: unknown; exp?: unknown };
  try {
    cap = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return false;
  }
  return typeof cap.exp === "number" && cap.exp > Date.now() / 1000
    && cap.t === tenant
    && typeof cap.s === "string" && cap.s.startsWith(`${tenant}/`) && cap.s.endsWith("/")
    && path.startsWith(cap.s);
}

/** Packs under `base` the committed head no longer names, once past GRACE. */
async function collect(env: StoreEnv, base: string, head: { packs?: Record<string, number> }): Promise<void> {
  const live = new Set(Object.keys(head.packs ?? {}));
  const cutoff = Date.now() - GRACE_MS;
  let cursor: string | undefined;
  do {
    const page = await env.STORE.list({ prefix: `${base}/packs/`, cursor });
    const dead = page.objects
      .filter((o) => !live.has(o.key.slice(base.length + 7)) && o.uploaded.getTime() < cutoff)
      .map((o) => o.key);
    if (dead.length) await env.STORE.delete(dead);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** A /store request, or null when the path is not one. `owner` = carries the box secret. */
export async function handleStore(req: Request, env: StoreEnv, ctx: ExecutionContext, owner: boolean): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/store/")) return null;
  const m = url.pathname.match(ROUTE);
  if (!m) return fail(404, "no such route");
  const [, tenant, slug, vol, what, pack] = m;
  if (!owner && !(await capAllows(req, env, tenant, `${tenant}/${slug}/`))) return fail(401, "unauthorized");
  const base = `v1/${tenant}/${slug}/${vol}`;

  if (what === "head") {
    const key = `${base}/head.json`;
    if (req.method === "GET") {
      const obj = await env.STORE.get(key);
      if (!obj) return fail(404, "empty");
      return new Response(obj.body, { headers: { ETag: obj.httpEtag, "Content-Type": "application/json" } });
    }
    if (req.method === "PUT") {
      if (!req.headers.has("If-Match") && req.headers.get("If-None-Match") !== "*") {
        return fail(428, "a head write needs If-Match or If-None-Match: *");
      }
      const text = await req.text();
      if (text.length > MAX_HEAD) return fail(413, "head too large");
      let head: { packs?: Record<string, number> };
      try {
        head = JSON.parse(text);
      } catch {
        return fail(400, "head is not JSON");
      }
      const put = await env.STORE.put(key, text, { onlyIf: req.headers, httpMetadata: { contentType: "application/json" } });
      if (!put) return fail(412, "the head moved");
      ctx.waitUntil(collect(env, base, head));
      return new Response(null, { status: 200, headers: { ETag: put.httpEtag } });
    }
    return fail(405, "wrong method");
  }

  const key = `${base}/packs/${pack}`;
  if (req.method === "GET") {
    const obj = await env.STORE.get(key, { range: req.headers });
    if (!obj) return fail(404, "no such pack");
    if (!obj.range || !req.headers.has("Range")) return new Response(obj.body, { headers: { ETag: obj.httpEtag } });
    const r = obj.range as { offset?: number; length?: number; suffix?: number };
    const offset = r.suffix !== undefined ? obj.size - r.suffix : (r.offset ?? 0);
    const length = r.suffix !== undefined ? r.suffix : (r.length ?? obj.size - offset);
    return new Response(obj.body, {
      status: 206,
      headers: { ETag: obj.httpEtag, "Content-Range": `bytes ${offset}-${offset + length - 1}/${obj.size}` },
    });
  }
  if (req.method === "PUT") {
    const size = Number(req.headers.get("Content-Length"));
    if (!Number.isInteger(size) || size < 0) return fail(411, "a pack needs Content-Length");
    if (size > MAX_PACK) return fail(413, "pack too large");
    if (!req.body) return fail(400, "no body");
    try {
      // R2 checks the sha256 itself and refuses the write on a mismatch.
      await env.STORE.put(key, req.body.pipeThrough(new FixedLengthStream(size)), { sha256: pack });
    } catch (e) {
      return fail(400, `pack refused: ${String((e as Error).message ?? e)}`);
    }
    return new Response(null, { status: 200 });
  }
  return fail(405, "wrong method");
}
