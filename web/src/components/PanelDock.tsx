import { useState } from "react"
import { Terminal as TerminalIcon, Globe, X, PictureInPicture2, PanelBottom } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { describeHost } from "@/lib/host"
import { useStore } from "@/store"
import { TerminalPanel } from "./TerminalPanel"
import { BrowserPanel } from "./BrowserPanel"

export function PanelDock({
  floating,
  onDragStart,
}: {
  floating?: boolean
  onDragStart?: (e: React.MouseEvent) => void
}) {
  const panel = useStore((s) => s.panel)
  const termInit = useStore((s) => s.termInit)
  const closePanel = useStore((s) => s.closePanel)
  const toggleFloating = useStore((s) => s.toggleFloating)
  const currentHost = useStore((s) => s.currentHost)
  const hosts = useStore((s) => s.hosts)
  const [state, setState] = useState("")

  if (!panel) return null
  const hostLabel = describeHost(currentHost, hosts)
  const Icon = panel === "terminal" ? TerminalIcon : Globe

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div
        className={cn(
          "flex h-8 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 text-xs",
          floating && "cursor-move select-none"
        )}
        onMouseDown={
          floating
            ? (e) => {
                if (!(e.target as HTMLElement).closest("button")) onDragStart?.(e)
              }
            : undefined
        }
      >
        <Icon className="size-3.5" />
        <span className="font-medium">
          {panel === "terminal" ? "Terminal" : "Browser"} on {hostLabel}
        </span>
        {state && <span className="text-muted-foreground">· {state}</span>}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={toggleFloating}
          title={floating ? "Dock panel above the chat" : "Float panel to a movable window"}
          aria-label={floating ? "Dock panel" : "Float panel"}
        >
          {floating ? <PanelBottom className="size-3.5" /> : <PictureInPicture2 className="size-3.5" />}
        </Button>
        <Button variant="ghost" size="icon" className="size-6" onClick={closePanel} aria-label="Close panel">
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {/* Key by host so switching hosts remounts the panel → the WS/PTY/CDP
            reconnects to the NEW host instead of silently driving the old one. */}
        {panel === "terminal" ? (
          <TerminalPanel key={`term-${currentHost}-${termInit?.key || "shell"}`} onState={setState} />
        ) : (
          <BrowserPanel key={`browser-${currentHost}`} onState={setState} />
        )}
      </div>
    </div>
  )
}
