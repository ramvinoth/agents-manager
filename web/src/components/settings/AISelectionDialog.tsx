import { useEffect, useRef, useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { useStore } from "@/store"
import {
  aiError,
  discoveryHint,
  modelChoices,
  sameAI,
  selectionProblem,
  switchAIProvider,
  type AICapabilities,
  type AIConfig,
  type AIScope,
  type AISelection,
  type ModelDiscovery,
} from "@/lib/aiSelection"
import { ProvidersDialog } from "../ProvidersDialog"

// Radix Select forbids an empty-string item value, so Claude — whose real
// provider id is "" — uses this sentinel in the dropdown only.
const CLAUDE = "__claude__"

const EFFORT_LABELS: Record<string, string> = {
  "": "Default",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
}

/**
 * The AI selection editor — provider, conversation mode, effort and model — as
 * ONE staged transaction against the server-owned selection (viewer/ai.py).
 * Serves both scopes: a session ("AI for this chat") and the per-user new-chat
 * defaults (Profile tab). Nothing is written until Save; the server validates
 * and compare-and-swaps on `revision`, so two people editing the same thing
 * can't silently overwrite each other (409 → keep the draft, ask to reopen).
 *
 * Capabilities (which modes/efforts exist) depend on the provider being tried,
 * so they are re-fetched for the DRAFT, not the stored selection. Model
 * discovery hits the provider's /v1/models through the server; the key never
 * reaches the browser.
 */
export function AISelectionDialog({
  scope,
  title,
  hint,
  onSaved,
  onClose,
}: {
  scope: AIScope
  title: string
  /** Who the change reaches — the one sentence a person needs before saving. */
  hint: string
  onSaved: (config: AIConfig) => void
  onClose: () => void
}) {
  const providers = useStore((s) => s.providers)
  const [config, setConfig] = useState<AIConfig | null>(null)
  const [loadError, setLoadError] = useState("")
  const [draft, setDraft] = useState<AISelection | null>(null)
  const [caps, setCaps] = useState<AICapabilities | null>(null)
  const [capBusy, setCapBusy] = useState(false)
  const [capError, setCapError] = useState("")
  const [discovery, setDiscovery] = useState<ModelDiscovery | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [retry, setRetry] = useState(0)
  const [search, setSearch] = useState("")
  const [saveError, setSaveError] = useState("")
  const [busy, setBusy] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  // Per-provider drafts, so switching away and back restores what was typed.
  const history = useRef(new Map<string, AISelection>())

  useEffect(() => {
    let alive = true
    api
      .aiConfig(scope)
      .then((c) => {
        if (!alive) return
        setConfig(c)
        setDraft(c.selection)
        setCaps(c.capabilities)
      })
      .catch((e) => alive && setLoadError(aiError(e)))
    return () => {
      alive = false
    }
  }, [scope.id, scope.host, scope.agent])

  // Capabilities follow the draft's provider/mode, not the stored selection.
  useEffect(() => {
    if (!draft || !config) return
    let alive = true
    setCapBusy(true)
    setCapError("")
    api
      .aiConfig(scope, draft)
      .then((r) => alive && setCaps(r.capabilities))
      .catch((e) => alive && setCapError(aiError(e)))
      .finally(() => alive && setCapBusy(false))
    return () => {
      alive = false
    }
  }, [config, draft?.provider, draft?.convMode, retry])

  useEffect(() => {
    if (!draft) return
    let alive = true
    setDiscovery(null)
    setDiscovering(true)
    api
      .providerModels({ id: draft.provider })
      .then((r) => alive && setDiscovery(r))
      .catch((e) => alive && setDiscovery({ models: [], choices: [], status: "error", source: "endpoint", manualModelId: true, error: aiError(e) }))
      .finally(() => alive && setDiscovering(false))
    return () => {
      alive = false
    }
  }, [draft?.provider, retry])

  const dirty = !!config && !!draft && !sameAI(config.selection, draft)
  // Defaults that were never saved must be saveable as-is: "configured: false"
  // means new chats fall back to server rules, and saving pins the visible values.
  const needsFirstSave = !scope.id && config?.configured === false
  const problem = draft ? selectionProblem(draft, caps, providers) : null
  const canSave = !!draft && (dirty || needsFirstSave) && !problem && !capBusy && !capError && !busy

  function pickProvider(id: string) {
    if (!draft || id === draft.provider) return
    history.current.set(draft.provider, draft)
    setDraft(switchAIProvider(draft, id, history.current.get(id)))
    setSearch("")
    setSaveError("")
  }

  async function save() {
    if (!canSave || !config || !draft) return
    setBusy(true)
    setSaveError("")
    try {
      const result = await api.aiSave(scope, config.revision, draft)
      onSaved(result)
      onClose()
    } catch (e) {
      setSaveError(aiError(e))
    } finally {
      setBusy(false)
    }
  }

  function close() {
    if (busy) return
    if (dirty && !window.confirm("Discard your changes? The saved AI settings are unchanged.")) return
    onClose()
  }

  const manualId = draft?.model?.kind === "id" ? draft.model.id : ""
  const choices = draft ? modelChoices(discovery, draft.model, search) : []
  const message = saveError || capError || problem || loadError

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{hint}</DialogDescription>
        </DialogHeader>

        {!draft || !config ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            {loadError ? (
              <span className="text-destructive">{loadError}</span>
            ) : (
              <>
                <Loader2 className="size-4 animate-spin" /> Loading AI settings…
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {config.issue && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                Saved settings no longer work: {config.issue}
              </p>
            )}

            <Field label="Provider">
              <div className="flex gap-2">
                <Select value={draft.provider || CLAUDE} onValueChange={(v) => pickProvider(v === CLAUDE ? "" : v)}>
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={CLAUDE}>Claude (your login)</SelectItem>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id} disabled={caps ? !caps.customProviders : false}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" onClick={() => setManageOpen(true)}>
                  Manage
                </Button>
              </div>
              {caps && !caps.customProviders && (
                <Note>Custom providers are available only for Claude sessions on this machine.</Note>
              )}
            </Field>

            {draft.provider && caps && caps.conversationModes.length > 1 && (
              <Field label="Conversation mode">
                <Segmented
                  options={caps.conversationModes.map((m) => ({ value: m, label: m === "chat" ? "Chat" : "Agent" }))}
                  value={draft.convMode}
                  onChange={(m) => setDraft({ ...draft, convMode: m as AISelection["convMode"], effort: "" })}
                />
                <Note>Chat proxies messages plainly to the endpoint; Agent runs the full Claude Code harness against it.</Note>
              </Field>
            )}

            {caps && caps.efforts.length > 1 && (
              <Field label="Effort">
                <Segmented
                  options={caps.efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] || e }))}
                  value={draft.effort}
                  onChange={(e) => setDraft({ ...draft, effort: e })}
                />
                <Note>How hard the model thinks per turn. Default lets the harness decide.</Note>
              </Field>
            )}

            <Field label="Model">
              <Segmented
                options={[
                  { value: "default", label: draft.provider ? "Provider default" : "Harness default" },
                  { value: "id", label: "Specific model" },
                ]}
                value={draft.model?.kind === "id" ? "id" : "default"}
                onChange={(k) => setDraft({ ...draft, model: k === "id" ? { kind: "id", id: manualId } : { kind: "default" } })}
              />
              {draft.model?.kind === "id" && (
                <div className="mt-2 flex flex-col gap-2">
                  <Input
                    value={manualId}
                    onChange={(e) => setDraft({ ...draft, model: { kind: "id", id: e.target.value } })}
                    placeholder="Model ID, e.g. claude-sonnet-5 or qwen3-27b"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span className="min-w-0 truncate" title={discoveryHint(discovery, discovering)}>
                      {discoveryHint(discovery, discovering)}
                    </span>
                    <button
                      className="flex shrink-0 items-center gap-1 hover:text-foreground"
                      onClick={() => setRetry((r) => r + 1)}
                      disabled={discovering}
                    >
                      <RefreshCw className={cn("size-3", discovering && "animate-spin")} /> Refresh
                    </button>
                  </div>
                  {choices.length > 0 && (
                    <>
                      {choices.length > 6 && (
                        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter models" className="h-7 text-xs" />
                      )}
                      <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                        {choices.map((c) => {
                          const on = manualId === c.id
                          return (
                            <button
                              key={c.id}
                              onClick={() => setDraft({ ...draft, model: { kind: "id", id: c.id } })}
                              className={cn(
                                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent",
                                on && "bg-primary/10 text-foreground"
                              )}
                              title={c.id}
                            >
                              <span className="min-w-0 flex-1 truncate font-mono">{c.id}</span>
                              {c.label !== c.id && <span className="shrink-0 truncate text-muted-foreground">{c.label}</span>}
                            </button>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </Field>

            {message && <p className="text-xs text-destructive">{message}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>

      {manageOpen && <ProvidersDialog onClose={() => setManageOpen(false)} />}
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/70">{children}</p>
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-md border px-2.5 py-1.5 text-xs transition-colors",
              on
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
