// The viewer's side of the Cloudflare sandbox Worker (sandbox/cloudflare).
//
//   node box_client.mjs <mode> <box name>
//
// Address and secret come from HARMAN_BOX_URL and HARMAN_BOX_SECRET, the
// mode's arguments from HARMAN_BOX_SPEC (JSON). Modes:
//
//   start    start the box                     spec {labels}
//   exec     run a command, this process's stdio is its stdio, exit code is its
//            exit code                         spec {argv, user, cwd, env}
//   reach    hold the tunnel the box calls this machine back through, until
//            killed                            spec {targets: {alias: origin}}
//   destroy  stop the box
//   list     print live box names, one a line  spec {labels}
//
// The wire format is described at the top of sandbox/cloudflare/src/index.ts.

const [major] = process.versions.node.split(".").map(Number);
if (major < 22) {
  process.stderr.write(`box_client needs Node 22 or newer, this is ${process.version}\n`);
  process.exit(2);
}

const [mode, name] = process.argv.slice(2);
const base = (process.env.HARMAN_BOX_URL || "").replace(/\/$/, "");
const secret = process.env.HARMAN_BOX_SECRET || "";
const spec = JSON.parse(process.env.HARMAN_BOX_SPEC || "{}");
const auth = { Authorization: `Bearer ${secret}` };
const DROP = new Set(["host", "content-length", "connection", "transfer-encoding", "content-encoding", "keep-alive"]);

function die(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

async function post(path, body) {
  const r = await fetch(base + path, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  if (!r.ok) die(`${r.status} ${text}`);
  return text;
}

function socket(path) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + path, { headers: auth });
  ws.binaryType = "arraybuffer";
  return ws;
}

function write(stream, buf) {
  return new Promise((resolve) => (stream.write(buf) ? resolve() : stream.once("drain", resolve)));
}

function exec() {
  const ws = socket(`/box/${name}/exec`);
  let written = 0;
  let out = Promise.resolve();
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify(spec));
    process.stdin.on("data", (d) => ws.send(d));
    process.stdin.on("end", () => ws.send(JSON.stringify({ eof: true })));
    process.stdin.on("error", () => ws.send(JSON.stringify({ eof: true })));
  });
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.exit !== undefined) out.then(() => process.exit(msg.exit));
      else if (msg.error) out.then(() => die(msg.error, 125));
      return;
    }
    const buf = Buffer.from(ev.data);
    const target = buf[0] === 2 ? process.stderr : process.stdout;
    out = out.then(async () => {
      await write(target, buf.subarray(1));
      written += buf.length - 1;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ack: written }));
    });
  });
  ws.addEventListener("close", (ev) => out.then(() => die(`box connection closed (${ev.code} ${ev.reason})`, 125)));
  ws.addEventListener("error", () => die("box connection failed", 125));
  // Killed by the backend: closing the socket kills the process in the box.
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { ws.close(1000, sig); process.exit(143); });
}

function reach() {
  // Only the origins the driver routed for this run; the box names them by alias.
  const targets = new Map(Object.entries(spec.targets || {}));
  let backoff = 500;
  const connect = () => {
    const ws = socket(`/box/${name}/reach`);
    const live = new Map();
    ws.addEventListener("open", () => { backoff = 500; ws.send(JSON.stringify({ targets: [...targets.keys()] })); });
    ws.addEventListener("message", async (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = JSON.parse(ev.data);
      if (msg.cancel) { live.get(msg.id)?.abort(); return; }
      const send = (obj) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));
      const origin = targets.get(msg.target);
      if (!origin) return send({ id: msg.id, error: "not a target of this run" });
      const ctl = new AbortController();
      live.set(msg.id, ctl);
      try {
        const headers = Object.fromEntries(Object.entries(msg.headers || {}).filter(([k]) => !DROP.has(k)));
        const r = await fetch(origin + msg.path, {
          method: msg.method, headers, signal: ctl.signal, redirect: "manual",
          body: msg.body_b64 ? Buffer.from(msg.body_b64, "base64") : undefined,
        });
        const h = {};
        r.headers.forEach((v, k) => { if (!DROP.has(k)) h[k] = v; });
        send({ id: msg.id, status: r.status, headers: h });
        if (r.body) {
          for await (const chunk of r.body) {
            if (ws.readyState !== WebSocket.OPEN) break;
            const frame = Buffer.alloc(chunk.length + 4);
            frame.writeUInt32BE(msg.id, 0);
            frame.set(chunk, 4);
            ws.send(frame);
          }
        }
        send({ id: msg.id, end: true });
      } catch (e) {
        send({ id: msg.id, error: String(e?.message ?? e) });
      } finally {
        live.delete(msg.id);
      }
    });
    ws.addEventListener("close", () => {
      for (const c of live.values()) c.abort();
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    });
    ws.addEventListener("error", () => {});
  };
  connect();
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
}

async function main() {
  if (!base.startsWith("https://") || !secret || !name) die("usage: box_client.mjs <mode> <name> with HARMAN_BOX_URL and HARMAN_BOX_SECRET set", 2);
  if (mode === "start") await post(`/box/${name}/start`, { labels: spec.labels || {} });
  else if (mode === "destroy") await post(`/box/${name}/destroy`);
  else if (mode === "list") {
    const r = await fetch(`${base}/boxes?labels=${encodeURIComponent(JSON.stringify(spec.labels || {}))}`, { headers: auth });
    if (!r.ok) die(`${r.status} ${await r.text()}`);
    for (const n of await r.json()) process.stdout.write(`${n}\n`);
  } else if (mode === "exec") exec();
  else if (mode === "reach") reach();
  else die(`unknown mode ${mode}`, 2);
}

main().catch((e) => die(String(e?.message ?? e)));
