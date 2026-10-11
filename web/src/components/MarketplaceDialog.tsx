/**
 * MarketplaceDialog — browse and install from vetted sources: MCP tools from
 * the official MCP Registry, skills from anthropics/skills. Search → pick an
 * entry → read who publishes it, fill its inputs, choose where it applies →
 * Install. The server rebuilds the install from the source's own record.
 */
import { useEffect, useState } from "react"
import { ArrowLeft, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { api } from "@/lib/api"
import { filledValues, installNote, missingInput, type MarketKind } from "@/lib/marketplace"
import type { MarketItem } from "@/lib/types"
import { userError } from "@/lib/errors"

const SOURCE: Record<MarketKind, string> = {
  mcp: "Official MCP Registry · registry.modelcontextprotocol.io",
  skills: "Anthropic skills · github.com/anthropics/skills",
}

export function MarketplaceDialog({ kind, session, chatScope, onClose, onInstalled }: {
  kind: MarketKind
  /** The open session; offers "This project" (its folder) when present. */
  session?: string
  /** The open session is a local Claude chat — offers "This chat" (its own plugin). */
  chatScope?: boolean
  onClose: () => void
  onInstalled: () => void
}) {
  const [q, setQ] = useState("")
  const [items, setItems] = useState<MarketItem[] | null>(null)
  const [cursor, setCursor] = useState<string>()
  const [error, setError] = useState("")
  const [pick, setPick] = useState<MarketItem | null>(null)

  function search(text: string, after?: string) {
    setError("")
    if (!after) setItems(null)
    ;(kind === "mcp" ? api.marketMcp(text, after) : api.marketSkills(text))
      .then(p => { setItems(prev => (after && prev ? [...prev, ...p.items] : p.items)); setCursor(p.cursor || undefined) })
      .catch((e: Error) => setError(userError(e, "the marketplace", "search")))
  }
  // Debounced: the registry is a public service, one call per pause in typing.
  useEffect(() => {
    const h = setTimeout(() => search(q.trim()), q ? 350 : 0)
    return () => clearTimeout(h)
  }, [q, kind])

  const title = kind === "mcp" ? "MCP tools" : "Skills"
  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {pick && (
              <button aria-label="Back" onClick={() => setPick(null)} className="text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-4" />
              </button>
            )}
            {pick ? pick.title : `${title} marketplace`}
          </DialogTitle>
        </DialogHeader>
        {pick ? (
          <Install kind={kind} item={pick} session={session} chatScope={chatScope} onDone={() => { onInstalled(); onClose() }} />
        ) : (
          <>
            <Input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${title.toLowerCase()}`} />
            <p className="text-xs text-muted-foreground">{SOURCE[kind]}</p>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
              {error ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  {error} <Button variant="link" size="sm" onClick={() => search(q.trim())}>Try again</Button>
                </div>
              ) : !items ? (
                <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
              ) : !items.length ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches “{q}”.</p>
              ) : (
                <>
                  {items.map(i => (
                    <button key={i.id} onClick={() => setPick(i)} className="w-full rounded-md border border-border p-2 text-left hover:bg-accent">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate font-medium">{i.title}</span>
                        <Badge variant="outline" className="shrink-0 px-1.5 text-[10px] font-normal">{installNote(kind, i)}</Badge>
                      </div>
                      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{i.description}</div>
                    </button>
                  ))}
                  {cursor && <Button variant="ghost" size="sm" className="w-full" onClick={() => search(q.trim(), cursor)}>More</Button>}
                </>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

type Where = "all" | "project" | "chat"

function Install({ kind, item, session, chatScope, onDone }: { kind: MarketKind; item: MarketItem; session?: string; chatScope?: boolean; onDone: () => void }) {
  const inputs = item.inputs ?? []
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(inputs.map(i => [i.name, i.default || ""])))
  const [where, setWhere] = useState<Where>(session ? "project" : "all")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const installable = kind === "skills" || !!item.install

  async function install() {
    const gap = missingInput(inputs, values)
    if (gap) return setError(`${gap.name} is required.`)
    setBusy(true); setError("")
    try {
      const at = where === "all" ? {} : { session }
      if (kind === "mcp") await api.marketMcpInstall({ id: item.id, values: filledValues(values), scope: where === "all" ? "global" : where, ...at })
      else await api.marketSkillInstall({ id: item.id, scope: where === "all" ? "user" : where, ...at })
      onDone()
    } catch (e) {
      setError(userError(e, item.title, "install"))
    } finally {
      setBusy(false)
    }
  }

  const facts = [
    item.publisher && `Published by ${item.publisher}`,
    item.version && `Version ${item.version}`,
    kind === "mcp" && item.install && (item.install === "remote" ? "Runs on the publisher's servers" : `Runs on this machine via ${item.install}`),
    item.license && `License: ${item.license}`,
  ].filter(Boolean) as string[]

  return (
    <div className="min-h-0 space-y-3 overflow-y-auto text-sm">
      <p>{item.description}</p>
      <div className="space-y-0.5 text-xs text-muted-foreground">
        {facts.map(f => <div key={f}>{f}</div>)}
        {item.repo && <a href={item.repo} target="_blank" rel="noreferrer" className="block truncate text-primary hover:underline">{item.repo}</a>}
      </div>
      {!installable ? (
        <p>This server ships only as a Docker image or bundle. Harman installs npm, PyPI and hosted servers; add it by hand from its repository.</p>
      ) : (
        <>
          {inputs.map(i => (
            <label key={i.name} className="block space-y-1">
              <span className="font-medium">{i.name}{i.required && " *"}</span>
              {i.description && <span className="block text-xs text-muted-foreground">{i.description}</span>}
              <Input type={i.secret ? "password" : "text"} autoComplete="off" value={values[i.name]}
                onChange={e => setValues(v => ({ ...v, [i.name]: e.target.value }))} />
            </label>
          ))}
          <div className="flex items-center gap-2">
            <span className="font-medium">Available to</span>
            <Button size="sm" variant={where === "all" ? "default" : "outline"} onClick={() => setWhere("all")}>All sessions</Button>
            {session && <Button size="sm" variant={where === "project" ? "default" : "outline"} onClick={() => setWhere("project")}>This project</Button>}
            {session && chatScope && <Button size="sm" variant={where === "chat" ? "default" : "outline"} onClick={() => setWhere("chat")}>This chat</Button>}
          </div>
          {error && <p className="text-destructive">{error}</p>}
          <Button className="w-full" disabled={busy} onClick={install}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : "Install"}
          </Button>
          {kind === "mcp" && <p className="text-center text-xs text-muted-foreground">An MCP tool is code your agents can run. Install only what you trust.</p>}
        </>
      )}
    </div>
  )
}
