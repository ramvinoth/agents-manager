/**
 * End-to-end: the session events stream (/api/events/ws) through the
 * relay, on this machine, with the phone's own client code.
 *
 *   node (ServerTransport → RelayLink, E2EE) ──ws──> relay Worker (wrangler dev)
 *        <──ws── orchestrator/relay.py RelayService ──ws──> spare viewer (VIEWER_PREFLIGHT)
 *
 * Checks, all through the relay:
 *   1. /healthz answers (the relayed HTTP path is up).
 *   2. LiveStream — the phone's stream (api/events.ts) — goes live (hello) and
 *      hears list-changed when a chat appears in the projects folder.
 *   3. A raw relayed socket sends a watch frame for a transcript no run writes,
 *      gets `watching ok`, and hears transcript-changed when the file grows
 *      (the client→server direction the web uses).
 *
 * The spare viewer runs with a throwaway HOME, so its projects folder is an
 * empty temp dir and nothing it sees or writes is a real chat; it still talks
 * to the local Postgres (read-only for this test). VIEWER_NO_AUTH stands in
 * for a paired phone's bearer token. What this does NOT cover: a real phone,
 * the deployed relay, APNs, backgrounding.
 *
 * Needs `npm ci` in relay/ (wrangler) and in mobile-app/. Run from mobile-app/:
 *   node --experimental-strip-types scripts/relay-events-e2e.ts
 * Ports: E2E_RELAY_PORT (8787), E2E_VIEWER_PORT (8099). Exit 0 = all passed.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import nacl from "tweetnacl"
import { LiveStream, type LiveEvent } from "../src/lib/liveEvents.ts"
import { ServerTransport, type TransportDeps } from "../src/lib/serverTransport.ts"
import type { AppSocket } from "../src/lib/deferredSocket.ts"

// this script's own path (import.meta is outside the app's tsc module setting)
const ROOT = resolve(dirname(process.argv[1]), "../..")
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT || 8787)
const VIEWER_PORT = Number(process.env.E2E_VIEWER_PORT || 8099)
const PY = join(ROOT, ".venv/bin/python") // the server venv deploy/lib.sh hm_pyenv builds
const STEP_MS = 20_000

const children: ChildProcess[] = []
const home = mkdtempSync(join(tmpdir(), "relay-e2e-"))
let failed = 0

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? " — " + detail : ""}`)
  if (!ok) failed++
}

function start(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  const keep = (b: Buffer) => { log = (log + b.toString()).slice(-4000) }
  p.stdout!.on("data", keep)
  p.stderr!.on("data", keep)
  children.push(p)
  return { proc: p, log: () => log }
}

async function until<T>(label: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = STEP_MS): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error(`timed out: ${label}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function httpUp(url: string) {
  const r = await fetch(url)
  return r.ok
}

function cleanup() {
  for (const p of children) {
    try {
      if (p.pid) process.kill(-p.pid, "SIGTERM") // the group: wrangler's workerd too
    } catch {
      // already gone
    }
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(join(ROOT, "relay", ".wrangler"), { recursive: true, force: true })
}

async function main() {
  // A throwaway relay identity, in orchestrator/relay.py identity()'s shape.
  const keys = nacl.box.keyPair()
  const ident = {
    serverId: randomBytes(18).toString("base64url"),
    publicKey: Buffer.from(keys.publicKey).toString("base64"),
    secretKey: Buffer.from(keys.secretKey).toString("base64"),
    token: randomBytes(32).toString("base64url"),
  }
  const relayUrl = `ws://127.0.0.1:${RELAY_PORT}`
  const projects = join(home, ".claude", "projects", "-e2e-relay")
  mkdirSync(projects, { recursive: true })
  const sid = randomUUID()
  const transcript = join(projects, `${sid}.jsonl`)
  writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }) + "\n")

  const pyEnv = {
    HOME: home,
    // the real user site-packages (psycopg2, nacl), which HOME no longer finds
    PYTHONUSERBASE: join(homedir(), "Library", "Python", "3.9"),
    VIEWER_PREFLIGHT: "1",
    VIEWER_NO_AUTH: "1",
    VIEWER_HOST: "127.0.0.1", // a preflight spare never starts its own relay; the service below dials
  }
  const worker = start("npx", ["wrangler", "dev", "--port", String(RELAY_PORT), "--ip", "127.0.0.1"], join(ROOT, "relay"))
  const viewer = start(PY, ["server.py", String(VIEWER_PORT)], ROOT, pyEnv)
  try {
    await until("relay worker", () => httpUp(`http://127.0.0.1:${RELAY_PORT}/health`), 60_000)
    await until("spare viewer", () => httpUp(`http://127.0.0.1:${VIEWER_PORT}/healthz`), 60_000)
  } catch (e) {
    console.log(worker.log(), viewer.log())
    throw e
  }
  const service = start(PY, ["-c", [
    "import json, os, sys",
    `sys.argv = ["relay-e2e", "${VIEWER_PORT}"]`,
    "from orchestrator import relay",
    `relay.RelayService("${relayUrl}", json.loads(os.environ["E2E_RELAY_IDENT"])).run_forever()`,
  ].join("\n")], ROOT, { ...pyEnv, E2E_RELAY_IDENT: JSON.stringify(ident) })

  const deps: TransportDeps = {
    direct: {
      fetch: () => Promise.reject(new Error("relay only")),
      exchange: () => Promise.reject(new Error("relay only")),
      upload: () => Promise.reject(new Error("relay only")),
      download: () => Promise.reject(new Error("relay only")),
      socket: () => { throw new Error("relay only") },
    },
    files: { read: () => Promise.reject(new Error("unused")), write: () => Promise.reject(new Error("unused")) },
    relay: { WebSocket: globalThis.WebSocket as any, randomBytes: (n) => new Uint8Array(randomBytes(n)) },
  }
  const transport = new ServerTransport({ direct: "", relay: { url: relayUrl, serverId: ident.serverId, publicKey: ident.publicKey } }, deps)
  try {
    // 1. HTTP through the relay (the service needs a moment to attach).
    const health = await until("relayed /healthz", async () => {
      const r = await transport.fetch("GET", "/healthz", {})
      return r.ok ? JSON.parse(await r.text()) : null
    }, 30_000).catch((e) => { console.log(service.log()); throw e })
    check("relayed /healthz", health?.ok === true)

    // 2. The phone's stream: live, then list-changed for a new chat.
    const events: LiveEvent[] = []
    let live = false
    const stream = new LiveStream(() => transport.openSocket("/api/events/ws", {}))
    const off = stream.subscribe({ onLive: (l) => { live = l }, onEvent: (ev) => events.push(ev) })
    await until("LiveStream live", () => live)
    check("LiveStream goes live through the relay", true)
    writeFileSync(join(projects, `${randomUUID()}.jsonl`), "{}\n")
    await until("list-changed", () => events.some((e) => e.type === "list-changed"))
    check("list-changed reaches the phone's stream", true)
    off()

    // 3. A raw relayed socket: watch → watching ok → transcript-changed.
    const frames: any[] = []
    const sock: AppSocket = transport.openSocket("/api/events/ws", {})
    sock.onmessage = (m) => { try { frames.push(JSON.parse(String(m.data))) } catch { /* binary */ } }
    await until("hello", () => frames.some((f) => f.type === "hello"))
    sock.send(JSON.stringify({ type: "watch", sessions: [{ session: sid, host: "local", agent: "claude", path: `projects/-e2e-relay/${sid}.jsonl` }] }))
    const ack = await until("watching", () => frames.find((f) => f.type === "watching" && f.session === sid))
    check("the server sees the watched transcript", ack.ok === true)
    appendFileSync(transcript, JSON.stringify({ type: "assistant", uuid: "u2", message: { role: "assistant", content: "hello" } }) + "\n")
    const grew = await until("transcript-changed", () => frames.find((f) => f.type === "transcript-changed" && f.session === sid))
    check("transcript-changed for a file no run writes", typeof grew.size === "number" && grew.size > 0, `size ${grew.size}, uuid ${grew.uuid}`)
    const stray = randomUUID()
    sock.send(JSON.stringify({ type: "watch", sessions: [{ session: stray, host: "local", agent: "claude", path: "projects/../../../etc/hosts" }] }))
    const refused = await until("watching (escape)", () => frames.find((f) => f.type === "watching" && f.session === stray))
    check("a path escaping the projects folder is not watched", refused.ok === false)
    sock.close()
  } finally {
    transport.close()
  }
}

// Interrupted (Ctrl-C, a killed CI step): still stop the spawned servers.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { cleanup(); process.exit(130) })
}

main()
  .catch((e) => { failed++; console.log("FAIL", e?.message || e) })
  .finally(() => {
    cleanup()
    console.log(failed ? `relay events e2e: ${failed} failed` : "relay events e2e: all passed")
    process.exit(failed ? 1 : 0)
  })
