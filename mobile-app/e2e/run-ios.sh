#!/usr/bin/env bash
#
# Reproducible iOS end-to-end run: build the app for a simulator, start Appium,
# run the WebdriverIO suite. Encodes the environment gotchas we hit (see
# README.md "iOS environment notes"). macOS + Xcode required.
#
# Usage (from mobile-app/e2e/):
#   nvm use 20                       # Node >= 18 is required
#   export E2E_SERVER_URL=https://agents.suhai.ai
#   export E2E_USERNAME=... E2E_PASSWORD=...
#   ./run-ios.sh
#
# Optional env:
#   SIM_NAME      stable simulator instance NAME to reuse across runs (default "agents-e2e")
#   SIM_DEVTYPE   device type to create the instance from (default "iPhone 17")
#   IOS_VERSION   runtime version, e.g. 26.5 (default: latest installed)
#   APPIUM_PORT   default 4723
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/.." && pwd)"     # mobile-app/
IOS_DIR="$APP_DIR/ios"
# A stable, UNIQUE instance name (not a device-type name like "iPhone 17") so the
# lookup below reliably finds and REUSES it — otherwise every run created a new sim.
: "${SIM_NAME:=agents-e2e}"
: "${SIM_DEVTYPE:=iPhone 17}"
: "${APPIUM_PORT:=4723}"
: "${E2E_SERVER_URL:=http://localhost:8091}"
export E2E_SERVER_URL
APPIUM="$HERE/node_modules/.bin/appium"

log() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }

# 1) Node >= 18 (Appium 2 and modern RN reject Node 17). nvm users: `nvm use 20`.
#    Keep the nvm Node FIRST on PATH — a system /usr/local/bin/node 17 will break Appium.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  echo "ERROR: Node >= 18 required (found $(node -v 2>/dev/null || echo none))." >&2
  echo "       With nvm:  nvm install 20 && nvm use 20" >&2
  exit 1
fi

# 2) Dependencies (app + e2e) and the XCUITest driver.
[ -d "$APP_DIR/node_modules" ] || (log "npm install (app)"; cd "$APP_DIR" && npm install)
[ -d "$HERE/node_modules" ]    || (log "npm install (e2e)"; cd "$HERE" && npm install)
# Appium prints the driver list to stderr, so merge it (2>&1) before matching.
# Install is best-effort — it errors (nonzero) if already present.
if ! "$APPIUM" driver list --installed 2>&1 | grep -q xcuitest; then
  log "install xcuitest driver"
  "$APPIUM" driver install xcuitest || true
fi

# 3) Generate the native iOS project if it isn't there yet.
if [ ! -d "$IOS_DIR" ]; then
  log "expo prebuild (ios)"
  (cd "$APP_DIR" && npx expo prebuild -p ios)
fi

# 4) Pick the latest installed iOS runtime; create/boot the target simulator.
#    If this errors with "iOS <v> is not installed / no destinations", run:
#        xcodebuild -downloadPlatform iOS
RT_LINE="$(xcrun simctl list runtimes ios | grep -E 'iOS [0-9]' | tail -1 || true)"
[ -n "$RT_LINE" ] || { echo "ERROR: no iOS simulator runtime installed. Run: xcodebuild -downloadPlatform iOS" >&2; exit 1; }
: "${IOS_VERSION:=$(echo "$RT_LINE" | sed -E 's/^[[:space:]]*iOS ([0-9.]+).*/\1/')}"
RT_ID="$(echo "$RT_LINE" | awk '{print $NF}')"
# NOTE: `simctl list devices "$RT_ID"` (a runtime IDENTIFIER) prints only section
# headers and no device lines, so it never matched — hence a new sim every run.
# `list devices available` lists real device lines; match our unique instance name.
UDID="$(xcrun simctl list devices available | grep -F "$SIM_NAME (" | head -1 | grep -oE '[0-9A-Fa-f-]{36}' || true)"
if [ -z "$UDID" ]; then
  log "create simulator '$SIM_NAME' ($SIM_DEVTYPE) on iOS $IOS_VERSION"
  UDID="$(xcrun simctl create "$SIM_NAME" "$SIM_DEVTYPE" "$RT_ID")"
fi
log "simulator $SIM_NAME ($UDID) iOS $IOS_VERSION"
xcrun simctl boot "$UDID" 2>/dev/null || true

# 5) Point the RN "Bundle React Native code and images" build phase at THIS node
#    (else it can pick up a system Node 17 and fail).
echo "export NODE_BINARY=$(command -v node)" > "$IOS_DIR/.xcode.env.local"

# 6) Build a Release .app for the simulator (JS bundled → no Metro needed).
WS="$(ls -d "$IOS_DIR"/*.xcworkspace | head -1)"
SCHEME="$(basename "${WS%.xcworkspace}")"
log "xcodebuild $SCHEME (Release, iphonesimulator)"
xcodebuild -workspace "$WS" -scheme "$SCHEME" -configuration Release \
  -destination "id=$UDID" -derivedDataPath "$IOS_DIR/build" \
  CODE_SIGNING_ALLOWED=NO build
APP="$(find "$IOS_DIR/build/Build/Products" -name '*.app' -type d | head -1)"
[ -n "$APP" ] || { echo "ERROR: no .app produced" >&2; exit 1; }
log "built $APP"

# 7) WDIO force-registers ts-node's ESM loader, which crashes on Node >= 20
#    ("did not call the next hook in its chain"). Our config/specs are plain JS,
#    so neutralize ts-node. (npm install restores it; this re-disables it.)
if [ -d "$HERE/node_modules/ts-node" ]; then
  mv "$HERE/node_modules/ts-node" "$HERE/node_modules/.ts-node-disabled"
  log "disabled ts-node (WDIO ESM-loader crash workaround)"
fi

# 8) Start Appium out-of-band (more reliable than @wdio/appium-service for a
#    local install), wait for it, run the suite, always clean up.
log "start appium :$APPIUM_PORT"
"$APPIUM" --address 127.0.0.1 --port "$APPIUM_PORT" --base-path / >"$HERE/appium.log" 2>&1 &
APPID=$!
cleanup() { kill "$APPID" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$APPIUM_PORT/status" >/dev/null 2>&1 && break
  sleep 1
done

export APP_PATH="$APP" E2E_UDID="$UDID" E2E_DEVICE="$SIM_NAME" E2E_IOS_VERSION="$IOS_VERSION"
log "wdio run (server=$E2E_SERVER_URL)"
cd "$HERE"
npm run ios
