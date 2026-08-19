// git.ts — shared git helpers for the UI.

// The canned instruction the "Sync" button sends to the model. Deliberately
// spelled out step-by-step: commit → push → rebase onto the default branch,
// with careful conflict resolution and a lease-guarded push after rewriting.
// Shared by the transcript git bar (GitSection) and the LHS Settings git
// section so the two entry points stay identical.
export const SYNC_PROMPT = `Sync the current git branch with the remote. In this repo, step by step:
1. Run \`git status\`. Commit any uncommitted changes with a clear message (leave obviously unrelated junk files alone).
2. \`git fetch origin\` and determine the default branch (master or main).
3. Push the current branch to origin (use \`-u\` to set the upstream if it has none).
4. If the current branch is NOT the default branch, rebase it onto the latest \`origin/<default>\`, resolving any conflicts carefully — read both sides of each conflict and preserve the intent of both changes; never blindly take one side. If the project has a fast build/test command, run it after resolving to sanity-check.
5. If the rebase rewrote history, push again with \`--force-with-lease\`.
6. Finish with a short summary: commits made, push result, rebase outcome, and any conflicts you resolved.`
