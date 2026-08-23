# Harman

Harman (**Harness Manager**) is a self-hosted web app for **viewing and driving coding-agent sessions** — Claude, Codex,
Copilot, and Pi — on your own machine and across your SSH hosts. Point it at your agent
transcripts and it renders them as readable conversations; connect a host and you can start
and steer runs right from the browser.

> **Agents Manager** — the app is branded **Agents** in the UI.

## What it does

- **Read any session** — renders agent transcript JSONL (Claude/Codex/Copilot/Pi) as a clean
  conversation, with stats, token usage, transcript search, and a per-session summary.
  Drag-and-drop a `.jsonl` file to view it with **no account**.
- **Drive agents** — send messages, queue turns, fork or restore a conversation to an
  earlier point, and manage skills and MCP servers per project.
- **Bring your own hosts (BYOH)** — connect remote machines over SSH (password or key auth)
  and browse, read, and drive their sessions exactly like local ones.
- **Live panels** — an in-browser terminal (PTY over WebSocket) and a live browser view,
  scoped to the selected host.

## Requirements

- Python 3.10+
- Node.js 20+ (to build the web UI)
- PostgreSQL (stores accounts, login sessions, and per-user preferences)

## Quick start

```bash
# 1. Create the auth database (one time)
createdb viewer

# 2. Build the web UI
cd web && npm install && npm run build && cd ..

# 3. Bootstrap the empire (idempotent: tables + seed CEO/Harman + skills dir)
make bootstrap

# 4. Run the server (defaults to :8091)
make serve         # or: python3 server.py 8091
```

Open <http://localhost:8091>. **The first sign-up claims the instance** — after that,
registration is closed and it's login-only. Viewing a dropped `.jsonl` needs no account.

Set `DATABASE_URL` to point at a non-default Postgres; it defaults to the local `viewer`
database over the Unix socket.

## Install on a new machine

`deploy/install.sh` does the whole thing idempotently and leaves a **reboot-surviving**
service running on `:8091` — system deps, the `viewer` database, bootstrap, the web build,
and the service. It is cross-platform: **Linux** installs a systemd unit
(`harman-viewer.service`), **macOS** installs a launchd agent (`com.harman.viewer`).

```bash
git clone <repo-url> ~/Documents/projects/agents
cd ~/Documents/projects/agents
deploy/install.sh
```

Environment knobs: `PORT=` (default 8091), `DATABASE_URL=` (skip local DB creation),
`SERVICE_USER=` (Linux systemd `User=`), `SKIP_DEPS=1` (packages already present),
`NO_SERVICE=1` (set up everything but don't install the service).

Notes:
- **Linux** uses `apt` + `sudo -u postgres`; **macOS** uses Homebrew (`brew install …` +
  `brew services`) — install [Homebrew](https://brew.sh) first.
- Re-running is safe; every step is a no-op if already done.
- The Cloudflare tunnel and the optional voice/GPU services in `deploy/` are host-specific
  and stay manual.

## Development

`make check` is the full gate — lint (ruff + Python/JS syntax) + web build + an API smoke
suite + a React end-to-end run:

```bash
make serve    # (re)start the server — required before testing backend changes
make check    # lint + build + smoke + e2e
```

`make check` does **not** restart the server, so run `make serve` first whenever you change
backend code.

## Security

- Every `/api` route and WebSocket requires a logged-in session; only the auth endpoints are
  public. Viewing a dropped file is entirely client-side.
- Passwords are pbkdf2-hashed and salted; sign-in is rate-limited per client IP.
- The server binds to `0.0.0.0` — run it on a private network (e.g. Tailscale) or behind your
  own front door. `VIEWER_NO_AUTH=1` disables the login gate and is for trusted local use only.

## License

MIT — see [LICENSE](LICENSE).
