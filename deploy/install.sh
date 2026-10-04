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
# The steps themselves live in deploy/lib.sh so the `harman` update path reuses
# them verbatim; this file just sequences them. See lib.sh for the env knobs.
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

# shellcheck source=deploy/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

hm_deps          # 1. system prerequisites
hm_db            # 2. Postgres `viewer` database
hm_pyenv         # 2b. Python venv + deps
hm_bootstrap     # 3. schema + seed data
hm_web_build     # 4. web UI → web/dist

# 5. Service (survives reboot)
if [[ -n "${NO_SERVICE:-}" ]]; then
  hm_log "NO_SERVICE set — skipping service install. Run manually with: $(hm_py) server.py $PORT"
  exit 0
fi
hm_service_install
hm_setup_code || true   # 6. print the one-time owner-signup code
