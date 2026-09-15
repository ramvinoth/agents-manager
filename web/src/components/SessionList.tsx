import { useMemo, useState } from "react"
import { Folder, ChevronRight, ChevronDown, ArrowLeft, ClipboardList, Sparkles, Loader2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { AgentPicker } from "@/components/AgentPicker"
import { HarmanDialog } from "@/components/HarmanDialog"
import { KanbanDialog } from "@/components/kanban/KanbanDialog"
import { cn } from "@/lib/utils"
import { fmtAgo, projectName } from "@/lib/format"
import { useStore } from "@/store"
import { api } from "@/lib/api"
import type { SessionListItem, SessionDetail } from "@/lib/types"

interface Group {
  dir: string
  project: string
  sessions: SessionListItem[]
  modified: number
  unread: boolean
  running: number
}

function groupSessions(sessions: SessionListItem[]): Group[] {
  const groups: Record<string, Group> = {}
  for (const s of sessions) {
    // Group by project (cwd) so it's meaningful across agents — Claude, Codex
    // and Pi all store the working directory, even though their paths differ.
    const key = s.project || s.path.split("/").slice(0, -1).join("/")
    if (!groups[key]) groups[key] = { dir: key, project: s.project, sessions: [], modified: 0, unread: false, running: 0 }
    groups[key].sessions.push(s)
    if (s.modified > groups[key].modified) groups[key].modified = s.modified
    if (s.unread) groups[key].unread = true
    if (s.running) groups[key].running += 1
  }
  const list = Object.values(groups).sort((a, b) => b.modified - a.modified)
  for (const g of list) g.sessions.sort((a, b) => b.modified - a.modified)
  return list
}

export function SessionList() {
  const sessions = useStore((s) => s.sessions)
  const providers = useStore((s) => s.providers)
  const currentSessionPath = useStore((s) => s.currentSessionPath)
  const currentHost = useStore((s) => s.currentHost)
  const loadSession = useStore((s) => s.loadSession)
  // The master switch decides whether the orchestrator exists for this app at
  // all: OFF → no pinned Harman entry, the plain chat-session system it is.
  const automationOn = useStore((s) => s.automationOn)
  const [dir, setDir] = useState<string | null>(null)
  const [q, setQ] = useState("")
  const [tasksFor, setTasksFor] = useState<Group | null>(null)
  const [harmanOpen, setHarmanOpen] = useState(false)

  const groups = useMemo(() => groupSessions(sessions), [sessions])
  const active = dir ? groups.find((g) => g.dir === dir) : null
  const filter = q.toLowerCase()

  // A custom provider is stored as a preset id; show its human name (falling back
  // to "Custom" if the preset was deleted). "" means the harness default — no chip.
  const providerName = (id?: string) =>
    id ? providers.find((p) => p.id === id)?.name || "Custom" : ""

  // Harman: open the existing orchestrator session if one exists, else set one up.
  const openHarman = () => {
    const existing = sessions.find((s) => s.title === "Harman")
    if (existing) loadSession(existing.path)
    else setHarmanOpen(true)
  }

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
            ? [
                // Pinned Harman entry — the orchestrator's home, above the project
                // groups. Only when automation is on; otherwise it doesn't exist here.
                ...(automationOn && (!filter || "harman".includes(filter))
                  ? [
                      <button
                        key="harman"
                        onClick={openHarman}
                        title="Harman — Harness Manager orchestrator"
                        className="mb-1 flex w-full items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-sm hover:bg-accent"
                      >
                        <Sparkles className="size-4 shrink-0 text-primary" />
                        <span className="flex-1 font-medium">Harman</span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </button>,
                    ]
                  : []),
                ...groups
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
                        <div className="flex items-center gap-1.5">
                          {g.unread && (
                            <span
                              className="size-2 shrink-0 rounded-full bg-primary"
                              aria-label="unread"
                            />
                          )}
                          <div className="truncate font-medium">{projectName(g.project)}</div>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {g.sessions.length} session{g.sessions.length === 1 ? "" : "s"} ·{" "}
                          {fmtAgo(g.modified)}
                          {g.running > 0 && (
                            <span className="ml-1.5 inline-flex items-center gap-1 text-emerald-600">
                              <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                              {g.running} running
                            </span>
                          )}
                        </div>
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  )),
              ]
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
                    <SessionRow
                      key={s.path}
                      s={s}
                      current={s.path === currentSessionPath}
                      providerName={providerName}
                      onOpen={() => loadSession(s.path)}
                    />
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
      <HarmanDialog open={harmanOpen} onOpenChange={setHarmanOpen} />
    </div>
  )
}

/**
 * One session in the drilled-in project view. The row itself opens the session;
 * a caret expands an inline detail panel that lazy-loads /api/session-detail on
 * first open — progressive disclosure, so a peer's skills · MCP · cwd · model
 * are visible in place without navigating into it (and cost nothing until asked).
 */
function SessionRow({
  s,
  current,
  providerName,
  onOpen,
}: {
  s: SessionListItem
  current: boolean
  providerName: (id?: string) => string
  onOpen: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [loading, setLoading] = useState(false)

  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    if (next && !detail && !loading) {
      setLoading(true)
      api
        .sessionDetail(s.path)
        .then((d) => d && Array.isArray(d.capabilities?.skills) && setDetail(d))
        .catch(() => {})
        .finally(() => setLoading(false))
    }
  }

  const cwd = detail?.summary?.cwd
  const models = detail?.summary?.models ?? []

  return (
    <div className={cn("rounded-md", current && "bg-accent")}>
      <div className="flex items-center">
        <button
          onClick={onOpen}
          className="flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
        >
          <span className="flex items-center gap-1.5">
            {s.unread && (
              <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="unread" />
            )}
            {s.running && (
              <span
                className="size-2 shrink-0 animate-pulse rounded-full bg-emerald-500"
                aria-label="running"
                title="A run is in flight"
              />
            )}
            <span className="truncate font-medium">{s.title}</span>
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{fmtAgo(s.modified)}</span>
            {s.persona && (
              <span
                className="inline-flex items-center gap-1 rounded bg-primary/10 px-1 py-px text-[10px] font-medium text-primary"
                title={s.persona.role ? `${s.persona.name} · ${s.persona.role}` : s.persona.name}
              >
                {s.persona.avatar ? <span>{s.persona.avatar}</span> : null}
                {s.persona.name}
              </span>
            )}
            {providerName(s.provider) && (
              <span className="rounded bg-muted px-1 py-px text-[10px] font-medium text-foreground/70">
                {providerName(s.provider)}
              </span>
            )}
            {s.harness && s.harness !== "claude" && (
              <span className="rounded bg-muted px-1 py-px text-[10px] font-medium uppercase text-foreground/70">
                {s.harness}
              </span>
            )}
          </span>
        </button>
        <button
          onClick={toggle}
          aria-label={expanded ? "Hide details" : "Show details"}
          aria-expanded={expanded}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
      </div>
      {expanded && (
        <div className="space-y-1.5 px-2 pb-2 pt-0.5 text-xs text-muted-foreground">
          {loading && !detail ? (
            <div className="flex items-center gap-1.5 py-1">
              <Loader2 className="size-3.5 animate-spin" /> loading…
            </div>
          ) : detail ? (
            <>
              {cwd && (
                <div className="truncate font-mono text-[11px]" title={cwd}>
                  {cwd}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1">
                <span className="rounded bg-muted px-1.5 py-px font-medium text-foreground/70">
                  {detail.capabilities.skills.length} skills
                </span>
                <span className="rounded bg-muted px-1.5 py-px font-medium text-foreground/70">
                  {detail.capabilities.mcp.length} MCP
                </span>
                {detail.meta.effort && (
                  <span className="rounded bg-muted px-1.5 py-px font-medium text-foreground/70">
                    {detail.meta.effort}
                  </span>
                )}
                {models.map((m) => (
                  <span
                    key={m}
                    className="rounded bg-muted px-1.5 py-px font-mono text-[10px] text-foreground/70"
                  >
                    {m.replace("claude-", "")}
                  </span>
                ))}
              </div>
              {detail.meta.goal && (
                <div className="line-clamp-2 leading-snug" title={detail.meta.goal}>
                  {detail.meta.goal}
                </div>
              )}
            </>
          ) : (
            <div className="py-1">No details available.</div>
          )}
        </div>
      )}
    </div>
  )
}
