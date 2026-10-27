import { useEffect, useMemo, useRef, useState } from "react"
import { type LucideIcon, Folder, FolderOpen, ChevronRight, ChevronDown, ClipboardList, NotebookPen, Sparkles, Loader2, Mail, Network, Plus, MoreHorizontal, Info } from "lucide-react"
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
import { projectLabels, projectTree } from "@/lib/projectTree"
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
  const [inboxSession, setInboxSession] = useState<{ id: string; title: string; cwd: string } | null>(null)
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
  const focused = dir ? groups.find((g) => g.dir === dir) : null
  const openList = useStore((s) => s.openProjects[s.currentHost])
  const openSet = useMemo(() => new Set(openList ?? []), [openList])
  const setProjectOpen = useStore((s) => s.setProjectOpen)
  // Long projects list CHAT_LIMIT chats until "Show N more"; per visit, not persisted.
  const [showAll, setShowAll] = useState<Set<string>>(new Set())
  const tree = useMemo(
    () => projectTree(groups, q, openSet, showAll, (g) => projectName(g.project || g.dir)),
    [groups, q, openSet, showAll],
  )

  // The open chat's project expands and takes focus (so Files follows), however
  // the chat was opened — the rail, the inbox, a push. Collapsing it afterwards sticks.
  const currentDir = useMemo(
    () => groups.find((g) => g.sessions.some((s) => s.path === currentSessionPath))?.dir,
    [groups, currentSessionPath],
  )
  useEffect(() => {
    if (!currentDir) return
    setProjectOpen(currentDir, true)
    setDir(currentDir)
  }, [currentDir, setProjectOpen, setDir])

  // Folder names, with the parent folder as a hint where two projects share one.
  const labels = useMemo(() => projectLabels(groups.map((g) => g.project || g.dir)), [groups])
  const label = (g: Group) => labels.get(g.project || g.dir) ?? { name: projectName(g.project || g.dir), hint: "" }

  // After a reload (or a chat opened from elsewhere) the open chat's row is
  // scrolled into view once its project has expanded — never on later re-renders.
  const treeRef = useRef<HTMLDivElement>(null)
  const scrolledTo = useRef("")
  useEffect(() => {
    if (!currentSessionPath || scrolledTo.current === currentSessionPath) return
    const el = treeRef.current?.querySelector(`[data-path="${CSS.escape(currentSessionPath)}"]`)
    if (!el) return
    scrolledTo.current = currentSessionPath
    el.scrollIntoView({ block: "nearest" })
  }, [currentSessionPath, tree])

  const toggleProject = (g: Group) => {
    setProjectOpen(g.dir)
    setDir(g.dir)
  }

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
  const showHarman = automationOn && (!q.trim() || "harman".includes(q.trim().toLowerCase()))

  return (
    <div className="flex h-full flex-col">
      <div className="p-2">
        <div className="flex gap-1.5">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter projects and chats…"
            className="h-8"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1 px-2 text-xs"
            onClick={() => setStartIn(focused?.dir ?? "")}
            data-track="New"
            aria-label="New chat"
            title={focused ? `New chat in ${projectName(focused.project || focused.dir)}` : "New chat"}
          >
            <Plus className="size-3.5" /> New
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div ref={treeRef} className="space-y-px px-2 pb-2" role="tree" aria-label="Projects and chats">
          {/* Pinned Harman entry — the orchestrator's home, above the projects.
              Only when automation is on; otherwise it doesn't exist here. */}
          {showHarman && (
            <PinnedRow icon={Sparkles} label="Harman" title="Harman — Harness Manager orchestrator" onClick={openHarman} />
          )}
          {tree.map(({ group: g, open, sessions: chats, more }) => (
            <div key={g.dir} role="treeitem" aria-expanded={open}>
              <div
                className={cn(
                  "group/row flex h-7 items-center rounded-md pr-0.5 hover:bg-accent/70 has-[[data-state=open]]:bg-accent/70",
                  g.dir === dir && "bg-accent/50",
                )}
              >
                <button
                  onClick={() => toggleProject(g)}
                  title={`${g.project}${g.sessions.length ? ` · ${g.sessions.length} chat${g.sessions.length === 1 ? "" : "s"} · ${fmtAgo(g.modified)}` : ""}`}
                  data-track="project row"
                  className="flex h-full min-w-0 flex-1 items-center gap-1 pl-1 text-left text-[13px]"
                >
                  {open ? (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  {open ? (
                    <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="ml-0.5 min-w-0 flex-1 truncate">
                    <span className="font-medium">{label(g).name}</span>
                    {label(g).hint && <span className="ml-1 text-xs text-muted-foreground">{label(g).hint}</span>}
                  </span>
                  {g.unread && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="unread" title="Unread replies" />}
                  {g.running > 0 ? (
                    <span className="inline-flex shrink-0 items-center gap-1 pr-1 text-[11px] tabular-nums text-emerald-600" title={`${g.running} running`}>
                      <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                      {g.running}
                    </span>
                  ) : (
                    !open && g.sessions.length > 0 && (
                      <span className="shrink-0 pr-1 text-[11px] tabular-nums text-muted-foreground">{g.sessions.length}</span>
                    )
                  )}
                </button>
                <ProjectMenu
                  name={label(g).name}
                  visible={g.dir === dir}
                  plugins={currentHost === "local" ? projectPlugins : []}
                  onNew={() => setStartIn(g.dir)}
                  onTasks={() => setTasksFor(g)}
                  onNotes={() => setNotesFor(g)}
                  onInbox={() => setInboxFor(g)}
                  onMap={() => setMapFor(g)}
                  onPlugin={(plugin) => setPluginFor({ plugin, group: g })}
                />
              </div>
              {open && (
                <div role="group" className="ml-[11px] space-y-px border-l border-border py-px pl-1">
                  {g.sessions.length === 0 ? (
                    // A chat-less project's one action: start its first chat there.
                    <button
                      onClick={() => setStartIn(g.dir)}
                      className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] text-primary hover:bg-accent/70"
                    >
                      <Plus className="size-3.5" /> Start session
                    </button>
                  ) : (
                    chats.map((s) => (
                      <SessionRow
                        key={s.path}
                        s={s}
                        current={s.path === currentSessionPath}
                        providerName={providerName}
                        onOpen={() => loadSession(s.path)}
                        onOpenInbox={(id, title) => setInboxSession({ id, title, cwd: g.project || g.dir })}
                      />
                    ))
                  )}
                  {more > 0 && (
                    <button
                      onClick={() => setShowAll((m) => new Set(m).add(g.dir))}
                      className="flex h-6 w-full items-center rounded-md pl-[22px] text-left text-xs text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                    >
                      Show {more} more
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {tree.length === 0 && q.trim() && !showHarman && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">No project or chat matches “{q.trim()}”.</div>
          )}
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
          cwd={inboxSession.cwd}
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

/**
 * A project's "⋯" menu on its tree row: a new chat there, its board, notes
 * ledger, message ledger, code map, and the apps sharing its folder.
 */
function ProjectMenu({
  name,
  visible,
  plugins,
  onNew,
  onTasks,
  onNotes,
  onInbox,
  onMap,
  onPlugin,
}: {
  name: string
  /** Always shown (the focused project); otherwise only on hover/focus. */
  visible: boolean
  plugins: ProjectPlugin[]
  onNew: () => void
  onTasks: () => void
  onNotes: () => void
  onInbox: () => void
  onMap: () => void
  onPlugin: (p: ProjectPlugin) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-6 shrink-0 text-muted-foreground", !visible && HOVER_ONLY)}
          data-track="project menu"
          aria-label={`${name} tools`}
          title={`${name} tools`}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={onNew}>
          <Plus className="size-3.5" /> New chat here
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onTasks}>
          <ClipboardList className="size-3.5" /> Tasks
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onNotes}>
          <NotebookPen className="size-3.5" /> Notes
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onInbox}>
          <Mail className="size-3.5" /> Inbox
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onMap}>
          <Network className="size-3.5" /> Map
        </DropdownMenuItem>
        {/* Project plugins only open this computer's folders (the caller passes none otherwise). */}
        {plugins.length > 0 && <DropdownMenuSeparator />}
        {plugins.map((p) => {
          const Icon = pluginIcon(p.icon)
          return (
            <DropdownMenuItem key={p.id} title={p.description} onClick={() => onPlugin(p)}>
              <Icon className="size-3.5" /> {p.label}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Row controls that stay out of the way: shown on the row's hover, keyboard
 * focus or open menu; always shown where there is no hover (touch).
 */
const HOVER_ONLY_GROUP =
  "hidden group-hover/row:flex group-focus-within/row:flex group-has-[[data-state=open]]/row:flex [@media(hover:none)]:flex"
const HOVER_ONLY =
  "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"

/** A fixed entry above the tree (Harman), styled as a tree row. */
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
      className="mb-1 flex h-7 w-full items-center gap-1 rounded-md pl-1 text-left text-[13px] hover:bg-accent/70"
    >
      {/* Chevron-width spacer, so the icon lines up with the project folders. */}
      <span className="size-3.5 shrink-0" />
      <Icon className="size-4 shrink-0 text-primary" />
      <span className="ml-0.5 flex-1 font-medium">{label}</span>
    </button>
  )
}

/**
 * One chat under its project in the tree. The row itself opens the session;
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

  const openRhs = useStore((st) => st.openRhs)
  const cwd = detail?.summary?.cwd
  // The model it runs on now, not every model it ever used. Older cached
  // summaries carry no `model`; their last sorted entry is the best guess.
  const model = detail?.summary?.model ?? detail?.summary?.models?.at(-1)
  // The right panel shows the CURRENT chat's capabilities, so open this chat first.
  const showCaps = (tab: "skills" | "mcp") => {
    if (!current) onOpen()
    openRhs(tab)
  }

  const status = s.running ? "running" : s.unread ? "unread" : ""
  const provider = providerName(s.provider)
  const harness = s.harness && s.harness !== "claude" ? s.harness : ""

  return (
    <div className={cn("rounded-md", current && "bg-accent")} data-path={s.path}>
      <div className={cn("group/row flex h-7 items-center rounded-md pr-0.5 has-[[data-state=open]]:bg-accent/70", !current && "hover:bg-accent/70")}>
        <button
          onClick={onOpen}
          data-track="session row"
          aria-current={current || undefined}
          title={[s.title, provider, harness].filter(Boolean).join(" · ")}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1.5 text-left text-[13px]"
        >
          {/* A fixed status slot keeps every title on the same left edge. */}
          <span className="flex size-2 shrink-0 items-center justify-center">
            {status && (
              <span
                className={cn("size-1.5 rounded-full", status === "running" ? "animate-pulse bg-emerald-500" : "bg-primary")}
                aria-label={status}
                title={status === "running" ? "A run is in flight" : "Unread"}
              />
            )}
          </span>
          <span className={cn("min-w-0 flex-1 truncate", (current || s.unread) && "font-medium")}>{s.title}</span>
          {(provider || harness) && (
            <span className="shrink-0 rounded bg-muted px-1 text-[10px] font-medium text-foreground/70 group-hover/row:hidden">
              {harness ? harness.toUpperCase() : provider}
            </span>
          )}
          <span className="shrink-0 pr-1 text-[11px] tabular-nums text-muted-foreground group-hover/row:hidden group-has-[[data-state=open]]/row:hidden">
            {fmtAgo(activity(s))}
          </span>
        </button>
        <span className={cn("flex shrink-0 items-center", !current && !expanded && HOVER_ONLY_GROUP)}>
          <button
            onClick={toggle}
            aria-label={expanded ? "Hide details" : "Show details"}
            aria-expanded={expanded}
            title={expanded ? "Hide details" : "Details"}
            className={cn(
              "flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-background/60 hover:text-foreground",
              expanded && "text-foreground",
            )}
          >
            <Info className="size-3.5" />
          </button>
          <SessionActions session={s} />
        </span>
      </div>
      {expanded && (
        <div className="space-y-1.5 pb-2 pl-[22px] pr-2 pt-0.5 text-xs text-muted-foreground">
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
                <button
                  onClick={() => showCaps("skills")}
                  title="Open this chat's skills"
                  data-track="session caps skills"
                  className="rounded bg-muted px-1.5 py-px font-medium text-foreground/70 hover:bg-primary/15 hover:text-primary"
                >
                  {detail.capabilities.skills.length} skills
                </button>
                <button
                  onClick={() => showCaps("mcp")}
                  title="Open this chat's MCP tools"
                  data-track="session caps mcp"
                  className="rounded bg-muted px-1.5 py-px font-medium text-foreground/70 hover:bg-primary/15 hover:text-primary"
                >
                  {detail.capabilities.mcp.length} MCP
                </button>
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
                {model && (
                  <span
                    title="The model this chat's latest turn ran on"
                    className="rounded bg-muted px-1.5 py-px font-mono text-[10px] text-foreground/70"
                  >
                    {model.replace("claude-", "")}
                  </span>
                )}
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
