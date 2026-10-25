#!/usr/bin/env bash
# Publish the public site (suhai.ai) as a Workers static-assets project "harman-site".
# Privacy, terms and the icon come from web/public so the app and the site share one copy.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$here/dist" && mkdir "$here/dist"
cp -R "$here/public/." "$here/dist/"
cp "$here/../web/public/privacy.html" "$here/../web/public/terms.html" "$here/../web/public/favicon.svg" "$here/dist/"
cd "$here"
"$here/../release-feed/node_modules/.bin/wrangler" deploy
