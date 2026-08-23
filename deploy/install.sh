#!/usr/bin/env bash
#
# deploy/install.sh — idempotent fresh-machine install for the Harman viewer.
#
# Cross-platform (Linux + macOS). Brings a clean checkout to a running,
# reboot-surviving instance on :8091:
#   system deps → Postgres `viewer` DB → bootstrap → web build → service.
# Every step is a no-op when already done, so it is safe to re-run.
#
#   Linux : apt + `sudo -u postgres` DB + systemd unit (harman-viewer.service)
#   macOS : Homebrew + `brew services` DB + launchd agent (com.harman.viewer)
#
# Usage:
#   deploy/install.sh                 # full install as the invoking user
#   SERVICE_USER=alice deploy/install.sh   # Linux only (systemd User=)
#   PORT=9000 deploy/install.sh
#   SKIP_DEPS=1 deploy/install.sh     # skip system-package install (already present)
#   NO_SERVICE=1 deploy/install.sh    # set up everything but don't install the service
#
# It does NOT touch the Cloudflare tunnel (host-specific) or the optional
# voice/GPU services in deploy/ — see README for those.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SERVICE_USER:-$(id -un)}"
PORT="${PORT:-8091}"
OS="$(uname -s)"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

cd "$REPO_DIR"

# 1. System prerequisites ─────────────────────────────────────────────────────
if [[ -n "${SKIP_DEPS:-}" ]]; then
  log "SKIP_DEPS set — assuming python3 / node / postgresql already present."
elif [[ "$OS" == "Linux" ]] && command -v apt-get >/dev/null 2>&1; then
  log "Installing system packages via apt (python3, node, postgresql)…"
  sudo apt-get update -qq
  sudo apt-get install -y python3 python3-pip nodejs npm postgresql
  pip3 install --user --quiet psycopg2-binary
elif [[ "$OS" == "Darwin" ]]; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew not found. Install it first: https://brew.sh" >&2; exit 1
  fi
  log "Installing system packages via Homebrew (python, node, postgresql@16)…"
  brew install python node postgresql@16
  brew services start postgresql@16
  pip3 install --user --quiet psycopg2-binary
else
  log "Unknown package manager on $OS — ensure python3/node/psql are present, or use SKIP_DEPS=1."
fi

# 2. Postgres `viewer` database ───────────────────────────────────────────────
# DATABASE_URL overrides; default is the local `dbname=viewer` over the unix socket.
if [[ -n "${DATABASE_URL:-}" ]]; then
  log "Using external DATABASE_URL — skipping local DB creation."
elif [[ "$OS" == "Darwin" ]]; then
  # Homebrew Postgres runs as the invoking user — no `postgres` superuser role.
  if psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw viewer; then
    log "Postgres database 'viewer' already exists."
  else
    log "Creating Postgres database 'viewer'…"
    createdb viewer
  fi
else
  # Linux: the DB cluster is owned by the `postgres` system role.
  if sudo -u postgres psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw viewer; then
    log "Postgres database 'viewer' already exists."
  else
    log "Creating Postgres database 'viewer' (+ role for $SERVICE_USER)…"
    sudo -u postgres createuser --superuser "$SERVICE_USER" 2>/dev/null || true
    sudo -u postgres createdb -O "$SERVICE_USER" viewer
  fi
fi

# 3. Bootstrap schema + seed data (idempotent) ────────────────────────────────
log "Bootstrapping DB tables + seed data…"
python3 -m viewer.bootstrap

# 4. Build the web UI ─────────────────────────────────────────────────────────
log "Building the web UI (web/ → web/dist)…"
( cd web && npm install && npm run build )

# 5. Service (survives reboot) ────────────────────────────────────────────────
if [[ -n "${NO_SERVICE:-}" ]]; then
  log "NO_SERVICE set — skipping service install. Run manually with: python3 server.py $PORT"
  exit 0
fi

if [[ "$OS" == "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.harman.viewer.plist"
  PYTHON_BIN="$(command -v python3)"
  log "Installing launchd agent 'com.harman.viewer' (port=$PORT)…"
  mkdir -p "$HOME/Library/LaunchAgents"
  sed \
    -e "s|__PYTHON__|$PYTHON_BIN|g" \
    -e "s|__WORKDIR__|$REPO_DIR|g" \
    -e "s|__PORT__|$PORT|g" \
    "$REPO_DIR/deploy/com.harman.viewer.plist" > "$PLIST"
  # Reload cleanly if it was already loaded.
  launchctl bootout "gui/$(id -u)/com.harman.viewer" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  log "Done. Instance should be live at http://localhost:$PORT"
  log "  status:  launchctl print gui/$(id -u)/com.harman.viewer"
  log "  logs:    tail -f $REPO_DIR/deploy/harman-viewer.log"
else
  UNIT_NAME="harman-viewer.service"
  log "Installing systemd unit '$UNIT_NAME' (User=$SERVICE_USER, port=$PORT)…"
  sed \
    -e "s|^User=.*|User=$SERVICE_USER|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$REPO_DIR|" \
    -e "s|server.py 8091|server.py $PORT|" \
    "$REPO_DIR/deploy/$UNIT_NAME" | sudo tee "/etc/systemd/system/$UNIT_NAME" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$UNIT_NAME"
  log "Done. Instance should be live at http://localhost:$PORT"
  log "  status:  systemctl status $UNIT_NAME"
  log "  logs:    journalctl -u $UNIT_NAME -f"
fi
