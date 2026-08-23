import { useMemo, useState } from "react"
import { Folder, ChevronRight, ArrowLeft, ClipboardList } from "lucide-react"
import { Input } from "@/components/ui/input"
import { AgentPicker } from "@/components/AgentPicker"
import { KanbanDialog } from "@/components/kanban/KanbanDialog"
import { cn } from "@/lib/utils"
import { fmtAgo, projectName } from "@/lib/format"
import { useStore } from "@/store"
import type { SessionListItem } from "@/lib/types"

interface Group {
  dir: string
  project: string
  sessions: SessionListItem[]
  modified: number
}

function groupSessions(sessions: SessionListItem[]): Group[] {
  const groups: Record<string, Group> = {}
  for (const s of sessions) {
    // Group by project (cwd) so it's meaningful across agents — Claude, Codex
    // and Pi all store the working directory, even though their paths differ.
    const key = s.project || s.path.split("/").slice(0, -1).join("/")
    if (!groups[key]) groups[key] = { dir: key, project: s.project, sessions: [], modified: 0 }
    groups[key].sessions.push(s)
    if (s.modified > groups[key].modified) groups[key].modified = s.modified
  }
  const list = Object.values(groups).sort((a, b) => b.modified - a.modified)
  for (const g of list) g.sessions.sort((a, b) => b.modified - a.modified)
  return list
}

export function SessionList() {
  const sessions = useStore((s) => s.sessions)
  const currentSessionPath = useStore((s) => s.currentSessionPath)
  const currentHost = useStore((s) => s.currentHost)
  const loadSession = useStore((s) => s.loadSession)
  const [dir, setDir] = useState<string | null>(null)
  const [q, setQ] = useState("")
  const [tasksFor, setTasksFor] = useState<Group | null>(null)

  const groups = useMemo(() => groupSessions(sessions), [sessions])
  const active = dir ? groups.find((g) => g.dir === dir) : null
  const filter = q.toLowerCase()

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 p-2">
        <AgentPicker />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter sessions…"
          className="h-8"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-0.5 p-2 pt-0">
          {!active
            ? groups
                .filter((g) => !filter || g.project.toLowerCase().includes(filter))
                .map((g) => (
                  <button
                    key={g.dir}
                    onClick={() => setDir(g.dir)}
                    title={g.project}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{projectName(g.project)}</div>
                      <div className="text-xs text-muted-foreground">
                        {g.sessions.length} session{g.sessions.length === 1 ? "" : "s"} ·{" "}
                        {fmtAgo(g.modified)}
                      </div>
                    </div>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                ))
            : [
                <button
                  key="back"
                  onClick={() => setDir(null)}
                  className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
                >
                  <ArrowLeft className="size-4" /> All projects
                </button>,
                // Fixed "Tasks" row — always first under a project. Opens the
                // project's Kanban board, shared by every session in this dir.
                <button
                  key="tasks"
                  onClick={() => setTasksFor(active)}
                  className="mb-1 flex w-full items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <ClipboardList className="size-4 shrink-0 text-primary" />
                  <span className="flex-1 font-medium">Tasks</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>,
                ...active.sessions
                  .filter((s) => !filter || s.title.toLowerCase().includes(filter))
                  .map((s) => (
                    <button
                      key={s.path}
                      onClick={() => loadSession(s.path)}
                      className={cn(
                        "flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                        s.path === currentSessionPath && "bg-accent"
                      )}
                    >
                      <span className="truncate font-medium">{s.title}</span>
                      <span className="text-xs text-muted-foreground">{fmtAgo(s.modified)}</span>
                    </button>
                  )),
              ]}
        </div>
      </div>
      {tasksFor && (
        <KanbanDialog
          host={currentHost}
          cwd={tasksFor.project || tasksFor.dir}
          name={projectName(tasksFor.project || tasksFor.dir)}
          onClose={() => setTasksFor(null)}
        />
      )}
    </div>
  )
}
