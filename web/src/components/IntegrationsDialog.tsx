import { useEffect, useRef, useState } from "react"
import { CalendarDays, Check, ChevronRight, Cloud, Copy, ExternalLink, Folder, KeyRound, Loader2, Mail, MessageSquarePlus, Plus, Server, Settings2, Trash2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { byCategory, categorySummary, comingLater, folderLabel, isToken, providerHint, providerOpen, reconnectService, setupFold, serviceAction, serviceSummary, tryPrompt, unavailableNote, waitForConsent } from "@/lib/integrations"
import { useStore } from "@/store"
import { IntakeSection } from "@/components/IntakeSection"
import type { IntegrationConnection, IntegrationProvider, IntegrationService, IntegrationsView, LocalDisk, ServiceState, SetupStep } from "@/lib/types"
import { userError } from "@/lib/errors"

type Draft = { provider: string; client_id: string; client_secret: string }
/** A token being pasted: for a new account, or (connection) replacing an expired one. */
type TokenDraft = { provider: string; connection?: string; token: string; fields: Record<string, string> }

/** A service row's icon by kind, so a card reads at a glance; unknown kinds fall back to a cloud. */
const KIND_ICON: Record<string, typeof Folder> = { files: Folder, mail: Mail, calendar: CalendarDays, api: Server }

/**
 * IntegrationsDialog — the one place the owner connects outside accounts
 * (Google, Dropbox, Microsoft) and decides what agents may do with each.
 * Renders GET /api/integrations verbatim — the server owns the catalog and
 * every rule, so a new service needs no client change.
 *
 * Laid out for the two questions the owner actually comes with:
 *  - "What can my agents use?" → one card per signed-in account, one line
 *    per service saying what agents may do there now. A row opens only to
 *    change it (op chips, a folder limit, Try it in a chat); a service the
 *    owner just switched on opens itself so its limits are seen.
 *  - "How do I add one?" → Add an account: one row per provider with a
 *    button per service. Providers still needing their one-time OAuth
 *    client fold behind one "More services" row (setupFold). Client credentials sit behind that row's gear — set once, so
 *    they get no permanent place on the page.
 *    Providers are grouped by category (files & mail, compute, networking,
 *    social…) and only the first group starts open, so twenty-odd vendors
 *    read as a short menu. API-token providers (Cloudflare, Hetzner…) connect
 *    by pasting a token the server checks with the vendor; providers nobody
 *    can connect yet show why instead of a button.
 * This machine's folders and Intake channels are separate concerns, so they
 * are separate tabs. Opened from the header, Profile → Integrations and the
 * file browser's location picker.
 */
export function IntegrationsDialog({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [view, setView] = useState<IntegrationsView | null>(null)
  const [editing, setEditing] = useState<Draft | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set()) // `${conn}:${service}` rows showing their details
  const [busy, setBusy] = useState<string | null>(null) // key of the control mid-request
  const [copied, setCopied] = useState(false)
  const [adding, setAdding] = useState<string | null>(null) // provider whose "Add an account" row is open
  const [more, setMore] = useState(false) // the providers that need setup are shown
  const [cats, setCats] = useState<Set<string> | null>(null) // open "Add an account" groups; null = just the first
  const [token, setToken] = useState<TokenDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [consenting, setConsenting] = useState(false) // a vendor tab is open on a consent
  const closed = useRef(false)
  const startNewSession = useStore((s) => s.startNewSession)

  useEffect(() => () => { closed.current = true }, [])

  async function load() {
    setView(await api.integrations())
  }
  useEffect(() => { load().catch((e) => setError(userError(e, "your integrations"))) }, [])

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
      if (!closed.current) setError(userError(e, "that change", "apply"))
    }
    if (!closed.current) setBusy(null)
  }

  const ok = (r: { error?: string } | object) => {
    if ("error" in r && r.error) throw new Error(r.error)
  }

  const expand = (key: string, on: boolean) => setOpen((o) => {
    const n = new Set(o)
    if (on) n.add(key)
    else n.delete(key)
    return n
  })

  function connect(service: string, connection?: string, op?: string) {
    return run(`${connection || "new"}:${service}${op ? `:${op}` : ""}`, async () => {
      const r = await api.integrationConnect({ service, connection, op })
      ok(r)
      if (!("url" in r)) throw new Error("No consent URL returned")
      setConsenting(true)
      try {
        window.open(r.url, "_blank", "noopener")
        await waitForConsent(() => api.driveOAuthStatus(r.pending), undefined, () => closed.current)
        if (closed.current) return
        if (!connection) setAdding(null) // the new account is listed; the add row has done its job
        expand(`${r.connection}:${service}`, true) // land on what agents may do now, with Try it in a chat
      } finally {
        if (!closed.current) setConsenting(false)
      }
    })
  }

  /** Close the page and open a fresh chat already doing a real task with
   *  this service — connecting is only worth it once the owner sees it used. */
  function tryInChat(s: IntegrationService, c: IntegrationConnection) {
    onClose()
    startNewSession({ cwd: "~", title: `Try ${s.label}`, message: tryPrompt(s, c) })
  }

  function toggle(conn: IntegrationConnection, service: string, on: boolean) {
    if (on) expand(`${conn.id}:${service}`, true)
    return run(`${conn.id}:${service}`, async () => ok(await api.integrationService({ connection: conn.id, service, on })))
  }

  function setOp(conn: IntegrationConnection, service: string, op: string, on: boolean) {
    return run(`${conn.id}:${service}:${op}`, async () => ok(await api.integrationOp({ connection: conn.id, service, op, on })))
  }

  function setRoot(conn: IntegrationConnection, root: string) {
    return run(`${conn.id}:root`, async () => ok(await api.integrationRoot({ connection: conn.id, root })))
  }

  function setLocal(roots: string[], ops: string[]) {
    return run("local", async () => ok(await api.integrationLocal({ roots, ops })))
  }

  function disconnect(p: IntegrationProvider, conn: IntegrationConnection) {
    const who = conn.account || `this ${p.label} account`
    if (!window.confirm(`Disconnect ${who}? Manager forgets its access; agents lose every ${p.label} service on it. Nothing in the account itself is touched.${isToken(p) ? ` The token still works at ${p.label} until you delete it there.` : ""}`)) return
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
      setAdding(body.provider) // set up to connect: show its services right away
    })
  }

  /** Paste-a-token connect: the server checks it with the vendor, so a typo
   *  or an expired token is refused here, not on an agent's first call. */
  function saveToken() {
    if (!token) return
    const t = token
    return run(`token:${t.provider}`, async () => {
      ok(await api.integrationToken({ provider: t.provider, token: t.token.trim(), fields: t.fields, connection: t.connection }))
      setToken(null)
    })
  }

  function openToken(p: IntegrationProvider, connection?: string) {
    setToken(token?.provider === p.id && token.connection === connection ? null
      : { provider: p.id, connection, token: "", fields: {} })
  }

  function forgetClient(p: IntegrationProvider) {
    if (!window.confirm(`Forget the ${p.label} client? Connected ${p.label} accounts stay listed but cannot sign in or refresh until a client is entered again.`)) return
    return run(`client:${p.id}`, async () => {
      ok(await api.integrationClientDelete(p.id))
      setEditing(null)
    })
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

  const accounts = view ? view.providers.flatMap((p) => p.connections.map((c) => ({ p, c }))) : []
  const folded = view ? setupFold(view.providers) : []
  const showFolded = more || folded.some((p) => p.id === editing?.provider)
  const groups = view ? byCategory(view.providers, view.categories) : []

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Integrations</DialogTitle>
          <DialogDescription>
            Connect once; every agent chat can use it, within your limits.
          </DialogDescription>
        </DialogHeader>

        {view === null ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            {error ? <span className="text-destructive">{error}</span> : <><Loader2 className="size-4 animate-spin" /> Loading…</>}
          </div>
        ) : (
          // No provider offered (this edition's catalog is empty): no Accounts tab
          // rather than an empty "Connect an account" list.
          <Tabs defaultValue={view.providers.length ? "accounts" : "local"} className="min-h-0 flex-1">
            <TabsList>
              {view.providers.length > 0 && (
                <TabsTrigger value="accounts">Accounts{accounts.length ? ` · ${accounts.length}` : ""}</TabsTrigger>
              )}
              <TabsTrigger value="local">This machine</TabsTrigger>
              <TabsTrigger value="intake">Intake channels</TabsTrigger>
            </TabsList>

            <TabsContent value="accounts" className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1 pb-1">
              {accounts.map(({ p, c }) => (
                <section key={c.id} className="rounded-lg border" data-testid={`account-${c.id}`}>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{c.account || `${p.label} account`}</div>
                      <div className="text-[11px] text-muted-foreground">{p.label}</div>
                    </div>
                    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive"
                      onClick={() => disconnect(p, c)} disabled={!!busy} title="Disconnect account" aria-label="Disconnect account">
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  {c.expired && isToken(p) ? (
                    <div className="mx-3 mb-2 flex flex-col gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive" data-testid={`expired-${c.id}`}>
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1">
                          {p.label} no longer accepts this token (revoked or expired), so agents can't use it. Paste a new one.
                        </span>
                        <Button size="sm" variant="destructive" className="h-7 text-xs" disabled={!!busy} onClick={() => openToken(p, c.id)}>
                          New token
                        </Button>
                      </div>
                      {token?.provider === p.id && token.connection === c.id && (
                        <TokenForm p={p} draft={token} busy={busy === `token:${p.id}`} onChange={setToken} onCancel={() => setToken(null)} onSave={saveToken} />
                      )}
                    </div>
                  ) : c.expired && (
                    <div className="mx-3 mb-2 flex items-center gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive" data-testid={`expired-${c.id}`}>
                      <span className="min-w-0 flex-1">
                        {p.label} ended this sign-in, so agents can't use it. Sign in again to restore it.
                      </span>
                      <Button size="sm" variant="destructive" className="h-7 text-xs" disabled={!!busy}
                        onClick={() => connect(reconnectService(p, c), c.id)}>
                        Reconnect
                      </Button>
                    </div>
                  )}
                  <div className="divide-y border-t">
                    {p.services.filter((s) => s.available).map((s) => {
                      const key = `${c.id}:${s.id}`
                      const state = c.services[s.id] || "grant"
                      return (
                        <ServiceRow
                          key={s.id}
                          s={s}
                          state={state}
                          summary={serviceSummary(s, c)}
                          expanded={open.has(key)}
                          onExpand={(on) => expand(key, on)}
                          busy={busy === key}
                          disabled={!!busy}
                          onToggle={(on) => toggle(c, s.id, on)}
                          onGrant={() => connect(s.id, c.id)}
                        >
                          {state === "on" && (
                            <>
                              <OpChips
                                testPrefix={`op-${c.id}-${s.id}`}
                                ops={s.ops.map((o) => ({ ...o, state: c.ops[s.id]?.[o.id] || "grant" }))}
                                busy={busy}
                                busyPrefix={`${key}:`}
                                onToggle={(op, on) => setOp(c, s.id, op, on)}
                                onGrant={(op) => connect(s.id, c.id, op)}
                              />
                              {s.kind === "files" && (
                                <RootRow conn={c} busy={busy === `${c.id}:root`} disabled={!!busy} onSave={(r) => setRoot(c, r)} />
                              )}
                              {s.try && !c.expired && (
                                <button
                                  className="flex w-fit items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                                  onClick={() => tryInChat(s, c)}
                                  disabled={!!busy}
                                  title={tryPrompt(s, c)}
                                  data-testid={`try-${c.id}-${s.id}`}
                                >
                                  <MessageSquarePlus className="size-3.5" /> Try it in a chat
                                </button>
                              )}
                            </>
                          )}
                        </ServiceRow>
                      )
                    })}
                  </div>
                </section>
              ))}

              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">{accounts.length ? "Add an account" : "Connect an account"}</h3>
                {groups.map((g, i) => {
                  const shown = cats === null ? i === 0 : cats.has(g.id)
                  return (
                    <div key={g.id} className="rounded-lg border" data-testid={`integration-category-${g.id}`}>
                      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40"
                        aria-expanded={shown} onClick={() => setCats((c) => toggled(c ?? new Set(groups.slice(0, 1).map((x) => x.id)), g.id))}>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{g.label}</span>
                          {!shown && <span className="block truncate text-[11px] text-muted-foreground">{categorySummary(g.providers)}</span>}
                        </span>
                        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", shown && "rotate-90")} />
                      </button>
                      {shown && (
                        <div className="divide-y border-t">
                          {g.providers.filter((p) => showFolded || !folded.includes(p)).map((p) => isToken(p) ? (
                            <TokenRow key={p.id} p={p} open={token?.provider === p.id && !token.connection} busy={busy} onOpen={() => openToken(p)}>
                              {token?.provider === p.id && !token.connection && (
                                <TokenForm p={p} draft={token} busy={busy === `token:${p.id}`} onChange={setToken} onCancel={() => setToken(null)} onSave={saveToken} />
                              )}
                            </TokenRow>
                          ) : (
                            <ProviderRow
                              key={p.id}
                              p={p}
                              open={providerOpen(p, adding, accounts.length > 0)}
                              onOpen={() => setAdding(adding === p.id ? null : p.id)}
                              busy={busy}
                              onConnect={(sid) => connect(sid)}
                              onEdit={() => setEditing(editing?.provider === p.id ? null : { provider: p.id, client_id: p.client.client_id, client_secret: "" })}
                            >
                              {editing?.provider === p.id && (
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
                                  onForget={() => forgetClient(p)}
                                />
                              )}
                            </ProviderRow>
                          ))}
                          {g.providers.some((p) => folded.includes(p)) && !showFolded && (
                            <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40"
                              onClick={() => setMore(true)} data-testid="integrations-more">
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium">More services</span>
                                <span className="block text-[11px] text-muted-foreground">{folded.map((p) => p.label).join(", ")} · one-time setup</span>
                              </span>
                              <ChevronRight className="size-3.5 text-muted-foreground" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </TabsContent>

            <TabsContent value="local" className="min-h-0 overflow-y-auto">
              <LocalDiskSection local={view.local} busy={busy === "local"} disabled={!!busy} onSave={setLocal} />
            </TabsContent>

            <TabsContent value="intake" className="min-h-0 overflow-y-auto">
              <IntakeSection />
            </TabsContent>
          </Tabs>
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

/** One provider under "Add an account": a button per service once its OAuth
 *  client is set up (each is its own consent, so the owner grants exactly
 *  what they pick), else the one-time setup. Once an account exists the row
 *  folds to one line until tapped (providerOpen). The gear reopens the client
 *  form — needed once, so it stays out of the way. */
function ProviderRow({ p, open, onOpen, busy, onConnect, onEdit, children }: {
  p: IntegrationProvider
  open: boolean
  onOpen: () => void
  busy: string | null
  onConnect: (sid: string) => void
  onEdit: () => void
  children?: React.ReactNode
}) {
  const c = p.client
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5" data-testid={`integration-${p.id}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className="min-w-0 flex-1 text-left disabled:cursor-default" disabled={!c.configured} onClick={onOpen}
          aria-expanded={open} data-testid={`integration-open-${p.id}`}>
          <div className="text-sm font-medium">{p.connections.length ? `Another ${p.label} account` : p.label}</div>
          <div className="text-[11px] text-muted-foreground">{providerHint(p, open)}</div>
        </button>
        {c.configured && !open ? (
          <Button variant="ghost" size="icon" className="size-7" onClick={onOpen} aria-label={`Add a ${p.label} account`}>
            <Plus className="size-3.5" />
          </Button>
        ) : c.configured ? (
          <>
            {p.services.filter((s) => s.available).map((s) => (
              <Button key={s.id} variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => onConnect(s.id)} disabled={!!busy}>
                {busy === `new:${s.id}` ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />} {s.label}
              </Button>
            ))}
            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={onEdit} disabled={!!busy}
              title={`${p.label} app credentials`} aria-label={`${p.label} app credentials`}>
              <Settings2 className="size-3.5" />
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onEdit} disabled={!!busy}>
            Set up
          </Button>
        )}
      </div>
      {open && unavailableNote(p) && <p className="text-[11px] text-muted-foreground" data-testid={`integration-unavailable-${p.id}`}>{unavailableNote(p)}</p>}
      {children}
    </div>
  )
}

/** A token provider under "Add an account": what agents get, and Connect —
 *  or, for one nobody can connect yet, the reason and where to read more. */
function TokenRow({ p, open, busy, onOpen, children }: {
  p: IntegrationProvider; open: boolean; busy: string | null; onOpen: () => void; children?: React.ReactNode
}) {
  const later = comingLater(p)
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5" data-testid={`integration-${p.id}`}>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <div className={cn("text-sm font-medium", later && "text-muted-foreground")}>{p.connections.length ? `Another ${p.label} account` : p.label}</div>
          <div className="text-[11px] text-muted-foreground">
            {providerHint(p, false)}
            {later && p.setup[0]?.links.map((l) => (
              <a key={l.url} className="ml-1.5 inline-flex items-center gap-0.5 underline" href={l.url} target="_blank" rel="noreferrer">
                {l.label} <ExternalLink className="size-3" />
              </a>
            ))}
          </div>
        </div>
        {later ? <span className="shrink-0 text-[11px] text-muted-foreground">Coming later</span> : !open && (
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={onOpen} disabled={!!busy}
            data-testid={`integration-token-${p.id}`}>
            <KeyRound className="size-3" /> Connect
          </Button>
        )}
      </div>
      {children}
    </div>
  )
}

/** Paste an API token (plus any boxes the vendor needs, e.g. Odoo's address). */
function TokenForm({ p, draft, busy, onChange, onCancel, onSave }: {
  p: IntegrationProvider; draft: TokenDraft; busy: boolean
  onChange: (d: TokenDraft) => void; onCancel: () => void; onSave: () => void
}) {
  const fields = (p.fields || []).filter((f) => !draft.connection || f.id !== "name")
  const ready = !!draft.token.trim() && fields.every((f) => !f.required || draft.fields[f.id]?.trim())
  return (
    <form className="flex flex-col gap-2 rounded-md bg-muted/40 p-3 text-foreground" data-testid={`token-form-${p.id}`}
      onSubmit={(e) => { e.preventDefault(); if (ready && !busy) onSave() }}>
      <SetupSteps p={p} steps={p.setup} />
      {fields.map((f) => (
        <Input key={f.id} className="h-8 text-xs" placeholder={`${f.label}: ${f.placeholder}`}
          aria-label={f.label} value={draft.fields[f.id] || ""} spellCheck={false} autoCapitalize="none"
          onChange={(e) => onChange({ ...draft, fields: { ...draft.fields, [f.id]: e.target.value } })} />
      ))}
      <Input className="h-8 font-mono text-xs" type="password" placeholder={p.secret || "API token"} aria-label={`${p.label} ${p.secret || "API token"}`}
        value={draft.token} onChange={(e) => onChange({ ...draft, token: e.target.value })}
        spellCheck={false} autoCapitalize="none" autoComplete="off" autoFocus />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy || !ready}>
          {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />} Check and save
        </Button>
      </div>
    </form>
  )
}

/** A provider's numbered setup checklist, with its links and (OAuth) the copyable redirect address. */
function SetupSteps({ p, steps, redirect }: { p: IntegrationProvider; steps: SetupStep[]; redirect?: React.ReactNode }) {
  return (
    <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-xs text-muted-foreground" data-testid={`setup-${p.id}`}>
      {steps.map((st, i) => (
        <li key={i}>
          {st.text}
          {st.links.map((l) => (
            <a key={l.url} className="ml-1.5 inline-flex items-center gap-0.5 text-foreground underline" href={l.url} target="_blank" rel="noreferrer">
              {l.label} <ExternalLink className="size-3" />
            </a>
          ))}
          {st.redirect && redirect}
        </li>
      ))}
    </ol>
  )
}

function ClientForm({ p, draft, redirectUri, copied, busy, onCopy, onChange, onCancel, onSave, onForget }: {
  p: IntegrationProvider
  draft: Draft
  redirectUri: string
  copied: boolean
  busy: boolean
  onCopy: () => void
  onChange: (d: Draft) => void
  onCancel: () => void
  onSave: () => void
  onForget: () => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3">
      <SetupSteps p={p} steps={p.setup} redirect={
        <div className="mt-1 flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1">
          <code className="min-w-0 flex-1 select-all break-all font-mono text-foreground">{redirectUri || "…"}</code>
          <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={onCopy} disabled={!redirectUri} title="Copy">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </div>
      } />
      <Input
        className="h-8 font-mono text-xs"
        placeholder={p.public ? "App key / Application (client) ID" : "Client ID"}
        value={draft.client_id}
        onChange={(e) => onChange({ ...draft, client_id: e.target.value })}
        spellCheck={false}
        autoCapitalize="none"
        autoFocus
      />
      {!p.public && (
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
      <div className="flex items-center justify-end gap-2">
        {p.client.client_id && (
          <Button variant="ghost" size="sm" className="mr-auto text-muted-foreground hover:text-destructive" onClick={onForget} disabled={busy}>
            <Trash2 className="mr-1 size-3.5" /> Forget client
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button size="sm" onClick={onSave} disabled={busy || !draft.client_id.trim()}>
          {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />} Save
        </Button>
      </div>
    </div>
  )
}

/** One service on one account: a single line saying what agents may do
 *  there now, with its switch (or Connect). Clicking the line opens the
 *  details — what agents will do with it, plus `children` (op chips, folder
 *  limit, Try it) when it is on. */
function ServiceRow({ s, state, summary, expanded, onExpand, busy, disabled, onToggle, onGrant, children }: {
  s: IntegrationService
  state: ServiceState
  summary: string
  expanded: boolean
  onExpand: (on: boolean) => void
  busy: boolean
  disabled: boolean
  onToggle: (on: boolean) => void
  onGrant: () => void
  children?: React.ReactNode
}) {
  const action = serviceAction(state)
  const KindIcon = KIND_ICON[s.kind] || Cloud
  return (
    <div data-testid={`service-${s.id}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => onExpand(!expanded)} aria-expanded={expanded}>
          <KindIcon className={cn("size-3.5 shrink-0", state === "on" ? "text-primary" : "text-muted-foreground")} />
          <span className="shrink-0 text-sm">{s.label}</span>
          <span className={cn("min-w-0 truncate text-xs", state === "on" ? "text-foreground/70" : "text-muted-foreground")}>
            · {summary}
          </span>
          <ChevronRight className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        </button>
        {busy ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : action === "toggle" ? (
          <Switch on={state === "on"} label={`${s.label}: ${state === "on" ? "On" : "Off"}`} disabled={disabled} onClick={() => onToggle(state !== "on")} />
        ) : action === "grant" ? (
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onGrant} disabled={disabled}>
            Connect
          </Button>
        ) : null}
      </div>
      {expanded && (
        <div className="flex flex-col gap-2 pr-3 pb-3 pl-8">
          <p className="text-xs text-muted-foreground">{s.available ? s.agent : s.unavailable}</p>
          {children}
        </div>
      )}
    </div>
  )
}

/** What agents may do with one service, or on this machine. Chips, not
 *  switches: several small yes/no answers read faster side by side. */
function OpChips({ testPrefix, ops, busy, busyPrefix, onToggle, onGrant }: {
  testPrefix: string
  ops: { id: string; label: string; state: ServiceState }[]
  busy: string | null
  busyPrefix: string
  onToggle: (op: string, on: boolean) => void
  /** Absent where nothing is ever granted (the local disk). */
  onGrant?: (op: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Agents may</span>
      {ops.map((o) => {
        const action = serviceAction(o.state)
        if (action === "none") return null
        const on = o.state === "on"
        return (
          <button
            key={o.id}
            data-testid={`${testPrefix}-${o.id}`}
            role="switch"
            aria-checked={on}
            aria-label={action === "grant" ? `${o.label}: needs access` : o.label}
            disabled={!!busy}
            onClick={() => (action === "grant" ? onGrant?.(o.id) : onToggle(o.id, !on))}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors disabled:opacity-50",
              on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
            )}
          >
            {busy === busyPrefix + o.id ? <Loader2 className="size-3 animate-spin" />
              : action === "grant" ? <Plus className="size-3" /> : on ? <Check className="size-3" /> : null}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** The folder a files account is narrowed to; agents and Files see nothing above it. */
function RootRow({ conn, busy, disabled, onSave }: {
  conn: IntegrationConnection; busy: boolean; disabled: boolean; onSave: (root: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft === null) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Folder className="size-3" />
        <span className="min-w-0 flex-1 truncate" data-testid={`root-${conn.id}`}>
          {conn.root === "/" ? "Whole account" : `Only ${conn.root}`}
        </span>
        {busy ? <Loader2 className="size-3 animate-spin" /> : (
          <button className="text-primary hover:underline disabled:opacity-50" disabled={disabled}
            onClick={() => setDraft(conn.root === "/" ? "" : conn.root)}>
            Limit to a folder
          </button>
        )}
      </div>
    )
  }
  const save = () => { onSave(draft.trim() || "/"); setDraft(null) }
  return (
    <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); save() }}>
      <Input className="h-7 flex-1 font-mono text-xs" value={draft} onChange={(e) => setDraft(e.target.value)}
        placeholder="/Work/Shared — empty for the whole account" spellCheck={false} autoCapitalize="none" autoFocus />
      <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setDraft(null)}>Cancel</Button>
      <Button type="submit" size="sm" className="h-7 text-xs">Save</Button>
    </form>
  )
}

/** The folders agents may work in on this machine, and what they may do there. */
function LocalDiskSection({ local, busy, disabled, onSave }: {
  local: LocalDisk; busy: boolean; disabled: boolean; onSave: (roots: string[], ops: string[]) => void
}) {
  const [adding, setAdding] = useState("")
  const ops = local.ops.filter((o) => o.on).map((o) => o.id)
  const add = () => {
    const r = adding.trim()
    if (!r) return
    onSave([...local.roots, r], ops)
    setAdding("")
  }
  return (
    <section className="rounded-md border" data-testid="integration-local">
      <p className="flex gap-2 px-3 py-2.5 text-xs text-muted-foreground">
        <span className="flex-1">
          Folders agents may use on the computer running Manager{local.roots.length ? "." : " — none yet."}
        </span>
        {busy && <Loader2 className="size-3.5 animate-spin" />}
      </p>
      <div className="flex flex-col divide-y border-t">
        {local.roots.map((r) => (
          <div key={r} className="flex items-center gap-2 px-3 py-1.5 text-sm">
            <Folder className="size-3.5 text-muted-foreground" />
            <span className={cn("min-w-0 flex-1 truncate text-xs", folderLabel(r) === r && "font-mono")}>{folderLabel(r)}</span>
            <button className="text-muted-foreground hover:text-destructive disabled:opacity-50" disabled={disabled}
              title="Remove folder" onClick={() => {
                if (window.confirm(`Stop agents using ${folderLabel(r)}? Nothing on disk is deleted; agents just can't reach it until you add it again.`)) onSave(local.roots.filter((x) => x !== r), ops)
              }}>
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
        <form className="flex items-center gap-2 px-3 py-2" onSubmit={(e) => { e.preventDefault(); add() }}>
          <Input className="h-7 flex-1 font-mono text-xs" value={adding} onChange={(e) => setAdding(e.target.value)}
            placeholder="~/Projects" spellCheck={false} autoCapitalize="none" />
          <Button type="submit" variant="outline" size="sm" className="h-7 text-xs" disabled={disabled || !adding.trim()}>
            <Plus className="mr-1 size-3" /> Add
          </Button>
        </form>
        <div className="px-3 py-2">
          <OpChips
            testPrefix="local-op"
            ops={local.ops.map((o) => ({ ...o, state: o.on ? "on" : "off" }))}
            busy={busy ? "local" : null}
            busyPrefix="local:"
            onToggle={(op, on) => onSave(local.roots, on ? [...ops, op] : ops.filter((x) => x !== op))}
          />
        </div>
      </div>
    </section>
  )
}

/** A copy of `set` with `id` flipped in or out. */
function toggled(set: Set<string>, id: string): Set<string> {
  const n = new Set(set)
  if (n.has(id)) n.delete(id)
  else n.add(id)
  return n
}
