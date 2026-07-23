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
  Sparkles,
  KeyRound,
} from "lucide-react"
import { NewSessionDialog } from "./NewSessionDialog"
import { SuhaiDialog } from "./SuhaiDialog"
import { HostDialog } from "./HostDialog"
import { EnvDialog } from "./EnvDialog"
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
  const [suhaiOpen, setSuhaiOpen] = useState(false)
  const [envOpen, setEnvOpen] = useState(false)
  const [hostEdit, setHostEdit] = useState<HostInfo | null | undefined>(undefined)
  const hosts = useStore((s) => s.hosts)
  const currentHost = useStore((s) => s.currentHost)
  const setHost = useStore((s) => s.setHost)
  const sessions = useStore((s) => s.sessions)
  const loadSession = useStore((s) => s.loadSession)
  const currentSessionPath = useStore((s) => s.currentSessionPath)
  const auth = useStore((s) => s.auth)
  const openPanel = useStore((s) => s.openPanel)
  const panel = useStore((s) => s.panel)
  const openFs = useStore((s) => s.openFs)
  const droppedFile = useStore((s) => s.droppedFile)
  const authUser = useStore((s) => s.authUser)
  const signout = useStore((s) => s.signout)
  const needsAuth = useStore((s) => s.needsAuth)

  // Logged out: a bare header — just the brand and theme toggle (plus the file
  // name when viewing a public dropped session). Every other control needs auth,
  // so showing New/SUHAI/host/panels here would only open dialogs that then 401.
  if (needsAuth) {
    return (
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-3">
        <div className="flex items-center gap-2 font-semibold">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Bot className="size-3.5" />
          </div>
          <span className="text-sm">Agents</span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {droppedFile && (
            <span className="flex min-w-0 items-center gap-1 truncate text-sm text-muted-foreground">
              <FolderOpen className="size-3.5 shrink-0" />
              <span className="truncate">{droppedFile}</span>
            </span>
          )}
          <Button variant="ghost" size="icon" className="size-7" onClick={toggle} aria-label="Toggle theme">
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
      </header>
    )
  }

  const current = sessions.find((x) => x.path === currentSessionPath)
  const hostLabel = describeHost(currentHost, hosts)

  // SUHAI: open the existing orchestrator session if one exists, else set one up.
  const openSuhai = () => {
    const existing = sessions.find((s) => s.title === "SUHAI")
    if (existing) loadSession(existing.path)
    else setSuhaiOpen(true)
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 sm:gap-3">
      <MobileNav />
      <div className="flex items-center gap-2 font-semibold">
        <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Bot className="size-3.5" />
        </div>
        <span className="hidden text-sm sm:inline">Agents</span>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs">
            <Server className="size-3.5 text-muted-foreground" />
            {hostLabel}
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
        size="icon"
        className="size-7"
        onClick={() => setEnvOpen(true)}
        title={`Environment variables for ${hostLabel}`}
      >
        <KeyRound className="size-4 text-muted-foreground" />
      </Button>

      {currentHost !== "local" && (
        <Button
          variant="outline"
          size="icon"
          className="size-7"
          onClick={openFs}
          title={`Browse files on ${hostLabel}`}
        >
          <FolderOpen className="size-4 text-muted-foreground" />
        </Button>
      )}

      <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setNsOpen(true)}>
        <Plus className="size-3.5" /> New
      </Button>

      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        onClick={openSuhai}
        title="SUHAI — Super Human Augmented Intelligence orchestrator"
      >
        <Sparkles className="size-3.5" /> <span className="hidden sm:inline">SUHAI</span>
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

      <Button
        variant={panel === "browser" ? "secondary" : "ghost"}
        size="icon"
        className="size-7"
        onClick={() => openPanel("browser")}
        title="Browser panel"
      >
        <Globe className="size-4" />
      </Button>
      <Button
        variant={panel === "terminal" ? "secondary" : "ghost"}
        size="icon"
        className="size-7"
        onClick={() => openPanel("terminal")}
        title="Terminal panel"
      >
        <TerminalIcon className="size-4" />
      </Button>

      {auth &&
        (auth.loggedIn ? (
          <Badge variant="secondary" className="gap-1 text-xs">
            <ShieldCheck className="size-3 text-emerald-500" />
            {auth.subscriptionType || "logged in"}
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
            <ShieldAlert className="size-3" /> not logged in
          </Badge>
        ))}

      {authUser && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 max-w-32 gap-1 px-2 text-xs">
              <User className="size-3.5 shrink-0" />
              <span className="truncate">{authUser.username}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="max-w-56 truncate text-xs font-normal text-muted-foreground">
              {authUser.username}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => signout()}>
              <LogOut className="size-3.5" /> Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Button variant="ghost" size="icon" className="size-7" onClick={toggle} aria-label="Toggle theme">
        {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </Button>

      <NewSessionDialog open={nsOpen} onOpenChange={setNsOpen} />
      <SuhaiDialog open={suhaiOpen} onOpenChange={setSuhaiOpen} />
      {envOpen && <EnvDialog onClose={() => setEnvOpen(false)} />}
      {hostEdit !== undefined && <HostDialog host={hostEdit} onClose={() => setHostEdit(undefined)} />}
    </header>
  )
}
