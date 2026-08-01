#!/usr/bin/env bash
# Build a signed iOS release and upload it to TestFlight.
#
# Prerequisites (one-time, done by a human in Apple's portals):
#   1. A PAID Apple Developer Program membership ($99/yr). A free Apple ID can
#      run the app on your own device via Xcode, but CANNOT use TestFlight.
#   2. The bundle id registered at developer.apple.com → Identifiers, and an app
#      record created in App Store Connect with that same bundle id.
#   3. An App Store Connect API key (Users and Access → Integrations → App Store
#      Connect API → generate, role "App Manager"). Download the .p8 ONCE and
#      note the Key ID and Issuer ID. This is preferred over an Apple ID
#      password: it is scoped, revocable, and never expires silently.
#
# Usage:
#   export ASC_KEY_ID=XXXXXXXXXX
#   export ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#   export ASC_KEY_PATH=~/private_keys/AuthKey_XXXXXXXXXX.p8
#   export TEAM_ID=38C6HVZQSV
#   ./scripts/release-ios.sh
#
# Optional env:
#   BUNDLE_ID     override the bundle id (default: read from app.json)
#   BUILD_NUMBER  CFBundleVersion; default: unix timestamp (must increase)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/.." && pwd)"
IOS_DIR="$APP_DIR/ios"
OUT="$APP_DIR/build"
log() { printf '\033[36m==> %s\033[0m\n' "$*"; }

: "${TEAM_ID:?set TEAM_ID (Apple Developer team id, e.g. 38C6HVZQSV)}"
: "${ASC_KEY_ID:?set ASC_KEY_ID (App Store Connect API key id)}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID (App Store Connect issuer id)}"
: "${ASC_KEY_PATH:?set ASC_KEY_PATH (path to AuthKey_*.p8)}"
[ -f "$ASC_KEY_PATH" ] || { echo "ERROR: no key at $ASC_KEY_PATH" >&2; exit 1; }

BUNDLE_ID="${BUNDLE_ID:-$(node -p "require('$APP_DIR/app.json').expo.ios.bundleIdentifier")}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date +%s)}"
# Forced on the xcodebuild command line so it applies to EVERY target, including
# Pods that pin an older target in their podspec. app.json's expo-build-properties
# setting only reaches the app target and the Podfile platform line, which leaves
# some pods at 13.4 — enough to re-trigger the libswift_Concurrency embed + the
# bitcode_strip crash described below.
: "${DEPLOYMENT_TARGET:=15.1}"
log "bundle $BUNDLE_ID · build $BUILD_NUMBER · team $TEAM_ID"

# 0) Keychain access for codesign.
#    Over SSH / in CI the login keychain is locked and codesign fails with the
#    opaque "errSecInternalComponent" (it can see the identity but can't use the
#    private key). Unlocking plus set-key-partition-list grants codesign
#    non-interactive access. Set KEYCHAIN_PASSWORD to enable; skipped when unset
#    (e.g. running locally in a GUI session, where the keychain is already open).
if [ -n "${KEYCHAIN_PASSWORD:-}" ]; then
  KC="${KEYCHAIN_PATH:-$HOME/Library/Keychains/login.keychain-db}"
  log "unlock keychain for codesign"
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KC"
  security set-key-partition-list -S apple-tool:,apple:,codesign: \
    -s -k "$KEYCHAIN_PASSWORD" "$KC" >/dev/null
fi

# 1) Generate the native project if needed (ios/ is not in source control).
#    NOTE: app.json pins ios.deploymentTarget to 15.1 via expo-build-properties.
#    Below iOS 15, Xcode embeds the Swift concurrency BACK-DEPLOYMENT dylib
#    (libswift_Concurrency.dylib), and CocoaPods' "[CP] Embed Pods Frameworks"
#    phase runs `bitcode_strip` on it — which crashes under Xcode 26 (bitcode was
#    removed from Xcode, so that tool is vestigial), failing the archive with
#    "terminated with uncaught signal 0". At 15.1 the dylib is never embedded.
[ -d "$IOS_DIR" ] || (cd "$APP_DIR" && npx expo prebuild -p ios)

# 2) Archive for real hardware, signed for distribution.
#    The -authentication* flags let xcodebuild talk to App Store Connect with the
#    API key, so it can CREATE the distribution certificate and App Store
#    provisioning profile headlessly. Without them, -allowProvisioningUpdates
#    can't authenticate and silently falls back to "Apple Development" signing,
#    which -exportArchive then rejects for app-store-connect distribution.
log "archive (generic/platform=iOS)"
mkdir -p "$OUT"
AUTH=(-allowProvisioningUpdates
      -authenticationKeyPath "$ASC_KEY_PATH"
      -authenticationKeyID "$ASC_KEY_ID"
      -authenticationKeyIssuerID "$ASC_ISSUER_ID")
xcodebuild archive \
  -workspace "$IOS_DIR/Agents.xcworkspace" -scheme Agents -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$OUT/Agents.xcarchive" \
  "${AUTH[@]}" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  IPHONEOS_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID"

# 3) Export a signed .ipa for App Store distribution.
log "export ipa"
# MANUAL signing on purpose. Automatic ("cloud") signing asks App Store Connect
# to mint a distribution cert on the fly, which requires an ADMIN-role API key —
# ours is App Manager, so it fails with "Cloud signing permission error /
# No profiles for <bundle id> were found". The distribution cert and the
# "$PROFILE_NAME" profile were created up-front via the ASC API instead, so we
# just name them here. See scripts/README or asc-tools/.
: "${PROFILE_NAME:=Agents Manager AppStore}"
: "${SIGNING_CERT:=Apple Distribution}"
cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>uploadSymbols</key><true/>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>$SIGNING_CERT</string>
  <key>provisioningProfiles</key>
  <dict><key>$BUNDLE_ID</key><string>$PROFILE_NAME</string></dict>
</dict>
</plist>
PLIST
xcodebuild -exportArchive \
  -archivePath "$OUT/Agents.xcarchive" \
  -exportPath "$OUT/ipa" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" \
  "${AUTH[@]}"

IPA="$(find "$OUT/ipa" -name '*.ipa' | head -1)"
[ -n "$IPA" ] || { echo "ERROR: no .ipa produced" >&2; exit 1; }

# 4) Validate, then upload to App Store Connect → TestFlight.
log "validate $IPA"
xcrun altool --validate-app -f "$IPA" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

log "upload to TestFlight"
xcrun altool --upload-app -f "$IPA" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

log "uploaded — Apple processes the build for ~5-15 min, then it appears in TestFlight."
echo "Next: App Store Connect → TestFlight → add yourself as an internal tester."
