#!/usr/bin/env bash
#
# deploy/macos/build-app.sh — build Harman.app, the launcher the launchd agent
# runs the viewer under (see launcher.c for why), and print its executable path.
#
#   HARMAN_APP_DIR             where to put it          (default ~/Applications)
#   HARMAN_CODESIGN_IDENTITY   signing identity  (default: this Mac's first
#                              "Apple Development" identity, else "-", ad-hoc)
#
# macOS keys a privacy grant to the app's code signature. An ad-hoc signature
# changes with every build, so a rebuild loses the grant; a real identity keeps
# it. The build is therefore skipped when the installed app is already current.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
app="${HARMAN_APP_DIR:-$HOME/Applications}/Harman.app"
identity="${HARMAN_CODESIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null \
  | sed -n 's/^ *[0-9]*) [0-9A-F]* "\(Apple Development: .*\)"$/\1/p' | head -1)}"
identity="${identity:--}"
exe="$app/Contents/MacOS/Harman"
stamp="$app/Contents/Resources/source.sha"

want="$( (cat "$here/launcher.c" "$here/Info.plist" "$repo/mobile-app/assets/icon.png" 2>/dev/null
         echo "$identity") | shasum -a 256 | cut -d' ' -f1)"
if [[ -x "$exe" && "$(cat "$stamp" 2>/dev/null)" == "$want" ]] && codesign -v "$app" 2>/dev/null; then
  echo "$exe"; exit 0
fi

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/Harman.app/Contents/MacOS" "$work/Harman.app/Contents/Resources" "$work/Harman.iconset"
cp "$here/Info.plist" "$work/Harman.app/Contents/Info.plist"
clang -O2 -Wall -framework ApplicationServices -o "$work/Harman.app/Contents/MacOS/Harman" "$here/launcher.c"
icon="$repo/mobile-app/assets/icon.png"
if [[ -f "$icon" ]]; then   # a bundle without the mobile app still builds, iconless
  for size in 16 32 128 256 512; do
    sips -z $size $size "$icon" --out "$work/Harman.iconset/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$icon" --out "$work/Harman.iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$work/Harman.iconset" -o "$work/Harman.app/Contents/Resources/Harman.icns"
fi
echo "$want" > "$work/Harman.app/Contents/Resources/source.sha"
codesign --force --sign "$identity" --timestamp=none "$work/Harman.app" >&2

mkdir -p "$(dirname "$app")"
rm -rf "$app"
mv "$work/Harman.app" "$app"
echo "$exe"
