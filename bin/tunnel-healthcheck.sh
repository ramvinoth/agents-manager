#!/bin/bash
# Watchdog for the work.suhai.ai tunnel.
#
# launchd's KeepAlive only sees whether the cloudflared process is alive. Twice
# now the process stayed up while its edge connectors silently went away, so the
# public hostname 404'd/1033'd with nothing to restart. This probes the public
# URL instead and kickstarts the tunnel agent when it stops answering.
#
# The origin is checked first: if localhost is down the tunnel is not the
# problem and restarting it would only mask the real fault.

PUBLIC_URL="${PUBLIC_URL:-https://work.suhai.ai/}"
ORIGIN_URL="${ORIGIN_URL:-http://localhost:8091/}"
AGENT="${AGENT:-gui/$(id -u)/ai.suhai.agents-tunnel}"
STATE="${STATE:-/tmp/tunnel-healthcheck.state}"
LOG="${LOG:-/tmp/tunnel-healthcheck.log}"
THRESHOLD="${THRESHOLD:-3}"   # consecutive failures before restarting

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG"; }

probe() { curl -fs -o /dev/null --max-time 10 "$1"; }

if probe "$PUBLIC_URL"; then
  # Recovered after a streak? Say so, then reset.
  if [ "$(cat "$STATE" 2>/dev/null || echo 0)" -gt 0 ]; then
    log "OK    $PUBLIC_URL responding again"
  fi
  echo 0 >"$STATE"
  exit 0
fi

if ! probe "$ORIGIN_URL"; then
  log "SKIP  origin $ORIGIN_URL is also down; not a tunnel fault"
  echo 0 >"$STATE"
  exit 0
fi

fails=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$fails" >"$STATE"
log "FAIL  $PUBLIC_URL unreachable while origin is up ($fails/$THRESHOLD)"

if [ "$fails" -ge "$THRESHOLD" ]; then
  log "RESTART kickstarting $AGENT"
  launchctl kickstart -k "$AGENT" >>"$LOG" 2>&1 \
    && log "RESTART issued" \
    || log "RESTART failed (exit $?)"
  echo 0 >"$STATE"
fi
