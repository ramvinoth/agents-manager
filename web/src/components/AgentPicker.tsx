import { useState } from "react"
import { Bot, ChevronDown, Check, Download, Loader2, LogIn } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useStore } from "@/store"

export function AgentPicker() {
  const agents = useStore((s) => s.agents)
  const currentAgent = useStore((s) => s.currentAgent)
  const setAgent = useStore((s) => s.setAgent)
  const installAgent = useStore((s) => s.installAgent)
  const installing = useStore((s) => s.installing)
  const startAgentLogin = useStore((s) => s.startAgentLogin)
  const cur = agents.find((a) => a.id === currentAgent)
  const [open, setOpen] = useState(false)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 w-full justify-between gap-1.5 px-2 text-xs">
          <span className="flex min-w-0 items-center gap-1.5">
            <Bot className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{cur?.label || "Claude Code"}</span>
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Agent</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {agents.map((a) => {
          const isInstalling = installing === a.id
          const needsLogin = a.installed && a.loggedIn === false && a.id !== "claude"
          return (
            <DropdownMenuItem
              key={a.id}
              disabled={!!installing}
              onSelect={(e) => {
                if (!a.installed) {
                  e.preventDefault() // keep menu open while npm runs; close on success
                  installAgent(a.id).then(() => setOpen(false))
                } else if (needsLogin) {
                  setAgent(a.id)
                  // Codex (OAuth callback) and Copilot (OAuth device flow) have
                  // in-app sign-in, local and remote over SSH.
                  if (a.id === "codex" || a.id === "copilot") startAgentLogin(a.id)
                } else {
                  setAgent(a.id)
                }
              }}
              className="gap-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{a.label}</span>
                  {!a.installed ? (
                    <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] font-medium text-primary">
                      {isInstalling ? (
                        <>
                          <Loader2 className="size-3 animate-spin" /> Installing…
                        </>
                      ) : (
                        <>
                          <Download className="size-3" /> Install
                        </>
                      )}
                    </span>
                  ) : needsLogin ? (
                    <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] font-medium text-primary">
                      <LogIn className="size-3" /> Sign in
                    </span>
                  ) : (
                    a.id === currentAgent && <Check className="ml-auto size-3.5 shrink-0" />
                  )}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {!a.installed
                    ? isInstalling
                      ? "running npm install…"
                      : `${a.vendor} · not installed`
                    : needsLogin
                    ? `${a.vendor} · not signed in`
                    : a.vendor}
                </div>
              </div>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
