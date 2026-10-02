// git.ts — shared git helpers for the UI.

// The canned instruction the "Sync" button sends to the model. Deliberately
// spelled out step-by-step: commit → push → rebase onto the default branch,
// with careful conflict resolution and a lease-guarded push after rewriting.
// Shared by the transcript git bar (GitSection) and the LHS Settings git
// section so the two entry points stay identical.
const SYNC_STEPS = `1. Run \`git status\`. Commit any uncommitted changes with a clear message (leave obviously unrelated junk files alone).
2. \`git fetch origin\` and determine the default branch (master or main).
3. Push the current branch to origin (use \`-u\` to set the upstream if it has none).
4. If the current branch is NOT the default branch, rebase it onto the latest \`origin/<default>\`, resolving any conflicts carefully — read both sides of each conflict and preserve the intent of both changes; never blindly take one side. If the project has a fast build/test command, run it after resolving to sanity-check.
5. If the rebase rewrote history, push again with \`--force-with-lease\`.
6. Finish with a short summary: commits made, push result, rebase outcome, and any conflicts you resolved.`

/**
 * The Sync instruction, aimed at a specific repo.
 *
 * `repoPath` matters when the repo was DISCOVERED below the session cwd: the
 * model's working directory is the workspace root, so a bare "in this repo"
 * would have it run git where there is no repo at all — the commands would
 * fail, or worse, act on some other repo it wandered into. Naming the absolute
 * path removes the guess. When the cwd is itself the repo, the old wording is
 * already unambiguous and is kept verbatim.
 */
export function syncPrompt(repoPath?: string): string {
  const where = repoPath
    ? `Sync the git branch in \`${repoPath}\` with the remote. \`cd\` there first — it is not your current working directory. Then, step by step:`
    : "Sync the current git branch with the remote. In this repo, step by step:"
  return `${where}\n${SYNC_STEPS}`
}

/** Back-compat for callers with no repo path handy: the original wording. */
export const SYNC_PROMPT = syncPrompt()
