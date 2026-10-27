import { useEffect, useState } from "react"
import { userError } from "@/lib/errors"
import { Plus, Loader2, Store, MoreVertical, Eye, Pencil, Trash2 } from "lucide-react"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Markdown } from "@/components/Markdown"
import { stripFrontmatter } from "@/lib/markdown"
import { api } from "@/lib/api"
import { useStore } from "@/store"
import type { MarketKind } from "@/lib/marketplace"
import type { McpServer, Plugin, Skill } from "@/lib/types"
import { MarketplaceDialog } from "@/components/lazyDialogs"
import { McpPanel } from "@/components/McpPanel"

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

/** How a skill/MCP dialog opens: rendered (view), straight into the editor
 *  (edit), or with the delete confirmation already asked (delete). */
type Mode = "view" | "edit" | "delete"
type Open<T> = { item: T | null; mode: Mode }

/** The ⋮ on a skill/MCP row. A read-only item (from a plugin or the machine)
 *  can only be viewed, so Edit is disabled and Delete absent. */
function ItemMenu({ label, editable, onPick }: { label: string; editable: boolean; onPick: (m: Mode) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="m-1 size-7 shrink-0" aria-label={`${label} actions`}>
          <MoreVertical className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuItem onClick={() => onPick("view")}>
          <Eye /> View
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!editable} onClick={() => onPick("edit")}>
          <Pencil /> Edit
        </DropdownMenuItem>
        {editable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => onPick("delete")}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The footer shared by both dialogs: a two-step Delete (every delete confirms
 *  first), Close, and Save/Cancel while editing an existing item. */
function EditorFooter({
  editable, confirmDel, setConfirmDel, onDelete, editing, onCancelEdit, onSave, onClose,
}: {
  editable: boolean; confirmDel: boolean; setConfirmDel: (v: boolean) => void; onDelete: () => void
  editing: boolean; onCancelEdit?: () => void; onSave: () => void; onClose: () => void
}) {
  if (confirmDel)
    return (
      <DialogFooter className="items-center">
        <span className="mr-auto text-sm">Delete this for good? It cannot be undone.</span>
        <Button variant="ghost" onClick={() => setConfirmDel(false)}>Cancel</Button>
        <Button variant="destructive" onClick={onDelete}>Delete</Button>
      </DialogFooter>
    )
  return (
    <DialogFooter>
      {editable && (
        <Button variant="ghost" className="mr-auto text-destructive" onClick={() => setConfirmDel(true)}>
          Delete
        </Button>
      )}
      {editing && onCancelEdit ? (
        <Button variant="outline" onClick={onCancelEdit}>Cancel</Button>
      ) : (
        <Button variant="outline" onClick={onClose}>Close</Button>
      )}
      {editing && <Button onClick={onSave}>Save</Button>}
    </DialogFooter>
  )
}

/** The pencil beside a rendered item's title: switches the dialog to its editor. */
function EditPencil({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon" className="size-7" aria-label="Edit" title="Edit" onClick={onClick}>
      <Pencil className="size-3.5" />
    </Button>
  )
}

function SkillEditor({ skill, mode: initial, onClose }: { skill: Skill | null; mode: Mode; onClose: () => void }) {
  const session = useStore((s) => s.currentSessionPath)
  const loadCapabilities = useStore((s) => s.loadCapabilities)
  const [name, setName] = useState(skill?.name ?? "")
  const chatScope = useChatScope()
  // An existing skill saves back where it lives (user, project or this chat).
  const [scope, setScope] = useState<"user" | "project" | "chat">(
    skill?.source === "project" || skill?.source === "chat" ? skill.source : "user"
  )
  const [saved, setSaved] = useState<string | null>(skill ? null : NEW_SKILL)
  const [content, setContent] = useState<string | null>(skill ? null : NEW_SKILL)
  const [err, setErr] = useState("")
  const editable = !skill || skill.editable
  // A new skill has nothing to render yet; a read-only one never edits.
  const [editing, setEditing] = useState(!skill || (initial === "edit" && editable))
  const [confirmDel, setConfirmDel] = useState(initial === "delete" && editable)

  useEffect(() => {
    if (!skill) return
    let alive = true
    api
      .skill(skill.path)
      .then((d: any) => alive && (setSaved(d.error ? "" : d.content), setContent(d.error ? "" : d.content)))
      .catch((e) => alive && (setSaved(""), setContent(""), setErr(userError(e, "the skill", "load"))))
    return () => { alive = false }
  }, [skill])

  async function save() {
    setErr("")
    try {
      const res = await api.skillSave({ name, scope, content: content ?? "", session })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      loadCapabilities()
      if (!skill) return onClose()
      setSaved(content)
      setEditing(false)
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
          <DialogTitle className="flex items-center gap-2">
            {skill ? `/${skill.name}` : "New skill"}
            {skill && <Badge variant="secondary" className="font-normal">{skill.source}</Badge>}
            {skill && !editable && <span className="text-xs font-normal text-muted-foreground">read-only</span>}
            {skill && editable && !editing && !confirmDel && <EditPencil onClick={() => setEditing(true)} />}
          </DialogTitle>
        </DialogHeader>
        {!skill && (
          <div className="flex items-center gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="skill-name" />
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
          </div>
        )}
        {editing ? (
          <Textarea
            value={content ?? ""}
            onChange={(e) => setContent(e.target.value)}
            className="h-[60vh] font-mono text-xs"
            placeholder={content === null ? "Loading…" : ""}
          />
        ) : (
          <div className="max-h-[60vh] min-h-24 overflow-y-auto">
            {skill?.description && <p className="mb-3 text-sm text-muted-foreground">{skill.description}</p>}
            {saved === null ? (
              <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Loading…
              </div>
            ) : (
              <Markdown text={stripFrontmatter(saved) || "_This skill has no instructions yet._"} />
            )}
          </div>
        )}
        {err && <div className="text-xs text-destructive">{err}</div>}
        <EditorFooter
          editable={!!skill?.editable}
          confirmDel={confirmDel}
          setConfirmDel={setConfirmDel}
          onDelete={del}
          editing={editing}
          onCancelEdit={skill ? () => (setContent(saved), setEditing(false), setErr("")) : undefined}
          onSave={save}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  )
}

function McpEditor({ server, mode: initial, onClose }: { server: McpServer | null; mode: Mode; onClose: () => void }) {
  const session = useStore((s) => s.currentSessionPath)
  const loadCapabilities = useStore((s) => s.loadCapabilities)
  const [name, setName] = useState(server?.name ?? "")
  const chatScope = useChatScope()
  const [scope, setScope] = useState<string>(
    server?.scope === "global" || server?.scope === "chat" ? server.scope : "project"
  )
  const [saved, setSaved] = useState(
    JSON.stringify(server ? server.config : { command: "npx", args: ["-y", "some-mcp-server"], env: {} }, null, 2)
  )
  const [cfg, setCfg] = useState(saved)
  const [err, setErr] = useState("")
  const editable = !server || server.editable
  const [editing, setEditing] = useState(!server || (initial === "edit" && editable))
  const [confirmDel, setConfirmDel] = useState(initial === "delete" && editable)

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
      if (!server) return onClose()
      setSaved(cfg)
      setEditing(false)
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
          <DialogTitle className="flex items-center gap-2">
            {server ? server.name : "Add MCP server"}
            {server && <Badge variant="secondary" className="font-normal">{server.scope}</Badge>}
            {server && !editable && <span className="text-xs font-normal text-muted-foreground">read-only</span>}
            {server && editable && !editing && !confirmDel && <EditPencil onClick={() => setEditing(true)} />}
          </DialogTitle>
        </DialogHeader>
        {!server && (
          <div className="flex items-center gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="server-name" />
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
          </div>
        )}
        {editing ? (
          <Textarea value={cfg} onChange={(e) => setCfg(e.target.value)} className="h-56 font-mono text-xs" />
        ) : (
          <div className="max-h-[60vh] overflow-y-auto">
            {server && (server.transport || server.target) && (
              <p className="mb-2 text-sm text-muted-foreground">
                {[server.transport, server.target].filter(Boolean).join(" · ")}
              </p>
            )}
            <Markdown text={"```json\n" + saved + "\n```"} />
          </div>
        )}
        {err && <div className="text-xs text-destructive">{err}</div>}
        <EditorFooter
          editable={!!server?.editable}
          confirmDel={confirmDel}
          setConfirmDel={setConfirmDel}
          onDelete={del}
          editing={editing}
          onCancelEdit={server ? () => (setCfg(saved), setEditing(false), setErr("")) : undefined}
          onSave={save}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  )
}

/** A chat's plugins: Manager's own (add/remove per chat; "Included" = its agent
 *  brings it by default) and the Mac's enabled Claude plugins (read-only — they
 *  are turned on in Claude Code itself). A plugin is whole: add or remove, never edit.
 *  The agent is the hub for its setup (edited on the agent); "Keep on agent" copies
 *  this chat's setup onto it. */
function PluginList({ plugins, agent }: { plugins: Plugin[]; agent?: { id: number; name: string } }) {
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

  const [kept, setKept] = useState(false)

  async function keepOnAgent() {
    if (!agent || !window.confirm(`Every new ${agent.name} chat will start with this chat's plugins, skills and MCP tools. This replaces what ${agent.name} kept before; chats already running are not changed.`)) return
    setBusy("agent"); setErr("")
    try {
      await api.chatSaveToAgent(session)
      setKept(true)
      await loadCapabilities()
    } catch (e) {
      setErr(userError(e, `this setup on ${agent.name}`, "keep"))
    } finally {
      setBusy("")
    }
  }

  const shipped = plugins.filter((p) => p.source === "agent")
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
        {chatScope && agent && (
          <div className="flex items-center gap-2 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1">{kept ? `Saved: new ${agent.name} chats start with this setup.` : `Started from ${agent.name}. Keep this chat's plugins, skills and MCP for its next chats?`}</span>
            <Button size="sm" variant="outline" disabled={!!busy} data-testid="keep-on-agent" onClick={keepOnAgent}>Keep on agent</Button>
          </div>
        )}
        {shipped.map((p) => (
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
  const [skillOpen, setSkillOpen] = useState<Open<Skill> | null>(null)
  const [mcpOpen, setMcpOpen] = useState<Open<McpServer> | null>(null)
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
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setSkillOpen({ item: null, mode: "edit" })}>
                <Plus className="size-3.5" /> New
              </Button>
            </div>
          </div>
          <div className="h-full overflow-y-auto">
            <div className="space-y-1 px-2 pb-4">
              {caps.skills.map((s, i) => (
                <div key={i} className="flex items-start rounded-md border border-border hover:bg-accent">
                  <button onClick={() => setSkillOpen({ item: s, mode: "view" })} className="min-w-0 flex-1 p-2 pr-0 text-left">
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
                  <ItemMenu label={`/${s.name}`} editable={s.editable} onPick={(mode) => setSkillOpen({ item: s, mode })} />
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="mcp" className="min-h-0 flex-1">
          <McpPanel
            onOpen={(item, mode) => setMcpOpen({ item, mode })}
            menu={(m) => <ItemMenu label={m.name} editable={m.editable} onPick={(mode) => setMcpOpen({ item: m, mode })} />}
            onBrowse={local ? () => setMarket("mcp") : undefined}
          />
        </TabsContent>

        <TabsContent value="plugins" className="min-h-0 flex-1">
          <PluginList plugins={caps.plugins ?? []} agent={caps.agent} />
        </TabsContent>
      </Tabs>

      {skillOpen && <SkillEditor skill={skillOpen.item} mode={skillOpen.mode} onClose={() => setSkillOpen(null)} />}
      {mcpOpen && <McpEditor server={mcpOpen.item} mode={mcpOpen.mode} onClose={() => setMcpOpen(null)} />}
      {market && (
        <MarketplaceDialog kind={market} session={session || undefined} chatScope={chatScope} onClose={() => setMarket(null)} onInstalled={loadCapabilities} />
      )}

      {capsLoading && !caps.skills.length && !caps.mcp.length && (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> loading…
        </div>
      )}
    </div>
  )
}
