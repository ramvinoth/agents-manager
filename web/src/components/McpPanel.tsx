import { useState } from "react"
import { ChevronDown, ChevronRight, Loader2, Plus, Plug, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api } from "@/lib/api"
import { useStore } from "@/store"
import { isRunning, resultOf, serverSummary, stateDot, stateLabel, stateTone } from "@/lib/mcp"
import type { McpServer } from "@/lib/types"

/**
 * The MCP tab: the configured servers, and — on demand — what each one actually
 * is.
 *
 * The list itself is a config read (engine.capabilities), so it can only ever
 * say what a file claims. Test asks the server: `initialize` + `tools/list`,
 * and the row then shows the real tool names, or the real error.
 *
 * Testing is always a click. Probing a stdio server runs its configured
 * command, which must never be a side effect of looking at a panel — so an
 * untested server says "Not tested" rather than showing a green dot inferred
 * from its config merely being parseable.
 */
export function McpPanel() {
  const caps = useStore((s) => s.caps)
  const probes = useStore((s) => s.mcpProbes)
  const probeMcp = useStore((s) => s.probeMcp)
  const probeAllMcp = useStore((s) => s.probeAllMcp)
  const [edit, setEdit] = useState<McpServer | null | undefined>(undefined)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [testingAll, setTestingAll] = useState(false)

  async function testAll() {
    setTestingAll(true)
    try {
      await probeAllMcp()
    } finally {
      setTestingAll(false)
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-1 px-2 pb-1">
        <span className="text-xs text-muted-foreground">{caps.mcp.length} servers</span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-xs"
            disabled={testingAll || !caps.mcp.length}
            onClick={testAll}
            title="Connect to every server and list its tools"
          >
            {testingAll ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
            Test all
          </Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setEdit(null)}>
            <Plus className="size-3.5" /> Add
          </Button>
        </div>
      </div>

      <div className="h-full overflow-y-auto">
        <div className="space-y-1 px-2 pb-4">
          {caps.mcp.map((m) => {
            const entry = probes[m.name]
            const res = resultOf(entry)
            const expanded = !!open[m.name]
            const canExpand = !!res && (res.state === "ok" ? res.tools.length > 0 : true)
            return (
              <div key={`${m.scope}:${m.name}`} className="rounded-md border border-border">
                <div className="flex items-start gap-2 p-2">
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => (canExpand ? setOpen((o) => ({ ...o, [m.name]: !expanded })) : setEdit(m))}
                    title={canExpand ? (expanded ? "Collapse" : "Show details") : "Edit configuration"}
                  >
                    <div className="flex items-center gap-2 text-sm">
                      {canExpand &&
                        (expanded ? (
                          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                        ))}
                      <span className="min-w-0 flex-1 truncate font-medium">{m.name}</span>
                      <Badge
                        variant={m.editable ? "secondary" : "outline"}
                        className="shrink-0 px-1.5 text-[10px] font-normal"
                      >
                        {m.scope}
                      </Badge>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                      <span className={"size-1.5 shrink-0 rounded-full " + stateDot(entry)} />
                      <span className={stateTone(entry)}>{stateLabel(entry)}</span>
                      {res && res.state === "ok" && (
                        <span className="truncate text-muted-foreground">· {serverSummary(res)}</span>
                      )}
                    </div>
                    {m.target && (
                      <div className="mt-1 truncate text-xs text-muted-foreground" title={m.target}>
                        {m.target}
                      </div>
                    )}
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 shrink-0"
                    disabled={isRunning(entry)}
                    onClick={() => {
                      setOpen((o) => ({ ...o, [m.name]: true }))
                      probeMcp(m.name)
                    }}
                    title="Connect to this server and list its tools"
                    aria-label={`Test ${m.name}`}
                  >
                    {isRunning(entry) ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                  </Button>
                </div>

                {expanded && res && (
                  <div className="border-t border-border px-2 py-1.5">
                    {res.state === "ok" ? (
                      <div className="space-y-1.5">
                        {res.tools.map((t) => (
                          <div key={t.name}>
                            <div className="font-mono text-[11px] text-foreground">{t.name}</div>
                            {t.description && (
                              <div className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                                {t.description}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      // Verbatim, not summarised: a real failure here names the
                      // missing file or the wrong port, which IS the fix.
                      <div className="space-y-1">
                        <div className={"text-[11px] " + stateTone(entry)}>{res.error}</div>
                        {res.detail && (
                          <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">
                            {res.detail}
                          </div>
                        )}
                        {res.state === "auth" && (
                          <div className="text-[11px] text-muted-foreground">
                            The server is reachable and its configuration is fine — it needs a login.
                          </div>
                        )}
                      </div>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-1 h-6 px-1.5 text-[11px]"
                      onClick={() => setEdit(m)}
                    >
                      Edit configuration
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {edit !== undefined && <McpEditor server={edit} onClose={() => setEdit(undefined)} />}
    </>
  )
}

/** Raw JSON config editor — moved here unchanged from RhsPanel. */
function McpEditor({ server, onClose }: { server: McpServer | null; onClose: () => void }) {
  const session = useStore((s) => s.currentSessionPath)
  const loadCapabilities = useStore((s) => s.loadCapabilities)
  const [name, setName] = useState(server?.name ?? "")
  const [scope, setScope] = useState<string>(server ? (server.scope === "global" ? "global" : "project") : "project")
  const [cfg, setCfg] = useState(
    JSON.stringify(server ? server.config : { command: "npx", args: ["-y", "some-mcp-server"], env: {} }, null, 2)
  )
  const [err, setErr] = useState("")
  const readonly = !!server && !server.editable

  async function save() {
    setErr("")
    if (!name) return setErr("Server name required")
    let parsed: unknown
    try {
      parsed = JSON.parse(cfg)
    } catch (e: any) {
      return setErr("Invalid JSON: " + e.message)
    }
    try {
      const res = await api.mcpSave({ name, scope, config: parsed, session })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      loadCapabilities()
      onClose()
    } catch (e: any) {
      setErr(e.message)
    }
  }
  async function del() {
    if (!server) return
    await api.mcpDelete({ name: server.name, scope: server.scope === "global" ? "global" : "project", session })
    loadCapabilities()
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{server ? (readonly ? "View MCP server" : "Edit MCP server") : "Add MCP server"}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="server-name" disabled={!!server} />
          {server ? (
            <Badge variant="secondary">{server.scope}</Badge>
          ) : (
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project">project (.mcp.json)</SelectItem>
                <SelectItem value="global">global (~/.claude.json)</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
        <Textarea
          value={cfg}
          onChange={(e) => setCfg(e.target.value)}
          readOnly={readonly}
          className="h-56 font-mono text-xs"
        />
        {err && <div className="text-xs text-destructive">{err}</div>}
        <DialogFooter>
          {server?.editable && (
            <Button variant="ghost" className="mr-auto text-destructive" onClick={del}>
              Delete
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {!readonly && <Button onClick={save}>Save</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
