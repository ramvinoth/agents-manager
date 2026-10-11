import { useState } from "react"
import { userError } from "@/lib/errors"
import { Plus, Loader2, Store } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
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
import { AnalyticsPanel } from "@/components/AnalyticsPanel"
import type { MarketKind } from "@/lib/marketplace"
import type { McpServer, Plugin, Skill } from "@/lib/types"
import { MarketplaceDialog } from "@/components/lazyDialogs"

/** "This chat" scope (and per-chat plugins) exist only for an open Claude chat on
 *  this machine: the engine passes them as --plugin-dir on local Claude runs only. */
function useChatScope() {
  const session = useStore((s) => s.currentSessionPath)
  const local = useStore((s) => s.currentHost) === "local"
  const claude = useStore((s) => s.currentAgent) === "claude"
  return !!session && local && claude
}

const NEW_SKILL =
  "---\ndescription: What this skill does and when to use it\n---\n\n# New Skill\n\nInstructions for Claude when this skill is invoked.\n"

function SkillEditor({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  const session = useStore((s) => s.currentSessionPath)
  const loadCapabilities = useStore((s) => s.loadCapabilities)
  const [name, setName] = useState(skill?.name ?? "")
  const chatScope = useChatScope()
  // An existing skill saves back where it lives (user, project or this chat).
  const [scope, setScope] = useState<"user" | "project" | "chat">(
    skill?.source === "project" || skill?.source === "chat" ? skill.source : "user"
  )
  const [content, setContent] = useState<string | null>(skill ? null : NEW_SKILL)
  const [err, setErr] = useState("")
  const [confirmDel, setConfirmDel] = useState(false)
  const readonly = !!skill && !skill.editable

  if (skill && content === null) {
    api
      .skill(skill.path)
      .then((d: any) => setContent(d.error ? "" : d.content))
      .catch(() => setContent(""))
  }

  async function save() {
    setErr("")
    try {
      const res = await api.skillSave({
        name,
        scope,
        content: content ?? "",
        session,
      })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      loadCapabilities()
      onClose()
    } catch (e: any) {
      setErr(userError(e, "the skill", "save"))
    }
  }
  async function del() {
    if (!skill) return
    setConfirmDel(false)
    try {
      const d = await (await api.skillDelete({ path: skill.path })).json()
      if (d.error) throw new Error(d.error)
      loadCapabilities()
      onClose()
    } catch (e) {
      setErr(userError(e, "the skill", "delete"))
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{skill ? (readonly ? "View skill" : "Edit skill") : "New skill"}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="skill-name"
            disabled={!!skill}
          />
          {skill ? (
            <Badge variant="secondary">{skill.source}</Badge>
          ) : (
            <Select value={scope} onValueChange={(v) => setScope(v as any)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">user</SelectItem>
                <SelectItem value="project">project</SelectItem>
                {chatScope && <SelectItem value="chat">this chat only</SelectItem>}
              </SelectContent>
            </Select>
          )}
        </div>
        <Textarea
          value={content ?? ""}
          onChange={(e) => setContent(e.target.value)}
          readOnly={readonly}
          className="h-72 font-mono text-xs"
          placeholder={content === null ? "Loading…" : ""}
        />
        {err && <div className="text-xs text-destructive">{err}</div>}
        <DialogFooter>
          {skill?.editable &&
            (confirmDel ? (
              <>
                <Button variant="destructive" className="mr-auto" onClick={del}>
                  Delete
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDel(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="ghost" className="mr-auto text-destructive" onClick={() => setConfirmDel(true)}>
                Delete
              </Button>
            ))}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {!readonly && !confirmDel && <Button onClick={save}>Save</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function McpEditor({ server, onClose }: { server: McpServer | null; onClose: () => void }) {
  const session = useStore((s) => s.currentSessionPath)
  const loadCapabilities = useStore((s) => s.loadCapabilities)
  const [name, setName] = useState(server?.name ?? "")
  const chatScope = useChatScope()
  const [scope, setScope] = useState<string>(
    server?.scope === "global" || server?.scope === "chat" ? server.scope : "project"
  )
  const [cfg, setCfg] = useState(
    JSON.stringify(server ? server.config : { command: "npx", args: ["-y", "some-mcp-server"], env: {} }, null, 2)
  )
  const [err, setErr] = useState("")
  const [confirmDel, setConfirmDel] = useState(false)
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
      setErr(userError(e, "the MCP server", "save"))
    }
  }
  async function del() {
    if (!server) return
    setConfirmDel(false)
    try {
      const d = await (await api.mcpDelete({ name: server.name, scope, session })).json()
      if (d.error) throw new Error(d.error)
      loadCapabilities()
      onClose()
    } catch (e) {
      setErr(userError(e, "the MCP server", "remove"))
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
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
                {chatScope && <SelectItem value="chat">this chat only</SelectItem>}
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
          {server?.editable &&
            (confirmDel ? (
              <>
                <Button variant="destructive" className="mr-auto" onClick={del}>
                  Delete
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDel(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="ghost" className="mr-auto text-destructive" onClick={() => setConfirmDel(true)}>
                Delete
              </Button>
            ))}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {!readonly && !confirmDel && <Button onClick={save}>Save</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A chat's plugins: Harman's own (add/remove per chat; "Included" = its agent
 *  brings it by default) and the Mac's enabled Claude plugins (read-only — they
 *  are turned on in Claude Code itself). A plugin is whole: add or remove, never edit. */
function PluginList({ plugins }: { plugins: Plugin[] }) {
  const session = useStore((s) => s.currentSessionPath)
  const loadCapabilities = useStore((s) => s.loadCapabilities)
  const chatScope = useChatScope()
  const [busy, setBusy] = useState("")
  const [err, setErr] = useState("")

  async function toggle(p: Plugin) {
    setBusy(p.name); setErr("")
    try {
      await api.chatPlugin({ session, name: p.name, on: !p.active })
      await loadCapabilities()
    } catch (e) {
      setErr(userError(e, p.name, p.active ? "remove" : "add"))
    } finally {
      setBusy("")
    }
  }

  const agent = plugins.filter((p) => p.source === "agent")
  const machine = plugins.filter((p) => p.source === "machine")
  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-1 px-2 pb-4">
        {!chatScope && (
          <p className="px-1 pb-1 text-xs text-muted-foreground">
            Plugins apply to Claude chats on this Mac. Open one to add or remove them.
          </p>
        )}
        {err && <p className="px-1 text-xs text-destructive">{err}</p>}
        {agent.map((p) => (
          <div key={p.name} className="flex items-center gap-2 rounded-md border border-border p-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="truncate font-medium">{p.name}</span>
                {p.included && <Badge variant="secondary" className="px-1.5 text-[10px] font-normal">Included</Badge>}
              </div>
              {p.description && <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.description}</div>}
            </div>
            {chatScope && (
              <Switch on={p.active} disabled={!!busy} label={`${p.active ? "Remove" : "Add"} ${p.name}`}
                testId={`plugin-${p.name}`} onClick={() => toggle(p)} />
            )}
          </div>
        ))}
        {machine.length > 0 && (
          <div className="px-1 pt-3 text-xs text-muted-foreground">On for every Claude chat on this Mac</div>
        )}
        {machine.map((p) => (
          <div key={p.name} className="rounded-md border border-border p-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
              <Badge variant="outline" className="px-1.5 text-[10px] font-normal">machine</Badge>
            </div>
            {p.description && <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.description}</div>}
          </div>
        ))}
        {!plugins.length && <p className="px-1 text-xs text-muted-foreground">No plugins.</p>}
      </div>
    </div>
  )
}

export function RhsPanel() {
  const caps = useStore((s) => s.caps)
  const capsLoading = useStore((s) => s.capsLoading)
  const rhsTab = useStore((s) => s.rhsTab)
  const setRhsTab = useStore((s) => s.setRhsTab)
  const currentAgent = useStore((s) => s.currentAgent)
  const [skillEdit, setSkillEdit] = useState<Skill | null | undefined>(undefined)
  const [mcpEdit, setMcpEdit] = useState<McpServer | null | undefined>(undefined)
  const [market, setMarket] = useState<MarketKind | null>(null)
  const session = useStore((s) => s.currentSessionPath)
  const loadCapabilities = useStore((s) => s.loadCapabilities)
  // The marketplace installs onto the viewer's own machine.
  const local = useStore((s) => s.currentHost) === "local"
  const chatScope = useChatScope()

  return (
    <div className="flex h-full flex-col">
      <Tabs value={rhsTab} onValueChange={setRhsTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="m-2">
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="mcp">MCP</TabsTrigger>
          {currentAgent === "claude" && <TabsTrigger value="plugins">Plugins</TabsTrigger>}
          {currentAgent === "claude" && <TabsTrigger value="analysis">Analytics</TabsTrigger>}
        </TabsList>

        <TabsContent value="skills" className="min-h-0 flex-1">
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-xs text-muted-foreground">{caps.skills.length} skills</span>
            <div className="flex">
              {local && (
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setMarket("skills")}>
                  <Store className="size-3.5" /> Browse
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setSkillEdit(null)}>
                <Plus className="size-3.5" /> New
              </Button>
            </div>
          </div>
          <div className="h-full overflow-y-auto">
            <div className="space-y-1 px-2 pb-4">
              {caps.skills.map((s, i) => (
                <button
                  key={i}
                  onClick={() => setSkillEdit(s)}
                  className="w-full rounded-md border border-border p-2 text-left hover:bg-accent"
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-medium">/{s.name}</span>
                    <Badge
                      variant={s.editable ? "secondary" : "outline"}
                      className="shrink-0 px-1.5 text-[10px] font-normal"
                    >
                      {s.source}
                    </Badge>
                  </div>
                  {s.description && (
                    <div className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
                      {s.description}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="mcp" className="min-h-0 flex-1">
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-xs text-muted-foreground">{caps.mcp.length} servers</span>
            <div className="flex">
              {local && (
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setMarket("mcp")}>
                  <Store className="size-3.5" /> Browse
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setMcpEdit(null)}>
                <Plus className="size-3.5" /> Add
              </Button>
            </div>
          </div>
          <div className="h-full overflow-y-auto">
            <div className="space-y-1 px-2 pb-4">
              {caps.mcp.map((m, i) => (
                <button
                  key={i}
                  onClick={() => setMcpEdit(m)}
                  className="w-full rounded-md border border-border p-2 text-left hover:bg-accent"
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-medium">{m.name}</span>
                    <Badge
                      variant={m.editable ? "secondary" : "outline"}
                      className="shrink-0 px-1.5 text-[10px] font-normal"
                    >
                      {m.scope}
                    </Badge>
                  </div>
                  {m.target && <div className="mt-1 truncate text-xs text-muted-foreground">{m.target}</div>}
                </button>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="plugins" className="min-h-0 flex-1">
          <PluginList plugins={caps.plugins ?? []} />
        </TabsContent>

        <TabsContent value="analysis" className="min-h-0 flex-1">
          <AnalyticsPanel />
        </TabsContent>
      </Tabs>

      {skillEdit !== undefined && <SkillEditor skill={skillEdit} onClose={() => setSkillEdit(undefined)} />}
      {mcpEdit !== undefined && <McpEditor server={mcpEdit} onClose={() => setMcpEdit(undefined)} />}
      {market && (
        <MarketplaceDialog kind={market} session={session || undefined} chatScope={chatScope} onClose={() => setMarket(null)} onInstalled={loadCapabilities} />
      )}

      {capsLoading && rhsTab !== "analysis" && !caps.skills.length && !caps.mcp.length && (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> loading…
        </div>
      )}
    </div>
  )
}
