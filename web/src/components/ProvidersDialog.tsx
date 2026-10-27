import { useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Loader2, Plus, RefreshCw, Server, Sparkles, Trash2, X } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { api } from "@/lib/api"
import { useStore } from "@/store"
import type { Provider } from "@/lib/types"
import {
  SOURCE_LABEL,
  editRows,
  effectiveWindow,
  formatTokens,
  mergeDiscovered,
  overrideError,
  overridesPayload,
  sortRows,
  type EditRow,
  type KeyAction,
} from "@/lib/providerModels"
import { userError } from "@/lib/errors"

type Draft = {
  id: string
  name: string
  baseUrl: string
  savedUrl: string
  keyAction: KeyAction
  apiKey: string
  model: string // the default model
  rows: EditRow[]
}

const KEY_LABEL: Record<KeyAction, string> = { keep: "Keep saved key", replace: "Set new key", remove: "No key" }

/**
 * The GLOBAL connection library — the single home for provider CRUD; a chat only
 * SELECTS from it (AISelectionDialog). A connection is an endpoint + key that
 * serves many models. Each model has its own context window: the endpoint
 * reports it where it can, and the owner may override it per model. Backed by
 * /api/providers (Postgres); the server learns discovered limits.
 */
export function ProvidersDialog({ onClose }: { onClose: () => void }) {
  const providers = useStore((s) => s.providers)
  const loadProviders = useStore((s) => s.loadProviders)

  const [editing, setEditing] = useState<Draft | null>(null)
  const [newModel, setNewModel] = useState("")
  const [discovering, setDiscovering] = useState(false)
  const [discoveryNote, setDiscoveryNote] = useState("")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState("")
  const [confirmDelete, setConfirmDelete] = useState(false)
  const generation = useRef(0) // drops a discovery that finishes after the draft changed

  useEffect(() => {
    loadProviders()
  }, [loadProviders])

  function openEditor(p?: Provider) {
    generation.current++
    setErr("")
    setDiscoveryNote("")
    setDiscovering(false)
    setNewModel("")
    setConfirmDelete(false)
    setEditing(
      p
        ? { id: p.id, name: p.name, baseUrl: p.baseUrl, savedUrl: p.baseUrl, keyAction: "keep", apiKey: "", model: p.model, rows: editRows(p.models) }
        : { id: "", name: "", baseUrl: "", savedUrl: "", keyAction: "remove", apiKey: "", model: "", rows: [] }
    )
  }

  function patch(change: Partial<Draft>) {
    setEditing((d) => (d ? { ...d, ...change } : d))
  }

  /** Endpoint or key edits invalidate an in-flight discovery. */
  function patchConnection(change: Partial<Draft>) {
    generation.current++
    setDiscovering(false)
    patch(change)
  }

  function setRow(id: string, change: Partial<EditRow>) {
    setEditing((d) => (d ? { ...d, rows: d.rows.map((r) => (r.id === id ? { ...r, ...change } : r)) } : d))
  }

  const urlChanged = !!editing?.id && editing.baseUrl.trim().replace(/\/+$/, "") !== editing.savedUrl
  const keyProblem =
    editing && urlChanged && editing.keyAction === "keep"
      ? "The endpoint changed: set a new key or choose No key, so the saved key never goes to another server."
      : editing?.keyAction === "replace" && !editing.apiKey.trim()
        ? "Enter the new key, or choose another option."
        : ""

  function connection(d: Draft) {
    return {
      id: d.id || undefined,
      baseUrl: d.baseUrl.trim(),
      apiKeyAction: d.keyAction,
      ...(d.keyAction === "replace" ? { apiKey: d.apiKey.trim() } : {}),
    }
  }

  async function discover() {
    if (!editing || keyProblem) return
    const request = ++generation.current
    setDiscovering(true)
    setDiscoveryNote("")
    try {
      const r = await api.providerDraftModels(connection(editing))
      if (request !== generation.current) return
      if (r.status === "ok") {
        setEditing((d) => (d ? { ...d, rows: mergeDiscovered(d.rows, r.choices), model: d.model || r.choices[0]?.id || "" } : d))
        const known = r.choices.filter((c) => c.contextWindow).length
        setDiscoveryNote(
          `${r.choices.length} model${r.choices.length === 1 ? "" : "s"} found` +
            (known === r.choices.length ? "." : `; the endpoint reports a context window for ${known}. Set the rest yourself if you know them.`)
        )
      } else {
        setDiscoveryNote(
          r.status === "error" ? r.error || "Discovery failed." : "The endpoint did not list any models. Add a model by its ID below."
        )
      }
    } catch (e: any) {
      if (request === generation.current) setDiscoveryNote(userError(e, "the endpoint's models", "list"))
    } finally {
      if (request === generation.current) setDiscovering(false)
    }
  }

  function addModel() {
    const id = newModel.trim()
    if (!editing || !id) return
    if (!editing.rows.some((r) => r.id === id)) patch({ rows: [...editing.rows, { id, discovered: 0, maxOutput: 0, override: "" }] })
    if (!editing.model) patch({ model: id })
    setNewModel("")
  }

  function removeRow(id: string) {
    if (!editing) return
    const rows = editing.rows.filter((r) => r.id !== id)
    patch({ rows, model: editing.model === id ? rows[0]?.id || "" : editing.model })
  }

  const rowErrors = editing ? editing.rows.some((r) => overrideError(r.override)) : false
  const canSave = !!editing && !!editing.baseUrl.trim() && !!editing.model && !keyProblem && !rowErrors && !saving

  async function save() {
    if (!editing || !canSave) return
    setErr("")
    setSaving(true)
    try {
      await api.providerSave({
        ...connection(editing),
        name: editing.name.trim() || editing.baseUrl.trim(),
        model: editing.model,
        modelOverrides: overridesPayload(editing.rows),
      })
      await loadProviders()
      setEditing(null)
    } catch (e: any) {
      setErr(userError(e, "the provider", "save"))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!editing?.id) return
    const r = await api.providerDelete(editing.id).catch(() => ({ deleted: false }))
    if (!r.deleted) {
      setErr("The server did not confirm the delete.")
      return
    }
    await loadProviders()
    setEditing(null)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Model providers</DialogTitle>
          <DialogDescription>
            A provider is a connection to a model server. It can serve many models, and each model has its own
            context window. Chats pick a provider and model in their AI settings.
          </DialogDescription>
        </DialogHeader>

        {!editing ? (
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card/40 px-3 py-2.5">
              <Sparkles className="size-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Built-in (Claude)</div>
                <div className="text-xs text-muted-foreground">Your Claude login. Always available.</div>
              </div>
              <Badge variant="secondary">built-in</Badge>
            </div>

            {providers.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">No connections yet.</p>}
            {providers.map((p) => {
              const models = p.models || []
              const known = models.filter((m) => m.contextWindow).length
              const window = models.find((m) => m.id === p.model)?.contextWindow || 0
              return (
                <button
                  key={p.id}
                  data-testid={`provider-${p.id}`}
                  onClick={() => openEditor(p)}
                  className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
                >
                  <Server className="size-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{p.name}</span>
                      {p.isDefault && <Badge variant="outline">new-chat default</Badge>}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{p.baseUrl}</div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      Default model <span className="font-mono text-foreground/80">{p.model}</span>
                      {" · "}
                      {window ? `${formatTokens(window)} context` : "context unknown"}
                      {models.length > 1 && ` · ${models.length} models, ${known} with a known window`}
                    </div>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              )
            })}

            <Button variant="outline" size="sm" className="mt-1 gap-1 self-start" onClick={() => openEditor()}>
              <Plus className="size-3.5" /> Add connection
            </Button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
            <button
              className="flex items-center gap-1 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setEditing(null)}
            >
              <ChevronLeft className="size-4" /> All connections
            </button>

            {/* ---- Connection ---- */}
            <section className="flex flex-col gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Connection</h3>
              <Field label="Name">
                <Input
                  className="h-8 text-sm"
                  placeholder="e.g. Home GPU server"
                  value={editing.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>
              <Field label="Endpoint URL" hint="The server's base URL. Harman calls /v1/models and /v1/messages under it.">
                <Input
                  className="h-8 font-mono text-xs"
                  placeholder="https://models.example.com"
                  value={editing.baseUrl}
                  onChange={(e) => patchConnection({ baseUrl: e.target.value })}
                  spellCheck={false}
                  autoCapitalize="none"
                />
              </Field>
              <Field label="API key" hint="Stored on the server; never shown again.">
                <div className="flex flex-col gap-2">
                  <div className="inline-flex w-fit rounded-md border border-border p-0.5" role="radiogroup" aria-label="API key">
                    {(["keep", "replace", "remove"] as KeyAction[])
                      .filter((a) => editing.id || a !== "keep")
                      .map((a) => (
                        <button
                          key={a}
                          role="radio"
                          aria-checked={editing.keyAction === a}
                          onClick={() => patchConnection({ keyAction: a })}
                          className={
                            "rounded px-2.5 py-1 text-xs transition-colors " +
                            (editing.keyAction === a ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground")
                          }
                        >
                          {KEY_LABEL[a]}
                        </button>
                      ))}
                  </div>
                  {editing.keyAction === "replace" && (
                    <Input
                      className="h-8 font-mono text-xs"
                      type="password"
                      placeholder="sk-…"
                      value={editing.apiKey}
                      onChange={(e) => patchConnection({ apiKey: e.target.value })}
                      spellCheck={false}
                      autoCapitalize="none"
                      autoComplete="off"
                    />
                  )}
                  {keyProblem && <p className="text-xs text-destructive">{keyProblem}</p>}
                </div>
              </Field>
            </section>

            {/* ---- Models ---- */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Models</h3>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5"
                  disabled={!editing.baseUrl.trim() || !!keyProblem || discovering}
                  onClick={discover}
                >
                  {discovering ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                  {editing.rows.some((r) => r.discovered) ? "Refresh from endpoint" : "Discover models"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The context window is per model. Harman uses it to compact a chat before it overflows. Leave the
                override blank to use what the endpoint reports.
              </p>
              {discoveryNote && <p className="text-xs text-muted-foreground" role="status">{discoveryNote}</p>}

              {editing.rows.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="w-16 px-3 py-2 font-medium">Default</th>
                        <th className="px-3 py-2 font-medium">Model</th>
                        <th className="w-28 px-3 py-2 text-right font-medium">Context</th>
                        <th className="w-32 px-3 py-2 font-medium">Override</th>
                        <th className="w-9" />
                      </tr>
                    </thead>
                    <tbody>
                      {sortRows(editing.rows, editing.model).map((r) => {
                        const eff = effectiveWindow(r)
                        const bad = overrideError(r.override)
                        return (
                          <tr key={r.id} className="border-t border-border align-middle" data-testid={`model-row-${r.id}`}>
                            <td className="px-3 py-1.5">
                              <input
                                type="radio"
                                name="default-model"
                                aria-label={`Use ${r.id} by default`}
                                checked={editing.model === r.id}
                                onChange={() => patch({ model: r.id })}
                                className="size-3.5 accent-primary"
                              />
                            </td>
                            <td className="max-w-0 px-3 py-1.5">
                              <div className="truncate font-mono text-xs" title={r.id}>{r.id}</div>
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              <div className="tabular-nums">{formatTokens(eff.tokens)}</div>
                              <div className={"text-[11px] " + (eff.source ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400")}>
                                {SOURCE_LABEL[eff.source]}
                              </div>
                            </td>
                            <td className="px-3 py-1.5">
                              <Input
                                className={"h-7 text-xs tabular-nums " + (bad ? "border-destructive" : "")}
                                placeholder={r.discovered ? formatTokens(r.discovered) : "e.g. 128k"}
                                value={r.override}
                                aria-label={`Context override for ${r.id}`}
                                aria-invalid={!!bad}
                                title={bad || "Tokens, e.g. 128000, 128k or 1m"}
                                onChange={(e) => setRow(r.id, { override: e.target.value })}
                              />
                            </td>
                            <td className="pr-2">
                              {!r.discovered && (
                                <button
                                  className="rounded p-1 text-muted-foreground hover:text-destructive"
                                  aria-label={`Remove ${r.id}`}
                                  title="Remove this model"
                                  onClick={() => removeRow(r.id)}
                                >
                                  <X className="size-3.5" />
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {rowErrors && <p className="text-xs text-destructive">Use a token count like 128000, 128k or 1m.</p>}

              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  addModel()
                }}
              >
                <Input
                  className="h-8 flex-1 font-mono text-xs"
                  placeholder="Add a model by ID (e.g. qwen3.8-27b)"
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  spellCheck={false}
                  autoCapitalize="none"
                />
                <Button type="submit" variant="outline" size="sm" className="h-8 gap-1" disabled={!newModel.trim()}>
                  <Plus className="size-3.5" /> Add
                </Button>
              </form>
              {!editing.model && <p className="text-xs text-muted-foreground">Discover or add at least one model, and pick the default.</p>}
            </section>

            {err && <div className="text-xs text-destructive" role="alert">{err}</div>}

            <div className="flex items-center gap-2 border-t border-border pt-3">
              <Button size="sm" className="h-8" disabled={!canSave} onClick={save}>
                {saving && <Loader2 className="size-3.5 animate-spin" />} Save
              </Button>
              <Button variant="ghost" size="sm" className="h-8" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              {editing.id && (
                <div className="ml-auto flex items-center gap-2">
                  {confirmDelete ? (
                    <>
                      <span className="text-xs text-muted-foreground">Chats using it need another provider.</span>
                      <Button variant="destructive" size="sm" className="h-8" onClick={remove}>
                        Delete
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8" onClick={() => setConfirmDelete(false)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button variant="ghost" size="sm" className="h-8 gap-1 text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                      <Trash2 className="size-3.5" /> Delete connection
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {!editing && (
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[8rem_1fr] sm:items-start sm:gap-3">
      <div className="pt-1.5 text-xs font-medium">{label}</div>
      <div className="flex min-w-0 flex-col gap-1">
        {children}
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
    </div>
  )
}
