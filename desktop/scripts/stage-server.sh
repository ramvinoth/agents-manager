#!/usr/bin/env bash
# Stage the committed server tree (HEAD, no working-tree edits) into build/server
# for electron-builder. Same exclusions as deploy/smoke-install.sh: the phone app,
# web/dist and dependencies are built on the target machine by deploy/install.sh.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
out="$here/build/server"
rm -rf "$out" && mkdir -p "$out"
git -C "$repo" archive HEAD -- . ':!mobile-app' ':!desktop' | tar -x -C "$out"
echo "staged $(git -C "$repo" rev-parse --short HEAD) into $out"
