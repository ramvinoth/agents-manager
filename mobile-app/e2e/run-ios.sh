#!/usr/bin/env bash
# Build current source and exercise the native app against an isolated fixture.
# Node/Appium requirements are pinned in package.json. No global driver installs.
# Override E2E_UDID to use another existing simulator. This never creates a device.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/.." && pwd)"
export APPIUM_HOME="$HERE/.appium"
export APPIUM_PORT="${APPIUM_PORT:-4725}"
export E2E_BUNDLE_ID="com.suhai.agents.e2e"
export E2E_UDID="${E2E_UDID:-$(xcrun simctl list devices available --json | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const d=Object.values(JSON.parse(s).devices).flat().find(d=>d.name==="agents-e2e");if(!d)process.exit(1);console.log(d.udid)})')}"
export E2E_DEVICE="${E2E_DEVICE:-agents-e2e}"
export E2E_IOS_VERSION="${E2E_IOS_VERSION:-$(xcrun simctl list devices available --json | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const r=Object.entries(JSON.parse(s).devices).find(([,ds])=>ds.some(d=>d.udid===process.env.E2E_UDID));if(!r)process.exit(1);console.log(r[0].split("iOS-")[1].replaceAll("-","."))})')}"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(!((a===20&&b>=19)||(a===22&&b>=12)||a>=24))throw Error("Appium 3 requires Node ^20.19, ^22.12 or >=24")'
[ -d "$APP_DIR/ios/Agents.xcworkspace" ] || { printf 'Missing native project; generate it separately.\n' >&2; exit 1; }
[ -x "$HERE/node_modules/.bin/appium" ] || { printf 'Run npm ci in e2e first.\n' >&2; exit 1; }
mkdir -p "$HERE/.artifacts"
cd "$HERE"
# Direct local dependencies are discovered by Appium; APPIUM_HOME prevents shared state.
./node_modules/.bin/appium driver list --installed
xcrun simctl boot "$E2E_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$E2E_UDID" -b
# Distinct bundle id means production server credentials/keychain state are not read.
# Explicit app path is for rerunning this same locally built snapshot, not old releases.
if [ -z "${APP_PATH:-}" ]; then
  xcodebuild -workspace "$APP_DIR/ios/Agents.xcworkspace" -scheme Agents \
    -configuration Release -destination "id=$E2E_UDID" \
    -derivedDataPath "$HERE/.artifacts/build" \
    NODE_BINARY="$(command -v node)" PRODUCT_BUNDLE_IDENTIFIER="$E2E_BUNDLE_ID" \
    CODE_SIGNING_ALLOWED=NO build >"$HERE/.artifacts/build.log" 2>&1
  export APP_PATH="$HERE/.artifacts/build/Build/Products/Release-iphonesimulator/Agents.app"
fi
[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$APP_PATH/Info.plist")" = "$E2E_BUNDLE_ID" ] || { printf 'Refusing non-isolated app bundle\n' >&2; exit 1; }
if curl -sf "http://127.0.0.1:$APPIUM_PORT/status" >/dev/null; then
  printf 'Appium port already occupied; choose APPIUM_PORT\n' >&2; exit 1
fi
./node_modules/.bin/appium --address 127.0.0.1 --port "$APPIUM_PORT" --base-path / >"$HERE/.artifacts/appium.log" 2>&1 &
APPID=$!
cleanup() { kill "$APPID" 2>/dev/null || true; wait "$APPID" 2>/dev/null || true; }
trap cleanup EXIT
ready=0
for ((i=0;i<40;i++)); do
  kill -0 "$APPID" 2>/dev/null || { printf 'Appium exited; inspect .artifacts/appium.log\n' >&2; exit 1; }
  if curl -sf "http://127.0.0.1:$APPIUM_PORT/status" >/dev/null; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { printf 'Appium startup timed out\n' >&2; exit 1; }
# Explicit specs share this runner/build. Default preserves the board gate.
# Example: bash run-ios.sh ./specs/audit.e2e.js ./specs/thread-board.e2e.js
spec_args=()
if [ "$#" -eq 0 ]; then set -- ./specs/thread-board.e2e.js; fi
for spec in "$@"; do spec_args+=(--spec "$spec"); done
npm run ios -- "${spec_args[@]}"
