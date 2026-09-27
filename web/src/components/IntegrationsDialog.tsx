import { useEffect, useState } from "react"
import { Check, Copy, Loader2, Trash2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import type { DriveClient } from "@/lib/types"

type Draft = { kind: string; client_id: string; client_secret: string }

/**
 * IntegrationsDialog — where the owner enters Harman's OWN OAuth client for
 * each cloud-drive vendor (one per vendor, shared by every drive of that
 * kind). Opened from the location picker when a vendor has no client yet, or
 * when a connect attempt is refused for that reason. Shows the one string the
 * vendor console needs — this deployment's redirect URI — so setup is
 * copy/paste, not a server file. The secret is write-only: the server reports
 * only whether one is stored, and a save with the field blank keeps it.
 */
export function IntegrationsDialog({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [clients, setClients] = useState<DriveClient[] | null>(null)
  const [redirectUri, setRedirectUri] = useState("")
  const [editing, setEditing] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const r = await api.driveClients()
    setClients(r.clients || [])
    setRedirectUri(r.redirect_uri || "")
  }
  useEffect(() => { load().catch((e) => setError(e?.message || String(e))) }, [])

  function apply(r: { clients: DriveClient[]; redirect_uri: string } | { error?: string }) {
    if ("error" in r && r.error) throw new Error(r.error)
    if ("clients" in r) {
      setClients(r.clients)
      setRedirectUri(r.redirect_uri)
    }
    onChanged?.()
  }

  async function save() {
    if (!editing) return
    setBusy(true)
    setError(null)
    try {
      const body: { kind: string; client_id: string; client_secret?: string } = {
        kind: editing.kind, client_id: editing.client_id.trim(),
      }
      if (editing.client_secret.trim()) body.client_secret = editing.client_secret.trim()
      apply(await api.driveClientSave(body))
      setEditing(null)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
    setBusy(false)
  }

  async function remove(c: DriveClient) {
    if (!window.confirm(`Forget the ${c.label} client? Existing ${c.label} drives stay listed but cannot connect or refresh until a client is entered again.`)) return
    setError(null)
    try {
      apply(await api.driveClientDelete(c.kind))
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  async function copyUri() {
    try {
      await navigator.clipboard.writeText(redirectUri)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked: the URI is still selectable text */
    }
  }

  const current = editing ? clients?.find((c) => c.kind === editing.kind) : undefined

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Integrations</DialogTitle>
          <DialogDescription>
            Each cloud-drive vendor needs one OAuth client that identifies this Harman to it. Create
            the client in the vendor's developer console with the redirect URI below, then paste its
            id (and secret, where the vendor issues one) here. Every drive of that kind shares it.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/40 p-2 text-xs">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Redirect URI to register with each vendor
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all font-mono">{redirectUri || "…"}</code>
            <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={copyUri} disabled={!redirectUri} title="Copy">
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          </div>
        </div>

        {clients === null ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : editing ? (
          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {current?.label} client
            </div>
            <Input
              className="h-8 font-mono text-xs"
              placeholder={current?.public ? "App key / Application (client) ID" : "Client ID"}
              value={editing.client_id}
              onChange={(e) => setEditing((d) => (d ? { ...d, client_id: e.target.value } : d))}
              spellCheck={false}
              autoCapitalize="none"
              autoFocus
            />
            {!current?.public && (
              <Input
                className="h-8 font-mono text-xs"
                type="password"
                placeholder={current?.has_secret ? "Client secret (leave blank to keep current)" : "Client secret"}
                value={editing.client_secret}
                onChange={(e) => setEditing((d) => (d ? { ...d, client_secret: e.target.value } : d))}
                spellCheck={false}
                autoCapitalize="none"
              />
            )}
            {current?.public && (
              <p className="text-xs text-muted-foreground">
                {current.label} uses a public PKCE client — no secret is issued or needed.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
              <Button size="sm" onClick={save} disabled={busy || !editing.client_id.trim()}>
                {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />} Save
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col divide-y rounded-md border">
            {clients.map((c) => (
              <div key={c.kind} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{c.label}</span>
                    <span className={`text-[10px] ${c.configured ? "text-emerald-600" : "text-muted-foreground"}`}>
                      {c.configured ? "ready" : c.client_id ? "secret missing" : "not set up"}
                    </span>
                  </div>
                  {c.client_id && (
                    <div className="truncate font-mono text-[11px] text-muted-foreground" title={c.client_id}>
                      {c.client_id}
                    </div>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setEditing({ kind: c.kind, client_id: c.client_id, client_secret: "" })}
                >
                  {c.client_id ? "Edit" : "Set up"}
                </Button>
                {c.client_id && (
                  <button className="text-muted-foreground hover:text-destructive" onClick={() => remove(c)} title="Forget client">
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
