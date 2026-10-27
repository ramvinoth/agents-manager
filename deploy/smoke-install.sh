#!/usr/bin/env bash
#
# deploy/smoke-install.sh — prove a fresh Linux box installs and boots Manager.
#
# Runs the real deploy/lib.sh steps (deps → DB → venv → bootstrap → web build)
# in a throwaway root-capable environment, starts the server, and asserts the
# public contract: /healthz is healthy and the API refuses an anonymous call.
# Used by CI (ubuntu:24.04 container — the distro WSL2 installs on customer
# boxes) and runnable locally:
#   docker run --rm -v "$PWD:/src:ro" ubuntu:24.04 bash /src/deploy/smoke-install.sh
# Never run it on a real host: it installs system packages and starts Postgres.
set -euo pipefail   # same strictness as install.sh and agents
export DEBIAN_FRONTEND=noninteractive
SRC="${SRC:-/src}" APP=/app PORT=8091

apt-get update -qq && apt-get install -y -qq sudo rsync curl >/dev/null
rsync -a --exclude node_modules --exclude .git --exclude web/dist --exclude .venv \
      --exclude mobile-app "$SRC/" "$APP/"
cd "$APP"
# shellcheck source=deploy/lib.sh
source deploy/lib.sh

hm_deps
service postgresql start
hm_db
hm_pyenv
hm_bootstrap
hm_web_build

VIEWER_HOST=127.0.0.1 "$(hm_py)" server.py "$PORT" >/tmp/server.log 2>&1 &
health=""
for _ in $(seq 1 30); do
  health="$(curl -fsS "http://127.0.0.1:$PORT/healthz" 2>/dev/null)" && break
  sleep 1
done
echo "healthz: $health"
[[ "$health" == *'"ok": true'* && "$health" == *'"db_ok": true'* ]] \
  || { echo "FAIL: /healthz not healthy"; tail -20 /tmp/server.log; exit 1; }
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/sessions")"
[[ "$code" == 401 ]] || { echo "FAIL: anonymous /api/sessions returned $code, want 401"; exit 1; }
# First-run claim guard: the owner account needs the one-time setup code.
signup() { curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
             -d "$1" "http://127.0.0.1:$PORT/api/auth/signup"; }
code="$(signup '{"username":"eve","password":"pw-123456"}')"
[[ "$code" == 403 ]] || { echo "FAIL: signup without setup code returned $code, want 403"; exit 1; }
setup="$(cat "$HOME/.agents/setup-code")"
code="$(signup "{\"username\":\"owner\",\"password\":\"pw-123456\",\"setupCode\":\"$setup\"}")"
[[ "$code" == 200 ]] || { echo "FAIL: signup with setup code returned $code, want 200"; exit 1; }
[[ ! -e "$HOME/.agents/setup-code" ]] || { echo "FAIL: setup code not burned after use"; exit 1; }
echo "PASS: fresh install boots, healthy, API gated, owner claim needs setup code"
