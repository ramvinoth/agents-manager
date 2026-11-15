# Harman sandbox on Cloudflare Containers

One throwaway box per run, behind a Worker. The viewer drives it with
`orchestrator/runtime/backends/box_client.mjs` through the `cloudflare` driver
in `sandbox_drivers.py`. The wire format is at the top of `src/index.ts`.

## What it needs

- A Cloudflare account on Workers Paid (Containers are not on the free plan).
- Docker on the machine that deploys, since wrangler builds `../Dockerfile`.
- Node 22 or newer on the viewer machine, for `box_client.mjs`.

## Deploy

```sh
cd sandbox/cloudflare
npm install
npx wrangler login
openssl rand -hex 32 | npx wrangler secret put BOX_SECRET
npx wrangler deploy
```

The first deploy pushes the image and can take several minutes. Later deploys
only rebuild changed layers.

## Point the viewer at it

Write `~/.config/harman/sandbox-cloudflare.json`, readable only by the viewer's
user (`chmod 600`), or set `HARMAN_SANDBOX_CF_CONFIG` to another path:

```json
{"url": "https://harman-sandbox.<account>.workers.dev", "secret": "<BOX_SECRET>", "node": "/path/to/node"}
```

`node` is optional; without it the driver uses the `node` on PATH. Then set the
server setting `sandbox_provider` to `cloudflare`. A run whose runtime is
`sandbox` now starts its box here.

## How the box reaches the viewer

A box on the internet cannot reach the viewer's loopback or private network.
The driver gives each such address (loopback, private and tailnet IPs, `.local`
and `.ts.net` names) an alias, and the box dials
`http://<alias>.harman.internal`. The Worker intercepts that request and hands
it down the reach tunnel the viewer holds open, and the viewer fetches the real
address. Only the aliases a run was routed exist, so a box cannot use the
tunnel to reach anything else on the viewer's network. Nothing on the viewer is
exposed to the internet.

## Traps

- Durable Object WebSockets deliver binary frames as `Blob` unless the server
  side sets `binaryType = "arraybuffer"`.
- Every URL has to be routed before the box starts: the tunnel announces its
  list of aliases when it connects.
