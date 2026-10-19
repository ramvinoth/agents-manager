import { useEffect, useMemo, useState } from "react"
import { type LucideIcon, Folder, ChevronRight, ChevronDown, ArrowLeft, ClipboardList, NotebookPen, Sparkles, Loader2, Mail, Network, Plus, MoreHorizontal } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { HarmanDialog } from "@/components/HarmanDialog"
import { SessionActions } from "@/components/SessionActions"
import { cn } from "@/lib/utils"
import { fmtAgo, projectName } from "@/lib/format"
import { useStore } from "@/store"
import { api } from "@/lib/api"
import type { SessionListItem, SessionDetail, ProjectPlugin, OrgProject } from "@/lib/types"
import { activity, groupSessions, type Group } from "@/lib/projectGroups"
import { KanbanDialog, NotesDialog, MapDialog, InboxDialog, ProjectPluginDialog, NewSessionDialog } from "@/components/lazyDialogs"
import { pluginIcon, useProjectPlugins } from "@/components/projectPlugins/registry"

export function SessionList() {
  const sessions = useStore((s) => s.sessions)
  const providers = useStore((s) => s.providers)
  const currentSessionPath = useStore((s) => s.currentSessionPath)
  const currentHost = useStore((s) => s.currentHost)
  const loadSession = useStore((s) => s.loadSession)
  // The master switch decides whether the orchestrator exists for this app at
  // all: OFF → no pinned Harman entry, the plain chat-session system it is.
  const automationOn = useStore((s) => s.automationOn)
  const dir = useStore((s) => s.projectDirs[s.currentHost] ?? null)
  const setDir = useStore((s) => s.setProjectDir)
  const [q, setQ] = useState("")
  const [tasksFor, setTasksFor] = useState<Group | null>(null)
  const [notesFor, setNotesFor] = useState<Group | null>(null)
  const [inboxFor, setInboxFor] = useState<Group | null>(null)
  const [mapFor, setMapFor] = useState<Group | null>(null)
  const projectPlugins = useProjectPlugins()
  const [pluginFor, setPluginFor] = useState<{ plugin: ProjectPlugin; group: Group } | null>(null)
  const [inboxSession, setInboxSession] = useState<{ id: string; title: string } | null>(null)
  const [harmanOpen, setHarmanOpen] = useState(false)
  // The New dialog's folder: a project's dir, "" for the dialog's own default, null = closed.
  const [startIn, setStartIn] = useState<string | null>(null)
  // Org projects, so a project made before its first chat (on the board, by an
  // import) is in the rail too. Refetched as sessions change: a new chat can
  // create a project.
  const [orgProjects, setOrgProjects] = useState<OrgProject[]>([])
  useEffect(() => {
    api.orgProjects().then((d) => Array.isArray(d?.projects) && setOrgProjects(d.projects)).catch(() => {})
  }, [sessions.length])

  const groups = useMemo(() => groupSessions(sessions, orgProjects, currentHost), [sessions, orgProjects, currentHost])
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
      <div className="p-2">
        <div className="flex gap-1.5">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={active ? "Filter chats…" : "Filter projects…"}
            className="h-8"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1 px-2 text-xs"
            onClick={() => setStartIn(active?.dir ?? "")}
            data-track="New"
            aria-label="New chat"
            title={active ? `New chat in ${projectName(active.project || active.dir)}` : "New chat"}
          >
            <Plus className="size-3.5" /> New
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-0.5 p-2 pt-0">
          {!active
            ? [
                // Pinned Harman entry — the orchestrator's home, above the project
                // groups. Only when automation is on; otherwise it doesn't exist here.
                ...(automationOn && (!filter || "harman".includes(filter))
                  ? [
                      <PinnedRow
                        key="harman"
                        icon={Sparkles}
                        label="Harman"
                        title="Harman — Harness Manager orchestrator"
                        onClick={openHarman}
                      />,
                    ]
                  : []),
                ...groups
                  .filter((g) => !filter || g.project.toLowerCase().includes(filter))
                  .map((g) => (
                    <button
                      key={g.dir}
                      onClick={() => setDir(g.dir)}
                      title={g.project}
                      data-track="project row"
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
                          {g.sessions.length ? (
                            <>
                              {g.sessions.length} session{g.sessions.length === 1 ? "" : "s"} · {fmtAgo(g.modified)}
                            </>
                          ) : (
                            "No sessions yet"
                          )}
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
                // The project's header: back to all projects, its name, and a "⋯" menu
                // with its board, notes ledger, message ledger, code map and the apps
                // sharing this folder — tucked away so the rail is just its chats.
                <div key="head" className="mb-1 flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    onClick={() => setDir(null)}
                    aria-label="All projects"
                    title="All projects"
                  >
                    <ArrowLeft className="size-4" />
                  </Button>
                  <div className="min-w-0 flex-1 truncate text-sm font-semibold" title={active.project}>
                    {projectName(active.project || active.dir)}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0"
                        data-track="project menu"
                        aria-label="Project tools"
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onClick={() => setTasksFor(active)}>
                        <ClipboardList className="size-3.5" /> Tasks
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setNotesFor(active)}>
                        <NotebookPen className="size-3.5" /> Notes
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setInboxFor(active)}>
                        <Mail className="size-3.5" /> Inbox
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setMapFor(active)}>
                        <Network className="size-3.5" /> Map
                      </DropdownMenuItem>
                      {/* Project plugins only open this computer's folders. */}
                      {currentHost === "local" && projectPlugins.length > 0 && <DropdownMenuSeparator />}
                      {(currentHost === "local" ? projectPlugins : []).map((p) => {
                        const Icon = pluginIcon(p.icon)
                        return (
                          <DropdownMenuItem key={p.id} title={p.description} onClick={() => setPluginFor({ plugin: p, group: active })}>
                            <Icon className="size-3.5" /> {p.label}
                          </DropdownMenuItem>
                        )
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>,
                // A chat-less project's one action: start its first chat there.
                ...(active.sessions.length
                  ? []
                  : [<PinnedRow key="start" icon={Plus} label="Start session" onClick={() => setStartIn(active.dir)} />]),
                ...active.sessions
                  .filter((s) => !filter || s.title.toLowerCase().includes(filter))
                  .map((s) => (
                    <SessionRow
                      key={s.path}
                      s={s}
                      current={s.path === currentSessionPath}
                      providerName={providerName}
                      onOpen={() => loadSession(s.path)}
                      onOpenInbox={(id, title) => setInboxSession({ id, title })}
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
      {notesFor && (
        <NotesDialog
          host={currentHost}
          cwd={notesFor.project || notesFor.dir}
          name={projectName(notesFor.project || notesFor.dir)}
          onClose={() => setNotesFor(null)}
        />
      )}
      {inboxFor && (
        <InboxDialog
          host={currentHost}
          cwd={inboxFor.project || inboxFor.dir}
          name={projectName(inboxFor.project || inboxFor.dir)}
          onClose={() => setInboxFor(null)}
        />
      )}
      {mapFor && (
        <MapDialog
          host={currentHost}
          cwd={mapFor.project || mapFor.dir}
          name={projectName(mapFor.project || mapFor.dir)}
          onClose={() => setMapFor(null)}
        />
      )}
      {pluginFor && (
        <ProjectPluginDialog
          plugin={pluginFor.plugin}
          host={currentHost}
          cwd={pluginFor.group.project || pluginFor.group.dir}
          name={projectName(pluginFor.group.project || pluginFor.group.dir)}
          onClose={() => setPluginFor(null)}
        />
      )}
      {inboxSession && (
        <InboxDialog
          host={currentHost}
          cwd={active?.project || active?.dir || ""}
          name={inboxSession.title}
          session={inboxSession.id}
          sessionTitle={inboxSession.title}
          onClose={() => setInboxSession(null)}
        />
      )}
      {startIn !== null && <NewSessionDialog open cwd={startIn} onOpenChange={(o) => !o && setStartIn(null)} />}
      <HarmanDialog open={harmanOpen} onOpenChange={setHarmanOpen} />
    </div>
  )
}

/** A fixed, bordered entry above the list (Harman, or an empty project's Start session). */
function PinnedRow({
  icon: Icon,
  label,
  title,
  onClick,
}: {
  icon: LucideIcon
  label: string
  title?: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="mb-1 flex w-full items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-sm hover:bg-accent"
    >
      <Icon className="size-4 shrink-0 text-primary" />
      <span className="flex-1 font-medium">{label}</span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
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
  onOpenInbox,
}: {
  s: SessionListItem
  current: boolean
  providerName: (id?: string) => string
  onOpen: () => void
  /** Opens this chat's mailbox (its inbox) — the per-session entry point,
   *  the board's folder-icon analogue. */
  onOpenInbox?: (id: string, title: string) => void
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
          data-track="session row"
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
            <span>{fmtAgo(activity(s))}</span>
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
        <SessionActions session={s} />
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
                {onOpenInbox && s.id && (
                  <button
                    onClick={() => onOpenInbox(s.id!, s.title || s.id!.slice(0, 8))}
                    className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-px font-medium text-primary hover:bg-primary/20"
                  >
                    <Mail className="size-3" /> Inbox
                  </button>
                )}
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
