import { useEffect, useState } from "react"
import { Loader2, Plus, Server, Sparkles, Trash2, Pencil, ChevronLeft } from "lucide-react"
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

type Draft = {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  contextLimit: string
}

/**
 * The GLOBAL provider library editor — add / edit / delete the custom model
 * endpoints (Qwen, LiteLLM, BrainTwin, …) any chat can then pick from. This is
 * the single home for provider CRUD; a session only SELECTS from this list (see
 * SettingsPanel). Backed entirely by /api/providers (server-side source of truth
 * in ~/.claude/.viewer-providers.json) — nothing is cached or hardcoded here.
 *
 * "Default (Claude)" is not a stored provider; it's the built-in Claude login
 * (provider = ""), shown as a pinned, non-editable header for orientation.
 */
export function ProvidersDialog({ onClose }: { onClose: () => void }) {
  const providers = useStore((s) => s.providers)
  const loadProviders = useStore((s) => s.loadProviders)

  const [editing, setEditing] = useState<Draft | null>(null) // null = list; Draft = editor
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [customModel, setCustomModel] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState("")
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  useEffect(() => {
    loadProviders()
  }, [loadProviders])

  // Open the editor: blank for a new preset, or pre-filled to edit one. The
  // apiKey is never returned, so the field starts empty and an empty value on
  // save means "keep the existing key".
  function openEditor(p?: Provider) {
    setErr("")
    setModelOptions([])
    setCustomModel(false)
    setEditing(
      p
        ? { id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: "", model: p.model, contextLimit: p.contextLimit ? String(p.contextLimit) : "" }
        : { id: "", name: "", baseUrl: "", apiKey: "", model: "", contextLimit: "" }
    )
  }

  // Populate the model list from the endpoint (fetched server-side so the key
  // never leaves the box). Works before the preset is saved via baseUrl+key.
  function loadModels() {
    if (!editing) return
    setLoadingModels(true)
    const q = editing.id
      ? { id: editing.id }
      : { baseUrl: editing.baseUrl.trim(), key: editing.apiKey.trim() || undefined }
    api
      .providerModels(q)
      .then((r) => {
        setModelOptions(r.models || [])
        if (!r.models?.length) setCustomModel(true)
      })
      .catch(() => setCustomModel(true))
      .finally(() => setLoadingModels(false))
  }

  async function saveProvider() {
    if (!editing) return
    const name = editing.name.trim()
    const baseUrl = editing.baseUrl.trim()
    const model = editing.model.trim()
    if (!baseUrl || !model) return
    setErr("")
    setSaving(true)
    try {
      const saved = await api.providerSave({
        id: editing.id || undefined,
        name: name || baseUrl,
        baseUrl,
        model,
        ...(editing.apiKey.trim() ? { apiKey: editing.apiKey.trim() } : {}),
        // Always send contextLimit so clearing the field (→ 0) actually clears it.
        contextLimit: Math.max(0, parseInt(editing.contextLimit.trim(), 10) || 0),
      })
      if (saved.error) {
        setErr(saved.error)
        return
      }
      await loadProviders()
      setEditing(null)
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  async function deleteProvider(id: string) {
    await api.providerDelete(id).catch(() => {})
    setConfirmDelete(null)
    if (editing?.id === id) setEditing(null)
    await loadProviders()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Model providers</DialogTitle>
          <DialogDescription>
            Providers route a session to your own model endpoint. Manage them here; pick one per chat
            in its Settings.
          </DialogDescription>
        </DialogHeader>

        {!editing ? (
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {/* Default (Claude) — the built-in login, not a stored provider. */}
            <div className="flex items-center gap-2.5 rounded-md border border-border bg-card/40 px-3 py-2">
              <Sparkles className="size-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Default (Claude)</div>
                <div className="text-[11px] text-muted-foreground">Uses your Claude login. Always available.</div>
              </div>
              <Badge variant="secondary" className="text-[10px]">built-in</Badge>
            </div>

            {providers.length === 0 && (
              <p className="px-1 text-xs italic text-muted-foreground">No custom providers yet.</p>
            )}
            {providers.map((p) => (
              <div key={p.id} className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2">
                <Server className="size-4 shrink-0 text-primary" />
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => openEditor(p)}
                  title="Edit"
                >
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{p.baseUrl}</div>
                </button>
                {confirmDelete === p.id ? (
                  <>
                    <Button variant="destructive" size="sm" className="h-7" onClick={() => deleteProvider(p.id)}>
                      Delete
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7" onClick={() => setConfirmDelete(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="ghost" size="icon" className="size-7" onClick={() => openEditor(p)} title="Edit">
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-destructive hover:text-destructive"
                      onClick={() => setConfirmDelete(p.id)}
                      title="Delete"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                )}
              </div>
            ))}

            <Button variant="outline" size="sm" className="mt-1 self-start gap-1" onClick={() => openEditor()}>
              <Plus className="size-3.5" /> Add provider
            </Button>
          </div>
        ) : (
          /* Editor — create or edit one provider. */
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <button className="hover:text-foreground" onClick={() => setEditing(null)} title="Back to list">
                <ChevronLeft className="size-4" />
              </button>
              {editing.id ? "Edit provider" : "New provider"}
            </div>

            <Input
              className="h-8 text-sm"
              placeholder="Name (e.g. Qwen 3.8-27B)"
              value={editing.name}
              onChange={(e) => setEditing((d) => (d ? { ...d, name: e.target.value } : d))}
            />
            <Input
              className="h-8 font-mono text-xs"
              placeholder="Base URL (https://inference.braintwin.ai)"
              value={editing.baseUrl}
              onChange={(e) => setEditing((d) => (d ? { ...d, baseUrl: e.target.value } : d))}
              spellCheck={false}
              autoCapitalize="none"
            />
            <Input
              className="h-8 font-mono text-xs"
              type="password"
              placeholder={editing.id ? "API key (leave blank to keep current)" : "API key (sk-…, optional)"}
              value={editing.apiKey}
              onChange={(e) => setEditing((d) => (d ? { ...d, apiKey: e.target.value } : d))}
              spellCheck={false}
              autoCapitalize="none"
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={!editing.baseUrl.trim() || loadingModels}
                onClick={loadModels}
              >
                {loadingModels ? <Loader2 className="size-3.5 animate-spin" /> : null} Load models
              </Button>
              <button
                className="text-xs font-medium text-primary"
                onClick={() => setCustomModel((c) => !c)}
              >
                {customModel ? "Pick from list" : "Enter manually"}
              </button>
            </div>

            {customModel || (!modelOptions.length && !!editing.model) ? (
              <Input
                className="h-8 font-mono text-xs"
                placeholder="Model name (e.g. qwen3.8-27b)"
                value={editing.model}
                onChange={(e) => setEditing((d) => (d ? { ...d, model: e.target.value } : d))}
                spellCheck={false}
                autoCapitalize="none"
              />
            ) : modelOptions.length ? (
              <div className="flex flex-wrap gap-1.5">
                {modelOptions.map((m) => {
                  const active = editing.model === m
                  return (
                    <button
                      key={m}
                      onClick={() => setEditing((d) => (d ? { ...d, model: m } : d))}
                      className={
                        "rounded-md border px-2 py-1 text-xs transition-colors " +
                        (active
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground")
                      }
                    >
                      {m}
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">Load models from the endpoint, or tap “Enter manually”.</p>
            )}

            <Input
              className="h-8 text-sm tabular-nums"
              inputMode="numeric"
              placeholder="Context limit (tokens, e.g. 242000)"
              value={editing.contextLimit}
              onChange={(e) => setEditing((d) => (d ? { ...d, contextLimit: e.target.value.replace(/[^0-9]/g, "") } : d))}
            />
            <p className="text-[11px] text-muted-foreground">
              The endpoint’s real max context. Lets the agent compact before overflowing it. Leave blank if unsure.
            </p>

            {err && <div className="text-xs text-destructive">{err}</div>}

            <div className="mt-1 flex items-center gap-2">
              <Button
                size="sm"
                className="h-8"
                disabled={!editing.baseUrl.trim() || !editing.model.trim() || saving}
                onClick={saveProvider}
              >
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
              </Button>
              <Button variant="ghost" size="sm" className="h-8" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
