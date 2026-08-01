#!/usr/bin/env bash
# Run the app as React Native Web so it can be driven in a browser.
#
# WHY: this is by far the fastest UI loop we have.
#   native build + Appium : 10-20 min
#   Metro web rebuild     : ~50 ms
# It also surfaces things the other loops cannot: React warnings, duplicate
# keys, prop errors — all visible in the browser console. The duplicate-key bug
# in the chat list (two sessions sharing an id) was found this way in seconds,
# having survived both unit tests and Appium.
#
# WHAT IT CANNOT TELL YOU — still verify these on a device/simulator:
#   - native modules: notifications, image picker, clipboard, SecureStore
#   - real safe-area insets, keyboard avoidance, and native gesture feel
#   - anything about the actual iOS build
#
# CORS: the API sends Access-Control-Allow-Origin:* on JSON responses, and
# viewer/server.py answers OPTIONS preflights (added for exactly this workflow),
# so the browser can call http://localhost:8091 from the :8081 dev origin.
#
# Usage:
#   ./scripts/web-dev.sh start     # start Metro in web mode (leave running)
#   ./scripts/web-dev.sh stop
#   ./scripts/web-dev.sh status
# Then point a browser (or the Playwright MCP) at http://localhost:8081
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/.." && pwd)"
: "${WEB_PORT:=8081}"
LOG=/tmp/expo-web.log

case "${1:-start}" in
  start)
    if curl -sf -o /dev/null -m3 "http://localhost:$WEB_PORT"; then
      echo "already running on :$WEB_PORT"; exit 0
    fi
    cd "$APP_DIR"
    # setsid so it survives this shell (a plain nohup died with the parent).
    setsid npx expo start --web --port "$WEB_PORT" > "$LOG" 2>&1 < /dev/null &
    for _ in $(seq 1 40); do
      curl -sf -o /dev/null -m2 "http://localhost:$WEB_PORT" && { echo "web dev server up on http://localhost:$WEB_PORT"; exit 0; }
      sleep 2
    done
    echo "failed to start; last log lines:" >&2; tail -20 "$LOG" >&2; exit 1
    ;;
  stop)
    pkill -f "expo start --web" 2>/dev/null || true
    echo stopped
    ;;
  status)
    curl -sf -o /dev/null -m3 "http://localhost:$WEB_PORT" && echo "up on :$WEB_PORT" || echo "down"
    tail -3 "$LOG" 2>/dev/null || true
    ;;
  *)
    sed -n '2,26p' "$0"; exit 1
    ;;
esac
