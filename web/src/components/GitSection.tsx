import { useState } from "react"
import { ChevronDown, ChevronRight, GitBranch, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useStore } from "@/store"

// The canned instruction the Sync button sends to the model. Deliberately
// spelled out step-by-step: commit → push → rebase onto the default branch,
// with careful conflict resolution and a lease-guarded push after rewriting.
const SYNC_PROMPT = `Sync the current git branch with the remote. In this repo, step by step:
1. Run \`git status\`. Commit any uncommitted changes with a clear message (leave obviously unrelated junk files alone).
2. \`git fetch origin\` and determine the default branch (master or main).
3. Push the current branch to origin (use \`-u\` to set the upstream if it has none).
4. If the current branch is NOT the default branch, rebase it onto the latest \`origin/<default>\`, resolving any conflicts carefully — read both sides of each conflict and preserve the intent of both changes; never blindly take one side. If the project has a fast build/test command, run it after resolving to sanity-check.
5. If the rebase rewrote history, push again with \`--force-with-lease\`.
6. Finish with a short summary: commits made, push result, rebase outcome, and any conflicts you resolved.`

/** Collapsible git bar above the transcript: repo name · branch · dirty/ahead/
 *  behind counters · a Sync button that hands SYNC_PROMPT to the model. Hidden
 *  entirely when the session's cwd isn't a git repo. */
export function GitSection() {
  const git = useStore((s) => s.git)
  const chatRunning = useStore((s) => s.chatRunning)
  const sendChat = useStore((s) => s.sendChat)
  const loadGitStatus = useStore((s) => s.loadGitStatus)
  const [collapsed, setCollapsed] = useState(localStorage.getItem("gitCollapsed") === "1")
  const [refreshing, setRefreshing] = useState(false)

  if (!git?.repo) return null

  function toggle() {
    const v = !collapsed
    localStorage.setItem("gitCollapsed", v ? "1" : "0")
    setCollapsed(v)
  }

  async function refresh() {
    setRefreshing(true)
    await loadGitStatus()
    setRefreshing(false)
  }

  return (
    // Collapsed: one line, long names ellipsize (title shows the full text).
    // Expanded: flex-wrap + break-all so the full branch name is always visible,
    // wrapping onto extra lines on narrow (mobile) screens.
    <div
      className={
        "flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs" +
        (collapsed ? "" : " flex-wrap")
      }
    >
      <button
        onClick={toggle}
        className="flex min-w-0 shrink-0 items-center gap-1.5 text-muted-foreground hover:text-foreground"
        title={collapsed ? "Expand git details" : "Collapse git details"}
      >
        {collapsed ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
        <span className="max-w-40 truncate font-medium text-foreground sm:max-w-56" title={git.name}>
          {git.name || "repo"}
        </span>
      </button>
      <span
        className="flex min-w-0 items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-primary"
        title={git.branch}
      >
        <GitBranch className="size-3 shrink-0" />
        <span className={collapsed ? "truncate" : "break-all"}>{git.branch || "?"}</span>
      </span>
      {!collapsed && (
        <>
          {(git.dirty ?? 0) > 0 && (
            <span className="text-amber-600 dark:text-amber-500" title="Uncommitted changes">
              {git.dirty} change{git.dirty === 1 ? "" : "s"}
            </span>
          )}
          {git.ahead != null && git.behind != null && (git.ahead > 0 || git.behind > 0) && (
            <span className="text-muted-foreground" title="Commits ahead ↑ / behind ↓ the upstream">
              {git.ahead > 0 && `↑${git.ahead}`}
              {git.ahead > 0 && git.behind > 0 && " "}
              {git.behind > 0 && `↓${git.behind}`}
            </span>
          )}
          <button
            onClick={refresh}
            className="text-muted-foreground hover:text-foreground"
            title="Refresh git status"
          >
            <RefreshCw className={"size-3" + (refreshing ? " animate-spin" : "")} />
          </button>
        </>
      )}
      <div className="flex-1" />
      {/* Sync stays reachable when collapsed — icon-only to keep the line compact. */}
      <Button
        variant="outline"
        size="sm"
        className={"shrink-0 " + (collapsed ? "size-6 p-0" : "h-6 gap-1.5 px-2 text-xs")}
        disabled={chatRunning}
        onClick={() => sendChat(SYNC_PROMPT)}
        aria-label="Sync branch"
        title="Ask the model to commit, push, and safely rebase this branch onto the default branch"
      >
        {chatRunning ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
        {!collapsed && "Sync"}
      </Button>
    </div>
  )
}
