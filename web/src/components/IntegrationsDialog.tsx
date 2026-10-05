import { useEffect, useRef, useState } from "react"
import { Check, Copy, ExternalLink, Loader2, Plus, Trash2 } from "lucide-react"
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
import { cn } from "@/lib/utils"
import { serviceAction, waitForConsent } from "@/lib/integrations"
import type { IntegrationConnection, IntegrationProvider, IntegrationService, IntegrationsView, ServiceState } from "@/lib/types"

type Draft = { provider: string; client_id: string; client_secret: string }

const STATE_TEXT: Record<ServiceState, string> = {
  on: "On",
  off: "Off",
  grant: "Grant access",
  unavailable: "Not available",
}

/**
 * IntegrationsDialog — the one place the owner connects outside accounts
 * (Google, Dropbox, Microsoft) and decides which services agents may use on
 * each: Drive/Dropbox/OneDrive files, Gmail (read + drafts, never send),
 * Calendar (read). Renders GET /api/integrations verbatim — the server owns
 * the catalog and every rule, so a new service needs no client change.
 *
 * Per provider: its OAuth client (entered once, with this deployment's
 * redirect URI to register), then each signed-in account with a row per
 * service. A granted service is an on/off switch (the grant is kept); a
 * missing one runs consent that ADDS the permission and keeps the rest; an
 * unavailable one (Google Keep) says why instead of hiding. Opened from
 * Profile → Integrations and from the file browser's location picker.
 */
export function IntegrationsDialog({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [view, setView] = useState<IntegrationsView | null>(null)
  const [editing, setEditing] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // key of the control mid-request
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [consenting, setConsenting] = useState(false) // a vendor tab is open on a consent
  const closed = useRef(false)

  useEffect(() => () => { closed.current = true }, [])

  async function load() {
    setView(await api.integrations())
  }
  useEffect(() => { load().catch((e) => setError(e?.message || String(e))) }, [])

  /** Run one request under a busy key; reload + notify the owner of the
   *  dialog on success, show the reason on failure. */
  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await load()
      onChanged?.()
    } catch (e: any) {
      if (!closed.current) setError(e?.message || String(e))
    }
    if (!closed.current) setBusy(null)
  }

  const ok = (r: { error?: string } | object) => {
    if ("error" in r && r.error) throw new Error(r.error)
  }

  function connect(service: string, connection?: string) {
    return run(`${connection || "new"}:${service}`, async () => {
      const r = await api.integrationConnect({ service, connection })
      ok(r)
      if (!("url" in r)) throw new Error("No consent URL returned")
      setConsenting(true)
      try {
        window.open(r.url, "_blank", "noopener")
        await waitForConsent(() => api.driveOAuthStatus(r.pending), undefined, () => closed.current)
      } finally {
        if (!closed.current) setConsenting(false)
      }
    })
  }

  function toggle(conn: IntegrationConnection, service: string, on: boolean) {
    return run(`${conn.id}:${service}`, async () => ok(await api.integrationService({ connection: conn.id, service, on })))
  }

  function disconnect(p: IntegrationProvider, conn: IntegrationConnection) {
    const who = conn.account || `this ${p.label} account`
    if (!window.confirm(`Disconnect ${who}? Harman forgets its access; agents lose every ${p.label} service on it. Nothing in the account itself is touched.`)) return
    return run(`${conn.id}:delete`, async () => ok(await api.driveDelete(conn.id)))
  }

  function saveClient() {
    if (!editing) return
    const body: { provider: string; client_id: string; client_secret?: string } = {
      provider: editing.provider, client_id: editing.client_id.trim(),
    }
    if (editing.client_secret.trim()) body.client_secret = editing.client_secret.trim()
    return run(`client:${editing.provider}`, async () => {
      ok(await api.integrationClientSave(body))
      setEditing(null)
    })
  }

  function forgetClient(p: IntegrationProvider) {
    if (!window.confirm(`Forget the ${p.label} client? Connected ${p.label} accounts stay listed but cannot sign in or refresh until a client is entered again.`)) return
    return run(`client:${p.id}`, async () => ok(await api.integrationClientDelete(p.id)))
  }

  async function copyUri() {
    try {
      await navigator.clipboard.writeText(view?.redirect_uri || "")
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked: the URI is still selectable text */
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Integrations</DialogTitle>
          <DialogDescription>
            Connect your accounts and choose what agents may use on each. Mail is draft-only: agents
            write drafts, you press Send in Gmail.
          </DialogDescription>
        </DialogHeader>

        {view === null ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            {error ? <span className="text-destructive">{error}</span> : <><Loader2 className="size-4 animate-spin" /> Loading…</>}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {view.providers.map((p) => (
              <section key={p.id} className="rounded-md border" data-testid={`integration-${p.id}`}>
                <ProviderHeader
                  p={p}
                  busy={busy === `client:${p.id}`}
                  onEdit={() => setEditing({ provider: p.id, client_id: p.client.client_id, client_secret: "" })}
                  onForget={() => forgetClient(p)}
                />
                {editing?.provider === p.id ? (
                  <ClientForm
                    p={p}
                    draft={editing}
                    redirectUri={view.redirect_uri}
                    copied={copied}
                    busy={busy === `client:${p.id}`}
                    onCopy={copyUri}
                    onChange={setEditing}
                    onCancel={() => setEditing(null)}
                    onSave={saveClient}
                  />
                ) : !p.client.configured ? (
                  <div className="px-3 pb-3 text-xs text-muted-foreground">
                    Set up the {p.label} client to connect: {p.services.map((s) => s.label).join(", ")}.
                  </div>
                ) : (
                  <div className="flex flex-col divide-y border-t">
                    {p.connections.map((c) => (
                      <div key={c.id} className="px-3 py-2">
                        <div className="mb-1 flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {c.account || `${p.label} account`}
                          </span>
                          <button
                            className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                            onClick={() => disconnect(p, c)}
                            disabled={!!busy}
                            title="Disconnect account"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                        {p.services.map((s) => (
                          <ServiceRow
                            key={s.id}
                            s={s}
                            state={c.services[s.id] || "grant"}
                            busy={busy === `${c.id}:${s.id}`}
                            disabled={!!busy}
                            onToggle={(on) => toggle(c, s.id, on)}
                            onGrant={() => connect(s.id, c.id)}
                          />
                        ))}
                      </div>
                    ))}
                    <NewAccount p={p} busy={busy} onConnect={(sid) => connect(sid)} />
                  </div>
                )}
              </section>
            ))}
          </div>
        )}

        {consenting && (
          <p className="text-xs text-muted-foreground">
            Finish signing in in the tab that opened; this page updates on its own.
          </p>
        )}
        {view && error && <p className="text-xs text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}

function ProviderHeader({ p, busy, onEdit, onForget }: {
  p: IntegrationProvider; busy: boolean; onEdit: () => void; onForget: () => void
}) {
  const c = p.client
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="font-medium">{p.label}</span>
      <span className={cn("text-[10px]", c.configured ? "text-emerald-600" : "text-muted-foreground")}>
        {c.configured ? "client ready" : c.client_id ? "client secret missing" : "client not set up"}
      </span>
      <span className="flex-1" />
      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onEdit} disabled={busy}>
        {c.client_id ? "Edit client" : "Set up client"}
      </Button>
      {c.client_id && (
        <button className="text-muted-foreground hover:text-destructive" onClick={onForget} title="Forget client" disabled={busy}>
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function ClientForm({ p, draft, redirectUri, copied, busy, onCopy, onChange, onCancel, onSave }: {
  p: IntegrationProvider
  draft: Draft
  redirectUri: string
  copied: boolean
  busy: boolean
  onCopy: () => void
  onChange: (d: Draft) => void
  onCancel: () => void
  onSave: () => void
}) {
  return (
    <div className="flex flex-col gap-2 border-t px-3 py-2">
      <p className="text-xs text-muted-foreground">
        Create an OAuth client in the{" "}
        <a className="inline-flex items-center gap-0.5 underline" href={p.console} target="_blank" rel="noreferrer">
          {p.label} developer console <ExternalLink className="size-3" />
        </a>
        , register this redirect URI on it, then paste its id{p.public ? "" : " and secret"} here.
        {p.id === "google" && " Enable the Drive, Gmail and Calendar APIs in the same project."}
      </p>
      <div className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1 text-xs">
        <code className="min-w-0 flex-1 select-all break-all font-mono">{redirectUri || "…"}</code>
        <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={onCopy} disabled={!redirectUri} title="Copy">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
      <Input
        className="h-8 font-mono text-xs"
        placeholder={p.public ? "App key / Application (client) ID" : "Client ID"}
        value={draft.client_id}
        onChange={(e) => onChange({ ...draft, client_id: e.target.value })}
        spellCheck={false}
        autoCapitalize="none"
        autoFocus
      />
      {p.public ? (
        <p className="text-xs text-muted-foreground">{p.label} uses a public PKCE client — no secret is issued or needed.</p>
      ) : (
        <Input
          className="h-8 font-mono text-xs"
          type="password"
          placeholder={p.client.has_secret ? "Client secret (leave blank to keep current)" : "Client secret"}
          value={draft.client_secret}
          onChange={(e) => onChange({ ...draft, client_secret: e.target.value })}
          spellCheck={false}
          autoCapitalize="none"
        />
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button size="sm" onClick={onSave} disabled={busy || !draft.client_id.trim()}>
          {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />} Save
        </Button>
      </div>
    </div>
  )
}

function ServiceRow({ s, state, busy, disabled, onToggle, onGrant }: {
  s: IntegrationService
  state: ServiceState
  busy: boolean
  disabled: boolean
  onToggle: (on: boolean) => void
  onGrant: () => void
}) {
  const action = serviceAction(state)
  return (
    <div className="flex items-center gap-2 py-1" data-testid={`service-${s.id}`}>
      <div className="min-w-0 flex-1">
        <div className="text-sm">{s.label}</div>
        <div className="text-[11px] text-muted-foreground">{s.available ? s.agent : s.unavailable}</div>
      </div>
      {busy ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : action === "toggle" ? (
        <button
          role="switch"
          aria-checked={state === "on"}
          aria-label={`${s.label}: ${STATE_TEXT[state]}`}
          disabled={disabled}
          onClick={() => onToggle(state !== "on")}
          className={cn(
            "relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-50",
            state === "on" ? "bg-primary" : "bg-muted"
          )}
        >
          <span className={cn(
            "absolute top-0.5 size-5 rounded-full bg-background shadow transition-transform",
            state === "on" ? "translate-x-[18px]" : "translate-x-0.5"
          )} />
        </button>
      ) : action === "grant" ? (
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onGrant} disabled={disabled}>
          {STATE_TEXT.grant}
        </Button>
      ) : (
        <span className="text-[11px] text-muted-foreground">{STATE_TEXT.unavailable}</span>
      )}
    </div>
  )
}

/** Connect a new account of this provider, starting with one service — the
 *  rest are added from the account's rows afterwards (each is its own consent,
 *  so the owner grants exactly what they turn on). */
function NewAccount({ p, busy, onConnect }: { p: IntegrationProvider; busy: string | null; onConnect: (sid: string) => void }) {
  const avail = p.services.filter((s) => s.available)
  const waiting = avail.find((s) => busy === `new:${s.id}`)
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
      <span className="text-xs text-muted-foreground">
        {p.connections.length ? "Add another account with" : "Connect an account with"}
      </span>
      {avail.map((s) => (
        <Button key={s.id} variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => onConnect(s.id)} disabled={!!busy}>
          {waiting?.id === s.id ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />} {s.label}
        </Button>
      ))}
    </div>
  )
}
