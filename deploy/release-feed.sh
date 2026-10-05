#!/usr/bin/env bash
#
# deploy/release-feed.sh — the Mac side of the private update feed (Card 121).
#
# Customer boxes poll https://releases.suhai.ai (release-feed/ Worker + R2) and
# install what this script publishes. Code stays private: every download needs a
# per-customer token, and every box verifies the release key's signature.
#
#   release-feed.sh publish <ver> <sha> <bundle>   upload bundle, then the signed latest.json
#   release-feed.sh token-add <label>              mint a customer token (printed ONCE)
#   release-feed.sh token-revoke <sha256-of-token> cut one customer off
#
# Signing key: $HARMAN_RELEASE_KEY (default ~/.harman/release-signing.key, mode
# 600, never committed). Its public half is deploy/release-pubkey.txt, which
# ships inside every release, so boxes need no key configuration.
# Needs wrangler auth (`npx wrangler login` once, in release-feed/).
set -euo pipefail

HM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FEED_DIR="$HM_DIR/../release-feed"
BUCKET="harman-releases"
KEY="${HARMAN_RELEASE_KEY:-$HOME/.harman/release-signing.key}"
PY=/usr/bin/python3   # has pynacl; the same interpreter launchd runs

die() { echo "release-feed: $*" >&2; exit 1; }
r2_put() {  # <key> <file> <content-type>
  ( cd "$FEED_DIR" && npx --no-install wrangler r2 object put "$BUCKET/$1" \
      --file "$2" --content-type "$3" --remote >/dev/null )
}

cmd="${1:-}"; shift || true
case "$cmd" in
  publish)
    (( $# == 3 )) || die "usage: publish <ver> <sha> <bundle>"
    ver="$1" sha="$2" bundle="$3"
    [[ -f "$KEY" ]] || die "no signing key at $KEY (create: $PY $HM_DIR/release_manifest.py keygen $KEY)"
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
    "$PY" "$HM_DIR/release_manifest.py" sign "$KEY" "$ver" "$sha" "$bundle" > "$tmp"
    # Self-check against the COMMITTED public key before anything leaves the Mac:
    # a key/pubkey mismatch would publish a release every box rejects.
    "$PY" "$HM_DIR/release_manifest.py" verify "$(cat "$HM_DIR/release-pubkey.txt")" < "$tmp" >/dev/null \
      || die "signature does not verify against deploy/release-pubkey.txt — wrong key?"
    # Bundle first, manifest last: a box never sees a manifest whose bundle isn't there yet.
    r2_put "bundles/$ver.bundle" "$bundle" application/octet-stream
    r2_put latest.json "$tmp" application/json
    echo "published $ver ($sha) to the release feed"
    ;;
  token-add)
    (( $# == 1 )) || die "usage: token-add <label, e.g. law-office>"
    token="$(openssl rand -hex 32)"
    hash="$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)"
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
    printf '%s\n' "$1" > "$tmp"
    r2_put "tokens/$hash" "$tmp" text/plain
    echo "token for '$1' (shown once — put it in the box's /opt/harman/update.env as HARMAN_FEED_TOKEN):"
    echo "  $token"
    echo "revoke later with: $0 token-revoke $hash"
    ;;
  token-revoke)
    (( $# == 1 )) || die "usage: token-revoke <sha256>"
    ( cd "$FEED_DIR" && npx --no-install wrangler r2 object delete "$BUCKET/tokens/$1" --remote )
    ;;
  *) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 64 ;;
esac
