#!/usr/bin/env bash
#
# deploy/push.sh — cut a release on THIS Mac and deploy it to a Manager box.
#
# This is the Mac/developer side of the "update like a package" flow. It is the
# counterpart to the box-side `agents` CLI (deploy/agents): this script never
# runs on the box, and `agents` never runs here — so push is deliberately NOT a
# `agents` subcommand (that would be dead code on the customer box).
#
# Flow:
#   bump VERSION → commit → tag vX.Y.Z → git bundle → scp over Tailscale →
#   ssh: `setsid agents update …` (detached, survives an SSH drop) →
#   poll /healthz until it reports the new version (or time out and show the log).
#
# Why a git bundle, not rsync: the bundle is one self-contained file that needs
# NO GitHub credentials or network on the box, and `VERSION` and
# `git rev-parse HEAD` are self-verifying — git re-hashes every
# object on unbundle, and the box checks out the exact --expect-sha. web/dist and
# node_modules are gitignored, so the bundle is small and the box builds its own
# (correct-arch) artifacts.
#
# The bundle carries a SNAPSHOT, not history: one parentless commit holding the
# release tree. Old commits (with whatever they once contained) never leave this
# Mac; this repo keeps its full history and the vX.Y.Z tag. The box clones each
# release into its own dir, so it never needs the previous release's commits.
#
# Config (env or flags):
#   AGENTS_HOST          ssh target for the box, e.g. user@100.x or an ssh alias   (required)
#   AGENTS_HEALTH_URL    URL the Mac polls after deploy
#                        (default http://<host-of-AGENTS_HOST>:8091/healthz;
#                         override when the box answers on its in-WSL Tailscale IP)
#   AGENTS_PORT          port in the default health URL                            (default 8091)
#   AGENTS_REMOTE_TMP    dir on the box to drop the bundle in                      (default /tmp)
#   AGENTS_DEPLOY_TIMEOUT  seconds to wait for the version to flip                 (default 600)
#
# Usage:
#   deploy/push.sh 1.0.1              # release exactly 1.0.1
#   deploy/push.sh                    # auto-bump the patch of the current VERSION
#   deploy/push.sh --dry-run 1.0.1    # print the plan; make NO git changes, touch no box
#   deploy/push.sh --publish [1.0.1]  # ALSO publish to the private feed (releases.suhai.ai)
#                                     # so every customer box auto-updates; with no
#                                     # AGENTS_HOST it ONLY publishes (deploy/release-feed.sh)
#
set -euo pipefail

HM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$HM_DIR/.." && pwd)"
cd "$REPO_DIR"

AGENTS_PORT="${AGENTS_PORT:-8091}"
AGENTS_REMOTE_TMP="${AGENTS_REMOTE_TMP:-/tmp}"
AGENTS_DEPLOY_TIMEOUT="${AGENTS_DEPLOY_TIMEOUT:-600}"
REMOTE_AGENTS="/usr/local/bin/agents"   # absolute: non-login ssh has a minimal PATH

DRY_RUN="" PUBLISH=""
log()  { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
die()  { echo "push: $*" >&2; exit 1; }

# ── args ──────────────────────────────────────────────────────────────────────
NEW_VER=""
while (( $# )); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --publish) PUBLISH=1; shift ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        die "unknown flag '$1'" ;;
    *)         [[ -z "$NEW_VER" ]] || die "unexpected extra argument '$1'"; NEW_VER="${1#v}"; shift ;;
  esac
done

# ── 1. decide the version ───────────────────────────────────────────────────────
[[ -f VERSION ]] || die "no VERSION file in $REPO_DIR"
CUR_VER="$(tr -d '[:space:]' < VERSION)"
if [[ -z "$NEW_VER" ]]; then
  # auto-bump the patch component (X.Y.Z → X.Y.(Z+1))
  IFS=. read -r MA MI PA <<<"$CUR_VER"
  [[ "$MA" =~ ^[0-9]+$ && "$MI" =~ ^[0-9]+$ && "$PA" =~ ^[0-9]+$ ]] \
    || die "current VERSION '$CUR_VER' isn't X.Y.Z — pass the new version explicitly"
  NEW_VER="$MA.$MI.$((PA+1))"
fi
[[ "$NEW_VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version '$NEW_VER' is not X.Y.Z"
[[ "$NEW_VER" == "$CUR_VER" ]] && die "version $NEW_VER equals the current VERSION — nothing to release"
TAG="v$NEW_VER"

# ── 2. safety gates (fail BEFORE mutating anything) ─────────────────────────────
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repo"
AGENTS_HOST="${AGENTS_HOST:-}"
[[ -n "$AGENTS_HOST" || -n "$PUBLISH" || -n "$DRY_RUN" ]] \
  || die "set AGENTS_HOST=user@box (ssh target), pass --publish, or use --dry-run"
git rev-parse "$TAG" >/dev/null 2>&1 && die "tag $TAG already exists — pick a new version or delete the tag"
# Clean tree: the release commit must contain exactly what was tested, nothing
# stray. The ONLY change this script introduces is the VERSION bump itself.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "push: working tree is not clean — commit or stash first so the release is exactly what you tested:" >&2
  git status --short >&2
  exit 1
fi
BRANCH="$(git branch --show-current)"
[[ -n "$BRANCH" ]] || die "detached HEAD — check out a branch before releasing"

# Health URL: default derives the host from the ssh target (strip user@), but the
# box may answer on a different (in-WSL Tailscale) IP, so it's overridable.
HEALTH_URL="${AGENTS_HEALTH_URL:-http://${AGENTS_HOST##*@}:$AGENTS_PORT/healthz}"

log "Release plan:"
echo "    version:   $CUR_VER → $NEW_VER   (tag $TAG on branch $BRANCH)"
echo "    box:       ${AGENTS_HOST:-<none>}"
echo "    feed:      $([[ -n "$PUBLISH" ]] && echo "publish to the private release feed" || echo no)"
[[ -n "$AGENTS_HOST" ]] && echo "    health:    $HEALTH_URL"

if [[ -n "$DRY_RUN" ]]; then
  SHA_PREVIEW="$(git rev-parse HEAD)"
  BUNDLE_PREVIEW="$AGENTS_REMOTE_TMP/agents-$NEW_VER.bundle"
  log "DRY RUN — no git changes, box untouched. Would run:"
  echo "    git commit VERSION  (release $TAG)   # new HEAD, then:"
  echo "    git tag $TAG"
  echo "    git commit-tree $TAG^{tree}   # parentless snapshot, then:"
  echo "    git bundle create <tmp> main $TAG   # snapshot only, no history"
  [[ -n "$PUBLISH" ]] && echo "    deploy/release-feed.sh publish $NEW_VER <new-sha> <tmp>"
  if [[ -n "$AGENTS_HOST" ]]; then
    echo "    scp <tmp> $AGENTS_HOST:$BUNDLE_PREVIEW"
    echo "    ssh $AGENTS_HOST 'setsid $REMOTE_AGENTS update $NEW_VER --from $BUNDLE_PREVIEW --expect-sha <new-sha> </dev/null >…log 2>&1'"
    echo "    poll $HEALTH_URL until \"version\":\"$NEW_VER\"  (≤ ${AGENTS_DEPLOY_TIMEOUT}s)"
  fi
  echo "    (expect-sha would be the NEW snapshot commit, not current $SHA_PREVIEW)"
  exit 0
fi

# ── 3. cut the release commit + tag ─────────────────────────────────────────────
log "Writing VERSION and committing ${TAG}…"
printf '%s\n' "$NEW_VER" > VERSION
git add VERSION
git commit -q -m "release $TAG"
git tag "$TAG"
log "Release commit $(git rev-parse HEAD) tagged $TAG"

# ── 4. build the bundle (source only; box rebuilds web/dist + node_modules) ─────
# Snapshot: a parentless commit of the tagged tree, bundled from a throwaway repo
# that borrows this repo's objects (alternates), so no ref is added here and the
# bundle holds only the snapshot's objects.
SHA="$(git commit-tree "$TAG^{tree}" -m "Manager $NEW_VER")"
SHIP_DIR="$(mktemp -d -t agents-ship-XXXXXX)"
BUNDLE_LOCAL="$(mktemp -t agents-XXXXXX).bundle"
REMOTE_BUNDLE="$AGENTS_REMOTE_TMP/agents-$NEW_VER.bundle"
REMOTE_LOG="$AGENTS_REMOTE_TMP/agents-update-$NEW_VER.log"
cleanup() {
  rm -rf "$BUNDLE_LOCAL" "$SHIP_DIR"
  [[ -n "${DEPLOY_STARTED:-}" ]] && ssh "$AGENTS_HOST" "rm -f '$REMOTE_BUNDLE'" 2>/dev/null || true
}
trap cleanup EXIT
log "Building snapshot bundle ($SHA)…"
git init -q "$SHIP_DIR"
git rev-parse --path-format=absolute --git-common-dir | sed 's|$|/objects|' > "$SHIP_DIR/.git/objects/info/alternates"
git -C "$SHIP_DIR" update-ref refs/heads/main "$SHA"
git -C "$SHIP_DIR" symbolic-ref HEAD refs/heads/main
git -C "$SHIP_DIR" tag "$TAG" "$SHA"
git -C "$SHIP_DIR" bundle create "$BUNDLE_LOCAL" main "$TAG" >/dev/null 2>&1

if [[ -n "$PUBLISH" ]]; then
  log "Publishing $TAG to the private release feed…"
  "$HM_DIR/release-feed.sh" publish "$NEW_VER" "$SHA" "$BUNDLE_LOCAL"
  [[ -n "$AGENTS_HOST" ]] || { log "✓ Published. Customer boxes pick it up within ~1h."; exit 0; }
fi

# ── 5. ship it + kick off a detached update on the box ──────────────────────────
log "Copying bundle to $AGENTS_HOST:${REMOTE_BUNDLE}…"
scp -q "$BUNDLE_LOCAL" "$AGENTS_HOST:$REMOTE_BUNDLE"
DEPLOY_STARTED=1
log "Starting detached update on the box (survives an SSH drop)…"
ssh "$AGENTS_HOST" \
  "setsid $REMOTE_AGENTS update $NEW_VER --from '$REMOTE_BUNDLE' --expect-sha $SHA </dev/null >'$REMOTE_LOG' 2>&1" \
  || true   # setsid detaches; a dropped ssh here must not fail the push

# ── 6. poll /healthz until the box reports the new version ──────────────────────
log "Waiting for $HEALTH_URL to report $NEW_VER (≤ ${AGENTS_DEPLOY_TIMEOUT}s)…"
served=""
for (( i=0; i<AGENTS_DEPLOY_TIMEOUT; i++ )); do
  served="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null \
            | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [[ "$served" == "$NEW_VER" ]]; then
    log "✓ $AGENTS_HOST is now serving $NEW_VER."
    exit 0
  fi
  sleep 1
done

# ── 7. timed out → the update failed or auto-rolled-back; surface the box log ────
echo "push: timed out after ${AGENTS_DEPLOY_TIMEOUT}s — box still reports '${served:-<no response>}', not $NEW_VER." >&2
echo "push: the box auto-rolls-back a failed update, so it is likely still on the previous release." >&2
echo "push: ---- remote update log ($REMOTE_LOG) ----" >&2
ssh "$AGENTS_HOST" "cat '$REMOTE_LOG' 2>/dev/null || echo '(no log found)'" >&2 || true
echo "push: NOTE the tag $TAG and release commit are committed LOCALLY; re-run after fixing, or 'git tag -d $TAG' to redo." >&2
exit 1
