import { useEffect, useState } from "react"
import {
  Bot,
  Server,
  ChevronDown,
  Moon,
  Sun,
  Check,
  ShieldCheck,
  ShieldAlert,
  Terminal as TerminalIcon,
  Globe,
  Plus,
  FolderOpen,
  Pencil,
  User,
  LogOut,
  KeyRound,
  Plug,
  MessageSquarePlus,
  Wrench,
} from "lucide-react"
import { TextFieldDialog } from "./settings/TextFieldDialog"
import { recordFeedback } from "@/usageTracker"
import { SessionActions } from "./SessionActions"
import { MobileNav } from "./MobileNav"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useStore } from "@/store"
import { describeHost } from "@/lib/host"
import type { HostInfo } from "@/lib/types"
import { HostDialog, EnvDialog, IntegrationsDialog, NewSessionDialog } from "@/components/lazyDialogs"

function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark")
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    localStorage.setItem("theme", dark ? "dark" : "light")
  }, [dark])
  return { dark, toggle: () => setDark((d) => !d) }
}

export function Header() {
  const { dark, toggle } = useTheme()
  const [nsOpen, setNsOpen] = useState(false)
  const [envOpen, setEnvOpen] = useState(false)
  const [intOpen, setIntOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [hostEdit, setHostEdit] = useState<HostInfo | null | undefined>(undefined)
  const hosts = useStore((s) => s.hosts)
  const currentHost = useStore((s) => s.currentHost)
  const setHost = useStore((s) => s.setHost)
  const sessions = useStore((s) => s.sessions)
  const currentSessionPath = useStore((s) => s.currentSessionPath)
  const auth = useStore((s) => s.auth)
  const openPanel = useStore((s) => s.openPanel)
  const panel = useStore((s) => s.panel)
  const openFs = useStore((s) => s.openFs)
  const droppedFile = useStore((s) => s.droppedFile)
  const authUser = useStore((s) => s.authUser)
  const serverVersion = useStore((s) => s.serverVersion)
  const signout = useStore((s) => s.signout)
  const needsAuth = useStore((s) => s.needsAuth)

  // Logged out: a bare header — just the brand and theme toggle (plus the file
  // name when viewing a public dropped session). Every other control needs auth,
  // so showing New/Harman/host/panels here would only open dialogs that then 401.
  const themeToggle = (
    <Button variant="ghost" size="icon" className="size-7" onClick={toggle} aria-label="Toggle theme">
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )

  if (needsAuth) {
    return (
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-3">
        <Brand />
        <div className="flex min-w-0 items-center gap-2">
          {droppedFile && (
            <span className="flex min-w-0 items-center gap-1 truncate text-sm text-muted-foreground">
              <FolderOpen className="size-3.5 shrink-0" />
              <span className="truncate">{droppedFile}</span>
            </span>
          )}
          {themeToggle}
        </div>
      </header>
    )
  }

  const current = sessions.find((x) => x.path === currentSessionPath)
  const hostLabel = describeHost(currentHost, hosts)

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 sm:gap-3">
      <MobileNav />
      <Brand compact />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1.5 px-2 text-xs"
            data-track="host picker"
            aria-label={`Host: ${hostLabel}`}
          >
            <Server className="size-3.5 text-muted-foreground" />
            <span className="hidden max-w-40 truncate sm:inline">{hostLabel}</span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuLabel>Host</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setHost("local")}>
            This machine
            {currentHost === "local" && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
          {hosts
            .filter((h) => h.id !== "local")
            .map((h) => (
              <DropdownMenuItem
                key={h.id}
                onClick={() => setHost(h.id)}
                title={`${h.user}@${h.host}:${h.port}`}
                className="gap-1"
              >
                <span className="min-w-0 flex-1 truncate">{h.label}</span>
                {currentHost === h.id && <Check className="size-3.5 shrink-0" />}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setHostEdit(h)
                  }}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={`Edit ${h.label}`}
                >
                  <Pencil className="size-3" />
                </button>
              </DropdownMenuItem>
            ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setHostEdit(null)} className="text-primary">
            <Plus className="size-3.5" /> Add host…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 gap-1 px-2 text-xs"
        onClick={() => setNsOpen(true)}
        data-track="New"
        aria-label="New session"
      >
        <Plus className="size-3.5" />
        <span className="hidden sm:inline">New</span>
      </Button>

      <div className="flex min-w-0 flex-1 items-center gap-1">
        {droppedFile && (
          <Badge variant="outline" className="shrink-0 gap-1 text-[10px] font-normal">
            <FolderOpen className="size-3" /> file
          </Badge>
        )}
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {droppedFile || current?.title || (currentSessionPath ? "…" : "No session")}
        </span>
        {!droppedFile && <SessionActions />}
      </div>

      {/* Workspace tools live in one menu: on screen every visit, each was
          tapped 0 times in 30 days as its own header button (card 151). */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            data-track="tools menu"
            aria-label="Tools"
          >
            <Wrench className="size-3.5" />
            <span className="hidden sm:inline">Tools</span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onClick={openFs}>
            <FolderOpen className="size-3.5" /> Files
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openPanel("browser")}>
            <Globe className="size-3.5" /> Browser panel
            {panel === "browser" && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openPanel("terminal")}>
            <TerminalIcon className="size-3.5" /> Terminal panel
            {panel === "terminal" && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setIntOpen(true)}>
            <Plug className="size-3.5" /> Integrations
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setEnvOpen(true)}>
            <KeyRound className="size-3.5" /> Environment variables · {hostLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Only the problem state earns header space; "logged in" lives in the account menu. */}
      {auth && !auth.loggedIn && (
        <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
          <ShieldAlert className="size-3" /> not logged in
        </Badge>
      )}

      {authUser && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 max-w-32 shrink-0 gap-1 px-2 text-xs"
              data-track="account menu"
              aria-label="Account"
            >
              <User className="size-3.5 shrink-0" />
              <span className="hidden truncate sm:inline">{authUser.username}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="max-w-56 truncate text-xs font-normal text-muted-foreground">
              {authUser.username}
            </DropdownMenuLabel>
            {auth?.loggedIn && (
              <DropdownMenuLabel className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                <ShieldCheck className="size-3 text-emerald-500" /> Claude: {auth.subscriptionType || "logged in"}
              </DropdownMenuLabel>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={toggle}>
              {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />} {dark ? "Light mode" : "Dark mode"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setFeedbackOpen(true)}>
              <MessageSquarePlus className="size-3.5" /> Send feedback
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => signout()}>
              <LogOut className="size-3.5" /> Log out
            </DropdownMenuItem>
            {serverVersion && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Harman v{serverVersion}
                </DropdownMenuLabel>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {!authUser && themeToggle}

      {nsOpen && <NewSessionDialog open onOpenChange={setNsOpen} />}
      {envOpen && <EnvDialog onClose={() => setEnvOpen(false)} />}
      {intOpen && <IntegrationsDialog onClose={() => setIntOpen(false)} />}
      {feedbackOpen && (
        <TextFieldDialog
          title="Send feedback"
          description="What is confusing, slow, missing or never used? Agents read every note in the usage report and turn it into work on the board."
          value=""
          saveLabel="Send"
          clearable={false}
          placeholder="e.g. I never use the Terminal panel; the Inbox Skip button is hard to find."
          onSave={(v) => v && recordFeedback("main", v)}
          onClose={() => setFeedbackOpen(false)}
        />
      )}
      {hostEdit !== undefined && <HostDialog host={hostEdit} onClose={() => setHostEdit(undefined)} />}
    </header>
  )
}

/** The product mark; `compact` hides the name on narrow screens. */
function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2 font-semibold">
      <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Bot className="size-3.5" />
      </div>
      <span className={compact ? "hidden text-sm sm:inline" : "text-sm"}>Harman</span>
    </div>
  )
}
