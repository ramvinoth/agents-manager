#!/usr/bin/env bash
# Fast JS iteration loop — seconds instead of a ~10-minute native rebuild.
#
# WHY: almost every change we make is JavaScript (screens, styles, parsing).
# A Release `xcodebuild` recompiles ~72 native targets to deliver a new JS
# bundle, which is absurd for a style tweak. A Debug build talks to Metro, so a
# JS edit is picked up on reload in ~1-2s with no Xcode involvement at all.
#
# Use a native build ONLY when native inputs change:
#   - a new native dependency (expo-*, react-native-*)
#   - app.json ios.* (bundle id, deployment target, plugins)
#   - anything requiring `expo prebuild`
#
# Usage:
#   ./scripts/dev-loop.sh install   # one-time (or after native changes): Debug build + install
#   ./scripts/dev-loop.sh serve     # start Metro (leave running)
#   ./scripts/dev-loop.sh reload    # push latest JS to the running app
#   ./scripts/dev-loop.sh shot out.png   # screenshot the simulator
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/.." && pwd)"
IOS_DIR="$APP_DIR/ios"
: "${SIM_NAME:=agents-e2e}"
: "${BUNDLE_ID:=com.suhai.agents}"
log() { printf '\033[36m==> %s\033[0m\n' "$*"; }

udid() {
  xcrun simctl list devices available | grep -F "$SIM_NAME (" | head -1 | grep -oE '[0-9A-Fa-f-]{36}'
}

case "${1:-}" in
  install)
    U="$(udid)"; [ -n "$U" ] || { echo "no simulator named $SIM_NAME" >&2; exit 1; }
    xcrun simctl boot "$U" 2>/dev/null || true
    log "Debug build (no whole-module optimisation, much faster than Release)"
    xcodebuild -workspace "$IOS_DIR/Agents.xcworkspace" -scheme Agents \
      -configuration Debug -destination "id=$U" -derivedDataPath "$IOS_DIR/build-debug" \
      -quiet CODE_SIGNING_ALLOWED=NO ONLY_ACTIVE_ARCH=YES build
    APP="$(find "$IOS_DIR/build-debug/Build/Products" -name '*.app' -type d | head -1)"
    xcrun simctl install "$U" "$APP"
    log "installed $APP — now run: $0 serve"
    ;;
  serve)
    cd "$APP_DIR"
    log "Metro on :8081 (leave this running; JS edits reload in ~1-2s)"
    exec npx expo start --dev-client --port 8081
    ;;
  reload)
    # Metro's dev-server reload endpoint; the app picks up the new bundle.
    curl -sf -X POST http://127.0.0.1:8081/reload >/dev/null 2>&1 \
      && log "reload sent" || log "reload endpoint unavailable — is Metro running?"
    U="$(udid)"
    xcrun simctl launch "$U" "$BUNDLE_ID" >/dev/null 2>&1 || true
    ;;
  shot)
    U="$(udid)"
    xcrun simctl io "$U" screenshot "${2:-shot.png}"
    log "wrote ${2:-shot.png}"
    ;;
  *)
    sed -n '2,25p' "$0"
    exit 1
    ;;
esac
