import { useState } from "react"
import { GitBranch, Loader2, RefreshCw } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { syncPrompt } from "@/lib/git"
import { useStore } from "@/store"

/**
 * Git details + Sync for the current session's repo, in a modal. Reads the same
 * store.git as the transcript git bar and reuses the shared SYNC_PROMPT — this
 * is only the Settings-tab entry point; GitSection (the transcript bar) is
 * unchanged.
 */
export function GitDialog({ onClose }: { onClose: () => void }) {
  const git = useStore((s) => s.git)
  const chatRunning = useStore((s) => s.chatRunning)
  const sendChat = useStore((s) => s.sendChat)
  const loadGitStatus = useStore((s) => s.loadGitStatus)
  const [refreshing, setRefreshing] = useState(false)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="size-4" /> Git
          </DialogTitle>
          <DialogDescription>Repository status for this session's working directory.</DialogDescription>
        </DialogHeader>

        {git?.repo ? (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-foreground">{git.name || "repo"}</span>
              <Badge variant="outline" className="px-1.5 text-[10px] font-normal">{git.branch || "—"}</Badge>
              {git.discovered && (
                <Badge variant="outline" className="px-1.5 text-[10px] font-normal text-muted-foreground" title={git.cwd}>
                  subdir
                </Badge>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto size-7"
                disabled={refreshing}
                onClick={async () => {
                  setRefreshing(true)
                  await loadGitStatus()
                  setRefreshing(false)
                }}
                title="Refresh"
              >
                {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              </Button>
            </div>
            {git.remote && (
              <div className="truncate font-mono text-[11px] text-muted-foreground" title={git.remote}>
                {git.remote}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {git.dirty ? (
                <Badge variant="secondary" className="px-1.5 text-[10px] text-amber-500">
                  {git.dirty} change{git.dirty === 1 ? "" : "s"}
                </Badge>
              ) : (
                <span className="text-[11px] text-muted-foreground">Up to date</span>
              )}
              {!!git.ahead && <Badge variant="outline" className="px-1.5 text-[10px]">↑{git.ahead}</Badge>}
              {!!git.behind && <Badge variant="outline" className="px-1.5 text-[10px]">↓{git.behind}</Badge>}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-1 w-full gap-1.5"
              disabled={chatRunning}
              onClick={() => { sendChat(syncPrompt(git.discovered ? git.cwd : undefined)); onClose() }}
            >
              <RefreshCw className="size-3.5" /> Sync branch
            </Button>
            <p className="text-[11px] text-muted-foreground">
              Commits, pushes, and rebases this branch onto the default branch.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No git repository found in this session's directory, or in any single
            repository directly inside it.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
