/**
 * Harman sandbox on Cloudflare Containers: one throwaway box per run.
 *
 * The viewer's CloudflareDriver (orchestrator/runtime/backends/sandbox_drivers.py)
 * drives it through box_client.mjs. Every route needs the shared secret.
 *
 *   POST /box/:name/start     start the box {labels}
 *   WS   /box/:name/exec      run one command, stdio piped over the socket
 *   WS   /box/:name/reach     the tunnel the box uses to call the viewer back
 *   POST /box/:name/destroy   stop the box
 *   GET  /boxes?labels=<json> names of live boxes carrying those labels
 *
 * Exec socket. Client sends a JSON spec {argv, user, cwd, env} first, then
 * stdin as binary frames and {"eof":true}. The box sends binary frames whose
 * first byte is the channel (1 stdout, 2 stderr), then {"exit":n} or
 * {"error":msg}. The client acks bytes it has written with {"ack":total}; the
 * box stops reading the process once WINDOW bytes are unacked. Closing the
 * socket kills the process.
 *
 * Reach socket. The client first sends {"targets":[alias,...]}, the names
 * this run may dial. The box dials http://<alias>.harman.internal; that
 * request is intercepted, framed as {id, method, target, path, headers,
 * body_b64} and sent down the tunnel, where the client fetches it from the
 * origin the alias stands for. The client answers {id, status, headers}, then binary
 * frames [4 byte id][data], then {id, end} (or {id, error}). The box going
 * away sends {id, cancel}.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export interface Env {
  BOX: DurableObjectNamespace<HarmanBox>;
  REGISTRY: DurableObjectNamespace<Registry>;
  BOX_SECRET: string;
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,63}$/;
const REACH_RE = /^([a-z0-9-]{1,32})\.harman\.internal$/;
const WINDOW = 4 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const MAX_BODY = 16 * 1024 * 1024;
const IDLE_MS = 30 * 60 * 1000;          // box outlives a quiet Durable Object this long
const MAX_LIFE_MS = 6 * 60 * 60 * 1000;  // and never runs longer than this

const enc = new TextEncoder();

function authorized(req: Request, env: Env): boolean {
  const got = enc.encode(req.headers.get("Authorization") ?? "");
  const want = enc.encode(`Bearer ${env.BOX_SECRET}`);
  if (!env.BOX_SECRET || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!authorized(req, env)) return fail(401, "unauthorized");
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/boxes") {
      const labels = JSON.parse(url.searchParams.get("labels") || "{}");
      return Response.json(await env.REGISTRY.getByName("all").list(labels));
    }
    const m = url.pathname.match(/^\/box\/([^/]+)\/(start|exec|reach|destroy)$/);
    if (!m || !NAME_RE.test(m[1])) return fail(404, "no such route");
    const [, name, action] = m;
    const box = env.BOX.getByName(name);
    try {
      if (action === "start" && req.method === "POST") {
        const { labels = {} } = await req.json<{ labels?: Record<string, string> }>();
        await box.boot(name, labels);
        return Response.json({ ok: true });
      }
      if (action === "destroy" && req.method === "POST") {
        await box.shutdown();
        return Response.json({ ok: true });
      }
      if ((action === "exec" || action === "reach") && req.headers.get("Upgrade") === "websocket") {
        return box.fetch(req);
      }
    } catch (e) {
      return fail(500, String((e as Error).message ?? e));
    }
    return fail(405, "wrong method");
  },
} satisfies ExportedHandler<Env>;

/** Where intercepted box traffic lands: hands it to the box's own tunnel. */
export class ReachGateway extends WorkerEntrypoint<Env, { box: string }> {
  async fetch(req: Request): Promise<Response> {
    return this.env.BOX.getByName(this.ctx.props.box).relay(req);
  }
}

interface Pending {
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  stream?: ReadableStreamDefaultController<Uint8Array>;
}

export class HarmanBox extends DurableObject<Env> {
  private tunnel: WebSocket | null = null;
  private targets = new Set<string>();
  private pending = new Map<number, Pending>();
  private nextId = 1;

  private get container() {
    const c = this.ctx.container;
    if (!c) throw new Error("this Durable Object has no container");
    return c;
  }

  async boot(name: string, labels: Record<string, string>): Promise<void> {
    const c = this.container;
    if (c.running) throw new Error(`box ${name} is already running`);
    await c.interceptOutboundHttp("*.harman.internal", this.ctx.exports.ReachGateway({ props: { box: name } }));
    c.start({ image: c.images.base, instance: "standard-1", enableInternet: true, labels });
    await c.setInactivityTimeout(IDLE_MS);
    await this.ctx.storage.put("name", name);
    await this.ctx.storage.setAlarm(Date.now() + MAX_LIFE_MS);
    await this.env.REGISTRY.getByName("all").add(name, labels);
  }

  async shutdown(): Promise<void> {
    const name = await this.ctx.storage.get<string>("name");
    if (this.ctx.container?.running) await this.ctx.container.destroy("removed by the viewer");
    this.tunnel?.close(1000, "box removed");
    this.tunnel = null;
    if (name) await this.env.REGISTRY.getByName("all").remove(name);
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    await this.shutdown();
  }

  async fetch(req: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.binaryType = "arraybuffer";   // the default here is Blob
    if (new URL(req.url).pathname.endsWith("/reach")) this.holdTunnel(server);
    else this.serveExec(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- exec -----------------------------------------------------------------

  private serveExec(ws: WebSocket): void {
    let proc: ExecProcess | null = null;
    // stdin frames can arrive before the process exists, so they queue behind it.
    let opened!: (w: WritableStreamDefaultWriter<Uint8Array> | null) => void;
    let stdin: Promise<WritableStreamDefaultWriter<Uint8Array> | null> = new Promise((r) => (opened = r));
    let sent = 0, acked = 0;
    let wake: (() => void) | null = null;
    let closed = false;
    const kill = () => { closed = true; try { proc?.kill(9); } catch { /* already gone */ } wake?.(); };

    const pump = async (stream: ReadableStream<Uint8Array> | null | undefined, channel: number) => {
      if (!stream) return;
      for await (const chunk of stream) {
        for (let off = 0; off < chunk.length && !closed; off += CHUNK) {
          const part = chunk.subarray(off, off + CHUNK);
          while (sent - acked > WINDOW && !closed) await new Promise<void>((r) => (wake = r));
          const frame = new Uint8Array(part.length + 1);
          frame[0] = channel;
          frame.set(part, 1);
          ws.send(frame);
          sent += part.length;
        }
        if (closed) return;
      }
    };

    const start = async (spec: { argv: string[]; user?: string; cwd?: string; env?: Record<string, string> }) => {
      proc = await this.container.exec(spec.argv, {
        stdin: "pipe", user: spec.user, cwd: spec.cwd ?? undefined, env: spec.env,
      });
      opened(proc.stdin!.getWriter());
      if (closed) return kill();
      await Promise.all([pump(proc.stdout, 1), pump(proc.stderr, 2)]);
      const code = await proc.exitCode;
      if (!closed) ws.send(JSON.stringify({ exit: code }));
      ws.close(1000, "done");
    };

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data);
        if (msg.argv) {
          start(msg).catch((e) => {
            opened(null);
            if (!closed) ws.send(JSON.stringify({ error: String(e?.message ?? e) }));
            ws.close(1011, "exec failed");
          });
        } else if (msg.ack !== undefined) {
          acked = msg.ack;
          wake?.();
        } else if (msg.eof) {
          stdin = stdin.then(async (w) => { await w?.close().catch(() => {}); return w; });
        }
      } else {
        const data = new Uint8Array(ev.data as ArrayBuffer);
        stdin = stdin.then(async (w) => { await w?.write(data).catch(() => {}); return w; });
      }
    });
    ws.addEventListener("close", kill);
    ws.addEventListener("error", kill);
  }

  // --- reach ----------------------------------------------------------------

  private holdTunnel(ws: WebSocket): void {
    this.tunnel?.close(1000, "replaced by a newer tunnel");
    this.tunnel = ws;
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data);
        if (msg.targets) { this.targets = new Set(msg.targets.map(String)); return; }
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.status !== undefined) {
          const body = new ReadableStream<Uint8Array>({
            start: (c) => { p.stream = c; },
            cancel: () => { this.pending.delete(msg.id); this.tunnel?.send(JSON.stringify({ id: msg.id, cancel: true })); },
          });
          p.resolve(new Response(msg.status === 204 || msg.status === 304 ? null : body,
            { status: msg.status, headers: msg.headers }));
        } else if (msg.end || msg.error) {
          this.pending.delete(msg.id);
          if (p.stream) msg.error ? p.stream.error(new Error(msg.error)) : p.stream.close();
          else p.reject(new Error(msg.error ?? "no response"));
        }
      } else {
        const buf = new Uint8Array(ev.data as ArrayBuffer);
        const id = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
        this.pending.get(id)?.stream?.enqueue(buf.slice(4));
      }
    });
    const drop = () => {
      if (this.tunnel !== ws) return;
      this.tunnel = null;
      for (const [id, p] of this.pending) {
        p.stream ? p.stream.error(new Error("tunnel closed")) : p.reject(new Error("tunnel closed"));
        this.pending.delete(id);
      }
    };
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
  }

  async relay(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const target = url.hostname.match(REACH_RE)?.[1];
    if (!target || !this.targets.has(target)) return new Response("not a target of this run", { status: 403 });
    if (!this.tunnel) return new Response("the viewer is not connected", { status: 502 });
    const body = req.body ? new Uint8Array(await req.arrayBuffer()) : null;
    if (body && body.length > MAX_BODY) return new Response("request too large", { status: 413 });
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const id = this.nextId++;
    const answer = new Promise<Response>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.tunnel.send(JSON.stringify({
      id, method: req.method, target, path: url.pathname + url.search, headers,
      body_b64: body ? btoa(Array.from(body, (b) => String.fromCharCode(b)).join("")) : null,
    }));
    try {
      return await answer;
    } catch (e) {
      return new Response(String((e as Error).message), { status: 502 });
    }
  }
}

/** Which boxes are alive, so the viewer can sweep the ones a crash left behind. */
export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS boxes (name TEXT PRIMARY KEY, labels TEXT NOT NULL)");
  }

  add(name: string, labels: Record<string, string>): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO boxes VALUES (?, ?)", name, JSON.stringify(labels));
  }

  remove(name: string): void {
    this.ctx.storage.sql.exec("DELETE FROM boxes WHERE name = ?", name);
  }

  list(want: Record<string, string>): string[] {
    const rows = this.ctx.storage.sql.exec<{ name: string; labels: string }>("SELECT name, labels FROM boxes").toArray();
    return rows.filter((r) => {
      const have = JSON.parse(r.labels);
      return Object.entries(want).every(([k, v]) => have[k] === v);
    }).map((r) => r.name);
  }
}
