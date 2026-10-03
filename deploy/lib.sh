#!/usr/bin/env bash
#
# deploy/lib.sh — the single copy of each install/update step for the viewer.
#
# Sourced by deploy/install.sh (fresh-machine install) and, from B5 on, the
# `harman` CLI / deploy/update.sh (in-place release updates). Keeping every step
# here — not duplicated in each entrypoint — is what stops install and update
# from drifting: they call the SAME functions. Sourcing this file only defines
# functions and config defaults; it runs no steps. The caller invokes them.
#
# Config (the env knobs install.sh has always honored; unchanged so dev-machine
# behavior is preserved):
#   PORT           listen port                       (default 8091)
#   SERVICE_USER   systemd User= / DB role owner      (default: invoking user)
#   SKIP_DEPS      non-empty → skip system packages
#   DATABASE_URL   external DB → skip local DB creation
#   NO_SERVICE     (handled by the orchestrator, not here)
#
# Plus one new internal knob for the release-symlink layout (B6):
#   HM_APP_DIR     dir the service runs from and bootstrap/build operate on
#                  (default: the repo root; prod points it at the `current`
#                  release symlink). For a plain dev checkout it equals the repo
#                  root, so nothing changes.
#   HM_WORKDIR     the service's WorkingDirectory (default: HM_APP_DIR). Prod
#                  pins this to the stable `current` symlink while HM_APP_DIR is
#                  the specific release dir being built — so the unit file points
#                  at `current` and the symlink swap is the whole cutover.
#
# Every function is idempotent — a no-op when its work is already done — so the
# whole sequence is safe to re-run.

# This file's own location → repo root. Works when sourced (BASH_SOURCE, not $0).
HM_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HM_REPO_DIR="$(cd "$HM_LIB_DIR/.." && pwd)"

OS="$(uname -s)"
PORT="${PORT:-8091}"
SERVICE_USER="${SERVICE_USER:-$(id -un)}"
HM_APP_DIR="${HM_APP_DIR:-$HM_REPO_DIR}"
HM_WORKDIR="${HM_WORKDIR:-$HM_APP_DIR}"

# Release-symlink layout (prod / the customer box). HM_PREFIX is overridable so
# the release logic can be exercised against a throwaway dir in tests without a
# real /opt or systemd. Secrets are NOT symlinked per-release: config.py already
# reads ~/.agents-apns.env (outside releases), which survives every swap.
HM_PREFIX="${HM_PREFIX:-/opt/harman}"
HM_RELEASES="$HM_PREFIX/releases"
HM_CURRENT="$HM_PREFIX/current"

# Every third-party Python module the server imports. paramiko backs remote
# hosts (terminal / files / sessions over SSH); PyJWT signs the APNs token;
# tomli/tomli-w read and write Codex's config.toml (tomllib is stdlib only from
# 3.11, and the system python on macOS is 3.9).
HM_PY_DEPS="psycopg2-binary paramiko PyJWT tomli tomli-w"

hm_log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

# 1. System prerequisites ──────────────────────────────────────────────────────
hm_deps() {
  if [[ -n "${SKIP_DEPS:-}" ]]; then
    hm_log "SKIP_DEPS set — assuming python3 / node / postgresql already present."
  elif [[ "$OS" == "Linux" ]] && command -v apt-get >/dev/null 2>&1; then
    hm_log "Installing system packages via apt (python3, node, postgresql)…"
    sudo apt-get update -qq
    sudo apt-get install -y python3 python3-pip nodejs npm postgresql
    pip3 install --user --quiet $HM_PY_DEPS
  elif [[ "$OS" == "Darwin" ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      echo "Homebrew not found. Install it first: https://brew.sh" >&2; return 1
    fi
    hm_log "Installing system packages via Homebrew (python, node, postgresql@16)…"
    brew install python node postgresql@16
    brew services start postgresql@16
    pip3 install --user --quiet $HM_PY_DEPS
  else
    hm_log "Unknown package manager on $OS — ensure python3/node/psql are present, or use SKIP_DEPS=1."
  fi
}

# 2. Postgres `viewer` database ────────────────────────────────────────────────
# DATABASE_URL overrides; default is the local `dbname=viewer` over the unix socket.
hm_db() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    hm_log "Using external DATABASE_URL — skipping local DB creation."
  elif [[ "$OS" == "Darwin" ]]; then
    # Homebrew Postgres runs as the invoking user — no `postgres` superuser role.
    if psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw viewer; then
      hm_log "Postgres database 'viewer' already exists."
    else
      hm_log "Creating Postgres database 'viewer'…"
      createdb viewer
    fi
  else
    # Linux: the DB cluster is owned by the `postgres` system role.
    if sudo -u postgres psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw viewer; then
      hm_log "Postgres database 'viewer' already exists."
    else
      hm_log "Creating Postgres database 'viewer' (+ role for $SERVICE_USER)…"
      sudo -u postgres createuser --superuser "$SERVICE_USER" 2>/dev/null || true
      sudo -u postgres createdb -O "$SERVICE_USER" viewer
    fi
  fi
}

# 3. Bootstrap schema + seed data (idempotent) ─────────────────────────────────
hm_bootstrap() {
  hm_log "Bootstrapping DB tables + seed data…"
  ( cd "$HM_APP_DIR" && python3 -m viewer.bootstrap )
}

# 4. Build the web UI ──────────────────────────────────────────────────────────
hm_web_build() {
  hm_log "Building the web UI (web/ → web/dist)…"
  ( cd "$HM_APP_DIR/web" && npm install && npm run build )
}

# 5. Service (survives reboot) ─────────────────────────────────────────────────
# Renders the unit/plist template from the shipped copy and registers it with the
# platform service manager, pointing WorkingDirectory at HM_APP_DIR. launchd's
# RunAtLoad / systemd's --now also start it, so after this the instance is live.
hm_service_install() {
  if [[ "$OS" == "Darwin" ]]; then
    local plist="$HOME/Library/LaunchAgents/com.harman.viewer.plist"
    local python_bin; python_bin="$(command -v python3)"
    hm_log "Installing launchd agent 'com.harman.viewer' (port=$PORT)…"
    mkdir -p "$HOME/Library/LaunchAgents"
    sed \
      -e "s|__PYTHON__|$python_bin|g" \
      -e "s|__WORKDIR__|$HM_WORKDIR|g" \
      -e "s|__PORT__|$PORT|g" \
      "$HM_REPO_DIR/deploy/com.harman.viewer.plist" > "$plist"
    # Reload cleanly if it was already loaded.
    launchctl bootout "gui/$(id -u)/com.harman.viewer" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    hm_log "Done. Instance should be live at http://localhost:$PORT"
    hm_log "  status:  launchctl print gui/$(id -u)/com.harman.viewer"
    hm_log "  logs:    tail -f $HM_WORKDIR/deploy/harman-viewer.log"
  else
    local unit_name="harman-viewer.service"
    hm_log "Installing systemd unit '$unit_name' (User=$SERVICE_USER, port=$PORT)…"
    sed \
      -e "s|^User=.*|User=$SERVICE_USER|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=$HM_WORKDIR|" \
      -e "s|server.py 8091|server.py $PORT|" \
      "$HM_REPO_DIR/deploy/$unit_name" | sudo tee "/etc/systemd/system/$unit_name" >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl enable --now "$unit_name"
    hm_log "Done. Instance should be live at http://localhost:$PORT"
    hm_log "  status:  systemctl status $unit_name"
    hm_log "  logs:    journalctl -u $unit_name -f"
  fi
}

# ─── Release-symlink helpers (used by the `harman` CLI / update.sh) ────────────
#
# Layout:
#   $HM_PREFIX/releases/vX.Y.Z/   a verified checkout + built web/dist + node_modules
#   $HM_PREFIX/current -> releases/vX.Y.Z   the ONLY thing an update moves
# The service's WorkingDirectory is $HM_PREFIX/current, so an atomic symlink swap
# + restart is the whole cutover. config.STATIC_DIR has no .resolve(), so the
# running code reads VERSION / web/dist through `current` and tracks the release.

hm_service_restart() {
  if [[ "$OS" == "Darwin" ]]; then
    launchctl kickstart -k "gui/$(id -u)/com.harman.viewer"
  else
    sudo systemctl restart harman-viewer.service
  fi
}

# Unpack a git bundle into releases/<ver>, verifying it carries exactly the
# expected commit and that the checkout's VERSION matches <ver> — BEFORE any
# slow build. Refuses to clobber an existing release dir. Echoes the release dir.
# Args: <ver> <bundle-path> <expect-sha>
hm_stage_release() {
  local ver="$1" bundle="$2" expect_sha="$3"
  local dest="$HM_RELEASES/$ver"
  [[ -e "$dest" ]] && { echo "release $ver already staged at $dest" >&2; return 1; }
  [[ -f "$bundle" ]] || { echo "bundle not found: $bundle" >&2; return 1; }
  mkdir -p "$HM_RELEASES"
  # Clone from the bundle. This re-hashes every object on the way in (a corrupt
  # or truncated bundle fails here), so it doubles as the integrity check — no
  # separate `git bundle verify`, which would need an ambient repo we don't have.
  git clone --quiet "$bundle" "$dest" || { echo "clone from bundle failed" >&2; return 1; }
  # Checking out the exact expected commit fails loudly if the bundle doesn't
  # actually carry it — catches a stale/wrong bundle paired with a real SHA.
  ( cd "$dest" && git checkout --quiet --detach "$expect_sha" ) || {
    echo "expected commit $expect_sha not in bundle" >&2; rm -rf "$dest"; return 1; }
  local got_sha got_ver
  got_sha="$(cd "$dest" && git rev-parse HEAD)"
  got_ver="$(tr -d '[:space:]' < "$dest/VERSION" 2>/dev/null)"
  if [[ "$got_sha" != "$expect_sha" ]]; then
    echo "SHA mismatch: staged $got_sha, expected $expect_sha" >&2; rm -rf "$dest"; return 1; fi
  if [[ "$got_ver" != "$ver" ]]; then
    echo "VERSION mismatch: file says '$got_ver', update is '$ver'" >&2; rm -rf "$dest"; return 1; fi
  echo "$dest"
}

# Atomic cutover: point `current` at releases/<ver> with a single rename(2).
# `current` is itself a symlink to a directory, so a plain `mv` would move the
# temp link INTO that directory. GNU mv needs -T and BSD mv needs -h to replace
# the link in place instead; both then do one atomic rename. `mv --version`
# succeeds only on GNU coreutils, which is the reliable discriminator.
hm_activate() {
  local ver="$1"
  [[ -d "$HM_RELEASES/$ver" ]] || { echo "no such release: $ver" >&2; return 1; }
  ln -sfn "releases/$ver" "$HM_CURRENT.tmp"
  if mv --version >/dev/null 2>&1; then
    mv -Tf "$HM_CURRENT.tmp" "$HM_CURRENT"   # GNU (Linux / WSL)
  else
    mv -fh "$HM_CURRENT.tmp" "$HM_CURRENT"   # BSD (macOS)
  fi
}

# The version `current` points at right now (empty if unset). Used by rollback.
hm_current_version() {
  [[ -L "$HM_CURRENT" ]] || return 0
  basename "$(readlink "$HM_CURRENT")"
}

# Poll /healthz until the SERVED disk version equals <ver>, or time out. This is
# the gate that distinguishes a real cutover from a half-applied one: it checks
# the version the process actually reports, not just that the port answers.
# Args: <ver> [timeout-secs=30]
hm_health_probe() {
  local ver="$1" timeout="${2:-30}" i served
  for (( i=0; i<timeout; i++ )); do
    served="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null \
                | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    [[ "$served" == "$ver" ]] && return 0
    sleep 1
  done
  echo "health probe timed out: /healthz never reported version $ver" >&2
  return 1
}

# Roll `current` back to <ver> (default: the newest OTHER staged release) and
# restart. Refuses a destructive downgrade — target SCHEMA_VERSION below what the
# DB is stamped at — unless HM_FORCE is set, because old code can't read a schema
# a newer release already migrated forward.
hm_rollback() {
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    local cur; cur="$(hm_current_version)"
    target="$(ls -1 "$HM_RELEASES" 2>/dev/null | grep -vx "$cur" | sort -V | tail -1)"
  fi
  [[ -n "$target" && -d "$HM_RELEASES/$target" ]] || { echo "no rollback target available" >&2; return 1; }
  local tgt_schema db_schema
  tgt_schema="$(cd "$HM_RELEASES/$target" && python3 -c 'from viewer import db; print(db.SCHEMA_VERSION)' 2>/dev/null || echo 0)"
  db_schema="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null \
                | sed -n 's/.*"db_schema"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p')"
  if [[ -n "$db_schema" && "$tgt_schema" -lt "$db_schema" && -z "${HM_FORCE:-}" ]]; then
    echo "refusing rollback: $target schema $tgt_schema < live db_schema $db_schema (set HM_FORCE=1 to override)" >&2
    return 1
  fi
  hm_log "Rolling back to ${target}…"
  hm_activate "$target"
  hm_service_restart
  hm_health_probe "$target"
}

# Retain the N newest non-current releases; prune older ones. Default N=3. The
# active release (`current`) is always kept, regardless of N. Uses an array
# slice rather than `head -n -N` (negative counts are GNU-only — fine on the WSL
# box but not portable, and this runs in CI/tests too).
hm_prune_releases() {
  local keep="${1:-3}" cur
  cur="$(hm_current_version)"
  [[ -d "$HM_RELEASES" ]] || return 0
  local all=()
  while IFS= read -r v; do all+=("$v"); done \
    < <(ls -1 "$HM_RELEASES" 2>/dev/null | grep -vx "$cur" | sort -V)
  local drop=$(( ${#all[@]} - keep ))
  (( drop > 0 )) || return 0
  local i
  for (( i=0; i<drop; i++ )); do
    hm_log "Pruning old release ${all[i]}"
    rm -rf "${HM_RELEASES:?}/${all[i]}"
  done
}
