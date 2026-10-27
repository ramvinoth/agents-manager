/**
 * Manager relay — a Cloudflare Worker + Durable Object that lets a phone reach a
 * Manager server that has no public address. The server dials OUT to the relay;
 * the phone dials the relay; the relay pipes opaque bytes between them. All
 * application traffic is end-to-end encrypted (NaCl box, see viewer/relay.py
 * and mobile-app/src/lib/relayChannel.ts), so the relay can route but never read.
 *
 * Derived from Paseo's relay v2 (packages/relay/src/cloudflare-adapter.ts,
 * Copyright (c) 2025-present Mohamed Boudra, Apache-2.0 — see ./NOTICE).
 * Changes from upstream:
 *   - v2 only: no v1 protocol, no JSON-ping compatibility, no cutover proxy.
 *   - The server role must present a bearer token. The first token seen for a
 *     serverId is pinned (its SHA-256 lives in Durable Object storage), so a
 *     party that learned a serverId from a QR code cannot hijack the control
 *     socket and lock the real server out.
 *   - Client connectionIds are always relay-assigned, one socket per id, so a
 *     client cannot join (and corrupt) another client's encrypted session.
 *   - The client's CF-Connecting-IP rides along in connected/sync so the
 *     server can rate-limit sign-in per real client, not per relay.
 *
 * Sockets, one Durable Object per serverId:
 *   role=server                      control socket (one per serverId)
 *   role=server&connectionId=<id>    per-connection data socket
 *   role=client                      phone socket; relay assigns its <id>
 */
import { DurableObject } from "cloudflare:workers";

export interface Env {
  RELAY: DurableObjectNamespace<RelayDurableObject>;
}

type Role = "server" | "client";

interface Attachment {
  role: Role;
  connectionId: string | null;
  ip: string;
}

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CONN_RE = /^conn_[0-9a-f]{16}$/;
const MAX_PENDING_FRAMES = 200;
const NUDGE_DELAY_MS = 10_000;
const RESET_DELAY_MS = 5_000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function attachmentOf(ws: WebSocket): Attachment | null {
  try {
    const a = ws.deserializeAttachment() as Attachment | null;
    return a && (a.role === "server" || a.role === "client") ? a : null;
  } catch {
    return null;
  }
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // already closed
  }
}

export class RelayDurableObject extends DurableObject<Env> {
  private pendingFrames = new Map<string, Array<string | ArrayBuffer>>();

  /** Pin the first server token; afterwards only that token may act as server. */
  private async serverAuthorized(token: string): Promise<boolean> {
    if (token.length < 32) return false;
    const presented = await sha256Hex(token);
    const pinned = await this.ctx.storage.get<string>("serverTokenSha256");
    if (!pinned) {
      await this.ctx.storage.put("serverTokenSha256", presented);
      return true;
    }
    return timingSafeEqualHex(pinned, presented);
  }

  private sockets(tag: string): WebSocket[] {
    try {
      return this.ctx.getWebSockets(tag);
    } catch {
      return [];
    }
  }

  private clients(): Array<{ connectionId: string; ip: string }> {
    const out: Array<{ connectionId: string; ip: string }> = [];
    for (const ws of this.sockets("client")) {
      const a = attachmentOf(ws);
      if (a?.connectionId) out.push({ connectionId: a.connectionId, ip: a.ip });
    }
    return out;
  }

  private notifyControls(message: unknown): void {
    const text = JSON.stringify(message);
    for (const ws of this.sockets("server-control")) {
      try {
        ws.send(text);
      } catch {
        safeClose(ws, 1011, "Control send failed");
      }
    }
  }

  /**
   * A half-open control socket can't be detected by send errors, so watch for
   * the server's reaction instead: no data socket after 10s → resend sync;
   * still nothing 5s later → close control so the server reconnects.
   */
  private watchForServerData(connectionId: string): void {
    const waiting = () =>
      this.sockets(`client:${connectionId}`).length > 0 &&
      this.sockets(`server:${connectionId}`).length === 0;
    setTimeout(() => {
      if (!waiting()) return;
      this.notifyControls({ type: "sync", connections: this.clients() });
      setTimeout(() => {
        if (!waiting()) return;
        for (const ws of this.sockets("server-control")) safeClose(ws, 1011, "Control unresponsive");
      }, RESET_DELAY_MS);
    }, NUDGE_DELAY_MS);
  }

  private bufferFrame(connectionId: string, frame: string | ArrayBuffer): void {
    const frames = this.pendingFrames.get(connectionId) ?? [];
    frames.push(frame);
    if (frames.length > MAX_PENDING_FRAMES) frames.splice(0, frames.length - MAX_PENDING_FRAMES);
    this.pendingFrames.set(connectionId, frames);
  }

  private flushFrames(connectionId: string, serverWs: WebSocket): void {
    const frames = this.pendingFrames.get(connectionId);
    if (!frames?.length) return;
    this.pendingFrames.delete(connectionId);
    for (let i = 0; i < frames.length; i++) {
      try {
        serverWs.send(frames[i]);
      } catch {
        for (const rest of frames.slice(i)) this.bufferFrame(connectionId, rest);
        return;
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    if (role !== "server" && role !== "client") {
      return new Response("Missing or invalid role", { status: 400 });
    }

    let connectionId: string | null = null;
    let tags: string[];
    if (role === "server") {
      if (!(await this.serverAuthorized(bearer(request)))) {
        return new Response("Forbidden", { status: 403 });
      }
      connectionId = url.searchParams.get("connectionId");
      if (connectionId !== null && !CONN_RE.test(connectionId)) {
        return new Response("Invalid connectionId", { status: 400 });
      }
      const tag = connectionId ? `server:${connectionId}` : "server-control";
      for (const ws of this.sockets(tag)) safeClose(ws, 1008, "Replaced by new connection");
      tags = connectionId ? ["server", tag] : [tag];
    } else {
      connectionId = `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      tags = ["client", `client:${connectionId}`];
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, tags);
    const ip = role === "client" ? request.headers.get("CF-Connecting-IP") ?? "" : "";
    server.serializeAttachment({ role, connectionId, ip } satisfies Attachment);

    if (role === "client" && connectionId) {
      this.notifyControls({ type: "connected", connectionId, ip });
      this.watchForServerData(connectionId);
    } else if (!connectionId) {
      server.send(JSON.stringify({ type: "sync", connections: this.clients() }));
    } else {
      this.flushFrames(connectionId, server);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const a = attachmentOf(ws);
    if (!a?.connectionId) return; // control socket carries nothing upstream
    if (a.role === "client") {
      const servers = this.sockets(`server:${a.connectionId}`);
      if (servers.length === 0) {
        this.bufferFrame(a.connectionId, message);
        return;
      }
      for (const target of servers) {
        try {
          target.send(message);
        } catch (error) {
          console.error(`[relay] client->server(${a.connectionId}) failed`, error);
        }
      }
      return;
    }
    for (const target of this.sockets(`client:${a.connectionId}`)) {
      try {
        target.send(message);
      } catch (error) {
        console.error(`[relay] server->client(${a.connectionId}) failed`, error);
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    const a = attachmentOf(ws);
    if (!a?.connectionId) return;
    if (a.role === "client") {
      this.pendingFrames.delete(a.connectionId);
      for (const s of this.sockets(`server:${a.connectionId}`)) safeClose(s, 1001, "Client disconnected");
      this.notifyControls({ type: "disconnected", connectionId: a.connectionId });
      return;
    }
    // The server side dropped: make the phone reconnect and re-handshake.
    for (const c of this.sockets(`client:${a.connectionId}`)) {
      safeClose(c, 1012, `Server disconnected (${code}${reason ? `: ${reason}` : ""})`);
    }
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    console.error(`[relay] socket error (${attachmentOf(ws)?.role ?? "unknown"})`, error);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }
    if (url.pathname === "/ws") {
      const serverId = url.searchParams.get("serverId") ?? "";
      if (!ID_RE.test(serverId)) {
        return new Response("Missing or invalid serverId", { status: 400 });
      }
      return env.RELAY.get(env.RELAY.idFromName(`relay:${serverId}`)).fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
