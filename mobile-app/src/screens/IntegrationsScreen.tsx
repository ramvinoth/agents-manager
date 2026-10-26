import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, Linking, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from "react-native"
import * as Clipboard from "expo-clipboard"
import { api, type IntegrationConnection, type IntegrationProvider, type IntegrationService, type IntegrationsView, type LocalDisk, type ServiceState, type SetupStep } from "../api/client"
import { useNavigation } from "@react-navigation/native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { byCategory, categorySummary, comingLater, folderLabel, isToken, providerHint, providerOpen, reconnectService, setupFold, serviceAction, serviceSummary, tryPrompt, unavailableNote, waitForConsent } from "../lib/integrations"
import { useHost } from "../lib/useHost"
import { userError } from "../lib/errors"
import { offerUndo } from "../lib/undo"
import { useTheme } from "../lib/useTheme"
import Icon, { type IconName } from "../components/Icon"
import { useStyles } from "../lib/styles"

type Draft = { provider: string; client_id: string; client_secret: string }
type TokenDraft = { provider: string; connection?: string; token: string; fields: Record<string, string> }

/** A service row's icon by kind, so a card reads at a glance; unknown kinds fall back to a cloud. */
const KIND_ICON: Record<string, IconName> = { files: "folder", mail: "mail", calendar: "calendar", api: "server" }

/**
 * Integrations — the one place the owner connects outside accounts (Google,
 * Dropbox, Microsoft by sign-in; Cloudflare, Hetzner… by pasted API token) and decides which services agents may use on each:
 * Drive/Dropbox/OneDrive files, Gmail (read + drafts, never send), Calendar
 * (read). Renders GET /api/integrations verbatim — the server owns the catalog
 * and every rule, so a new service needs no app change. Twin of the web
 * IntegrationsDialog; both share lib/integrations for the state→control map
 * and the consent wait.
 *
 * Accounts first: each signed-in account is a card (a red Reconnect banner
 * when the vendor ended its sign-in) with one line per connectable service.
 * A granted service is a switch (the grant is kept); a missing one runs
 * consent in the system browser that ADDS the permission and keeps the rest.
 * A service nobody can connect (Google Keep) gets no row — one line under
 * "Add an account" says why. Once an account exists, each "Add an account"
 * row folds to one line until tapped, so the page reads as the accounts;
 * providers still needing developer setup fold behind one "More services"
 * row (setupFold). "Add an account" is grouped by the server's categories
 * (files & mail, compute, networking…), only the first open; a token provider
 * opens a paste-and-check form, and one nobody can connect yet says why.
 * Tapping a service line opens its details: one chip per
 * operation (read, write, delete, create…) saying what AGENTS may do there; a
 * chip that needs a wider grant runs consent for just that op. A files account
 * can be narrowed to one folder. Last, "This machine": the folders agents may
 * touch on the local disk and what they may do in them (the add field
 * opens on tap). Reached from the side
 * menu and the Files location picker.
 */
export default function IntegrationsScreen() {
  const styles = useStyles()
  const t = useTheme()
  const [view, setView] = useState<IntegrationsView | null>(null)
  const [editing, setEditing] = useState<Draft | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set()) // `${conn}:${service}` rows showing their details
  const [busy, setBusy] = useState<string | null>(null) // key of the control mid-request
  const [copied, setCopied] = useState(false)
  const [adding, setAdding] = useState<string | null>(null) // provider whose "Add an account" row is open
  const [more, setMore] = useState(false) // the providers that need setup are shown
  const [cats, setCats] = useState<Set<string> | null>(null) // open "Add an account" groups; null = just the first
  const [token, setToken] = useState<TokenDraft | null>(null) // the token form being filled (new account, or `connection`'s new token)
  const [error, setError] = useState("")
  const [consenting, setConsenting] = useState(false) // the system browser is open on a consent
  const left = useRef(false)
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const { host } = useHost()
  useEffect(() => () => { left.current = true }, [])

  const load = useCallback(async () => setView(await api.integrations()), [])
  useEffect(() => { load().catch((e) => setError(userError(e, "integrations"))) }, [load])

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key)
    setError("")
    try {
      await fn()
      await load()
    } catch (e) {
      if (!left.current) setError(userError(e, "integrations"))
    } finally {
      if (!left.current) setBusy(null)
    }
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
      setConsenting(true)
      try {
        await Linking.openURL(r.url)
        await waitForConsent(() => api.driveOAuthStatus(r.pending), undefined, () => left.current)
        if (left.current) return
        if (!connection) setAdding(null) // the new account is listed; the add row has done its job
        expand(`${r.connection}:${service}`, true) // land on what agents may do now, with Try it in a chat
      } finally {
        if (!left.current) setConsenting(false)
      }
    })
  }

  function setOp(conn: IntegrationConnection, service: string, op: string, on: boolean) {
    return run(`${conn.id}:${service}:${op}`, async () => { await api.integrationOp({ connection: conn.id, service, op, on }) })
  }

  function setRoot(conn: IntegrationConnection, root: string) {
    return run(`${conn.id}:root`, async () => { await api.integrationRoot({ connection: conn.id, root }) })
  }

  function setLocal(roots: string[], ops: string[]) {
    return run("local", async () => { await api.integrationLocal({ roots, ops }) })
  }

  /** Open a fresh chat already doing a real task with this service —
   *  connecting is only worth it once the owner sees it used. */
  function tryInChat(s: IntegrationService, c: IntegrationConnection) {
    return run(`${c.id}:${s.id}:try`, async () => {
      const title = `Try ${s.label}`
      const message = tryPrompt(s, c)
      const res = await api.newSession({ message, cwd: "~", host, agent: "claude", title })
      // Open it now — the agent takes a while to start and answer; the thread
      // shows it working and picks up the transcript once it's written.
      if (!left.current) navigation.navigate("Thread", { host, label: title, path: res.path, starting: { session: res.session, message } })
    })
  }

  function toggle(conn: IntegrationConnection, service: string, on: boolean) {
    if (on) expand(`${conn.id}:${service}`, true)
    return run(`${conn.id}:${service}`, async () => { await api.integrationService({ connection: conn.id, service, on }) })
  }

  function disconnect(p: IntegrationProvider, conn: IntegrationConnection) {
    Alert.alert(`Disconnect ${conn.account || `this ${p.label} account`}?`,
      `Harman forgets its access; agents lose every ${p.label} service on it. Nothing in the account itself is touched.${isToken(p) ? ` The token still works at ${p.label} until you delete it there.` : ""}`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect", style: "destructive",
          onPress: () => run(`${conn.id}:delete`, async () => {
            const r = await api.driveDelete(conn.id)
            if (r.error) throw new Error(r.error)
          }),
        },
      ])
  }

  function saveClient() {
    if (!editing) return
    const body: { provider: string; client_id: string; client_secret?: string } = { provider: editing.provider, client_id: editing.client_id.trim() }
    if (editing.client_secret.trim()) body.client_secret = editing.client_secret.trim()
    run(`client:${editing.provider}`, async () => {
      await api.integrationClientSave(body)
      setEditing(null)
      setAdding(body.provider) // set up to connect: show its services right away
    })
  }

  function saveToken() {
    if (!token) return
    const d = token
    run(`token:${d.provider}`, async () => {
      await api.integrationToken({ provider: d.provider, token: d.token.trim(), fields: d.fields, connection: d.connection })
      setToken(null)
    })
  }

  function openToken(p: IntegrationProvider, connection?: string) {
    setToken(token?.provider === p.id && token.connection === connection ? null : { provider: p.id, connection, token: "", fields: {} })
  }

  function forgetClient(p: IntegrationProvider) {
    Alert.alert(`Forget the ${p.label} client?`, `Connected ${p.label} accounts stay listed but cannot sign in or refresh until a client is entered again.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Forget", style: "destructive", onPress: () => run(`client:${p.id}`, async () => { await api.integrationClientDelete(p.id) }) },
    ])
  }

  async function copyUri() {
    await Clipboard.setStringAsync(view?.redirect_uri || "")
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const link = { color: t.accent, fontSize: 13, fontWeight: "600" as const }

  if (view === null) {
    return (
      <View style={[styles.page, styles.igPad]}>
        {error ? (
          <>
            <Text testID="integrations-error" style={styles.error}>{error}</Text>
            <TouchableOpacity onPress={() => { setError(""); load().catch((e) => setError(userError(e, "integrations"))) }} style={styles.igRetry}>
              <Text style={link}>Try again</Text>
            </TouchableOpacity>
          </>
        ) : <ActivityIndicator />}
      </View>
    )
  }

  const accounts = view.providers.flatMap((p) => p.connections.map((c) => ({ p, c })))
  const folded = setupFold(view.providers)
  const showFolded = more || folded.some((p) => p.id === editing?.provider)
  const groups = byCategory(view.providers, view.categories)

  return (
    <ScrollView testID="integrations-screen" style={styles.page} contentContainerStyle={styles.pvScroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
      <Text style={[styles.sheetHint, styles.igRetry]}>
        Connect once; every agent chat can use it, within your limits.
      </Text>
      {/* Up here, not at the end: the owner acts on a row near the top and would never see a note below the fold. */}
      {consenting ? (
        <Text style={[styles.sheetHint, styles.igAccent]}>
          Finish signing in in the browser, then come back — this screen updates on its own.
        </Text>
      ) : null}
      {error ? <Text testID="integrations-error" style={[styles.error, styles.igError]}>{error}</Text> : null}

      {/* No accounts: no empty "Accounts" heading over a "none yet" line — the add section IS the page. */}
      {accounts.length ? <Text style={styles.sheetSection}>ACCOUNTS</Text> : null}
      {accounts.map(({ p, c }) => (
        <View key={c.id} testID={`integration-conn-${c.id}`} style={styles.spCard}>
          <View style={styles.spCardHead}>
            <View style={styles.flex1}>
              <Text numberOfLines={1} style={styles.spCardTitle}>{c.account || `${p.label} account`}</Text>
              <Text style={styles.spCardSummary}>{p.label}</Text>
            </View>
            <TouchableOpacity testID={`integration-disconnect-${c.id}`} onPress={() => disconnect(p, c)} disabled={!!busy} hitSlop={8} style={styles.igIconBtn}
              accessibilityLabel={`Disconnect ${c.account || p.label}`}>
              <Icon name="trash" size={16} color={t.textMuted} />
            </TouchableOpacity>
          </View>
          {c.expired && isToken(p) ? (
            <View testID={`expired-${c.id}`} style={styles.igExpired}>
              <View style={styles.igRow10}>
                <Text style={styles.igExpiredText}>
                  {p.label} no longer accepts this token (revoked or expired), so agents can't use it. Paste a new one.
                </Text>
                <TouchableOpacity testID={`integration-newtoken-${c.id}`} disabled={!!busy} onPress={() => openToken(p, c.id)} hitSlop={8}>
                  <Text style={[styles.igExpiredAction, !!busy && styles.faded]}>New token</Text>
                </TouchableOpacity>
              </View>
              {token?.provider === p.id && token.connection === c.id ? (
                <TokenForm p={p} draft={token} busy={busy === `token:${p.id}`} onChange={setToken} onCancel={() => setToken(null)} onSave={saveToken} />
              ) : null}
            </View>
          ) : c.expired ? (
            <View testID={`expired-${c.id}`} style={[styles.igExpired, styles.igRow10]}>
              <Text style={styles.igExpiredText}>
                {p.label} ended this sign-in, so agents can't use it. Sign in again to restore it.
              </Text>
              <TouchableOpacity testID={`integration-reconnect-${c.id}`} disabled={!!busy} onPress={() => connect(reconnectService(p, c), c.id)} hitSlop={8}>
                <Text style={[styles.igExpiredAction, !!busy && styles.faded]}>Reconnect</Text>
              </TouchableOpacity>
            </View>
          ) : null}
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
                {state === "on" && s.ops.length ? (
                  <OpChips
                    testPrefix={`op-${c.id}-${s.id}`}
                    ops={s.ops.map((o) => ({ ...o, state: c.ops[s.id]?.[o.id] || "grant" }))}
                    busy={busy}
                    busyPrefix={`${key}:`}
                    onToggle={(op, on) => setOp(c, s.id, op, on)}
                    onGrant={(op) => connect(s.id, c.id, op)}
                  />
                ) : null}
                {state === "on" && s.kind === "files" ? (
                  <RootRow conn={c} busy={busy === `${c.id}:root`} disabled={!!busy} onSave={(root) => setRoot(c, root)} />
                ) : null}
                {state === "on" && s.try && !c.expired ? (
                  <TouchableOpacity
                    testID={`try-${c.id}-${s.id}`}
                    onPress={() => tryInChat(s, c)}
                    disabled={!!busy}
                    hitSlop={8}
                    style={[styles.igTry, !!busy && styles.faded]}
                  >
                    {busy === `${key}:try` ? <ActivityIndicator size="small" /> : <Icon name="chat" size={14} color={t.accent} />}
                    <Text style={styles.igLink}>Try it in a chat</Text>
                  </TouchableOpacity>
                ) : null}
              </ServiceRow>
            )
          })}
        </View>
      ))}

      <Text style={styles.sheetSection}>{accounts.length ? "ADD AN ACCOUNT" : "CONNECT AN ACCOUNT"}</Text>
      {groups.map((g, gi) => {
        const shown = cats === null ? gi === 0 : cats.has(g.id)
        return (
          <View key={g.id} testID={`integration-category-${g.id}`} style={styles.spCard}>
            <TouchableOpacity testID={`integration-category-open-${g.id}`} accessibilityRole="button" accessibilityState={{ expanded: shown }}
              onPress={() => setCats((c) => toggled(c ?? new Set(groups.slice(0, 1).map((x) => x.id)), g.id))}
              style={styles.igProviderHead}>
              <View style={styles.flex1}>
                <Text style={styles.ssRowLabel}>{g.label}</Text>
                {!shown ? <Text numberOfLines={1} style={styles.igHint}>{categorySummary(g.providers)}</Text> : null}
              </View>
              <Icon name={shown ? "chevronDown" : "chevronRight"} size={14} color={t.textMuted} />
            </TouchableOpacity>
            {shown ? (
              <View style={styles.igHairTop}>
                {g.providers.filter((p) => showFolded || !folded.includes(p)).map((p, i) => {
                  if (isToken(p) || comingLater(p)) return (
                    <TokenRow key={p.id} p={p} first={i === 0} open={token?.provider === p.id && !token.connection} busy={busy} onOpen={() => openToken(p)}>
                      {token?.provider === p.id && !token.connection ? (
                        <TokenForm p={p} draft={token} busy={busy === `token:${p.id}`} onChange={setToken} onCancel={() => setToken(null)} onSave={saveToken} />
                      ) : null}
                    </TokenRow>
                  )
                  const isOpen = providerOpen(p, adding, accounts.length > 0)
                  return (
                <View key={p.id} testID={`integration-${p.id}`} style={[styles.igProvider, i > 0 && styles.igHairTop]}>
                  <View style={styles.igRow10}>
                    <TouchableOpacity testID={`integration-open-${p.id}`} style={styles.flex1} disabled={!p.client.configured}
                      onPress={() => setAdding(adding === p.id ? null : p.id)} accessibilityRole="button" accessibilityState={{ expanded: isOpen }}>
                      <Text style={styles.ssRowLabel}>{p.connections.length ? `Another ${p.label} account` : p.label}</Text>
                      <Text style={styles.igHint}>{providerHint(p, isOpen)}</Text>
                    </TouchableOpacity>
                    {p.client.configured && !isOpen ? (
                      <TouchableOpacity onPress={() => setAdding(p.id)} hitSlop={8} accessibilityLabel={`Add a ${p.label} account`}>
                        <Icon name="plus" size={18} color={t.accent} />
                      </TouchableOpacity>
                    ) : null}
                    {isOpen || !p.client.configured ? <TouchableOpacity
                      testID={`integrations-edit-${p.id}`}
                      onPress={() => setEditing(editing?.provider === p.id ? null : { provider: p.id, client_id: p.client.client_id, client_secret: "" })}
                      disabled={!!busy}
                      hitSlop={8}
                      accessibilityLabel={`${p.label} app credentials`}
                    >
                      {p.client.configured
                        ? <Icon name="settings" size={18} color={t.textMuted} />
                        : <Text style={link}>Set up</Text>}
                    </TouchableOpacity> : null}
                  </View>
                  {isOpen ? (
                    <View style={styles.igWrap8}>
                      {p.services.filter((s) => s.available).map((s) => (
                        <TouchableOpacity
                          key={s.id}
                          testID={`integration-new-${s.id}`}
                          style={[styles.filterChip, styles.igChip, !!busy && styles.faded]}
                          disabled={!!busy}
                          onPress={() => connect(s.id)}
                        >
                          {busy === `new:${s.id}` ? <ActivityIndicator size="small" /> : <Icon name="plus" size={12} color={t.textMuted} />}
                          <Text style={styles.filterChipText}>{s.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ) : null}
                  {isOpen && unavailableNote(p) ? <Text testID={`integration-unavailable-${p.id}`} style={[styles.igHint, styles.igHintTight]}>{unavailableNote(p)}</Text> : null}
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
                      onForget={() => forgetClient(p)}
                    />
                  ) : null}
                </View>
                )
                  })}
              {folded.length && !showFolded && folded.some((p) => g.providers.includes(p)) ? (
                <TouchableOpacity testID="integrations-more" onPress={() => setMore(true)} accessibilityRole="button"
                  style={[styles.igProviderHead, g.providers.length > folded.length && styles.igHairTop]}>
                  <View style={styles.flex1}>
                    <Text style={styles.ssRowLabel}>More services</Text>
                    <Text style={styles.igHint}>{folded.map((p) => p.label).join(", ")} · one-time setup</Text>
                  </View>
                  <Icon name="chevronRight" size={14} color={t.textMuted} />
                </TouchableOpacity>
              ) : null}
              </View>
            ) : null}
          </View>
        )
      })}

      <LocalDiskSection local={view.local} busy={busy === "local"} disabled={!!busy} onSave={setLocal} />

    </ScrollView>
  )
}

/** One service on one account: a single line saying what agents may do there
 *  now, with its switch (or Connect). Tapping the line opens the details —
 *  what agents will do with it, plus `children` (op chips, folder limit, Try
 *  it) when it is on. */
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
  const styles = useStyles()
  const t = useTheme()
  const action = serviceAction(state)
  return (
    <View testID={`service-${s.id}`} style={styles.igHairTop}>
      <View style={styles.igServiceRow}>
        <TouchableOpacity testID={`service-expand-${s.id}`} onPress={() => onExpand(!expanded)} style={styles.pvModelPick}
          accessibilityRole="button" accessibilityState={{ expanded }} accessibilityHint={expanded ? "Hides the details" : "Shows what agents may do"}>
          <Icon name={KIND_ICON[s.kind] || "cloud"} size={16} color={state === "on" ? t.accent : t.textMuted} />
          <View style={styles.flex1}>
            <Text style={styles.ssRowLabel}>{s.label}</Text>
            <Text numberOfLines={1} style={[styles.igHint, state === "on" && styles.igHintOn]}>{summary}</Text>
          </View>
          {/* Says the row opens — the switch alone reads as the only control. */}
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={14} color={t.textMuted} />
        </TouchableOpacity>
        {busy ? (
          <ActivityIndicator />
        ) : action === "toggle" ? (
          <Switch testID={`service-switch-${s.id}`} value={state === "on"} disabled={disabled} onValueChange={onToggle} trackColor={{ true: t.accent, false: t.border }}
            style={styles.igSwitch} />
        ) : action === "grant" ? (
          <TouchableOpacity testID={`service-grant-${s.id}`} onPress={onGrant} disabled={disabled} hitSlop={8}>
            <Text style={[styles.igLink, disabled && styles.faded]}>Connect</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {expanded ? (
        <View style={styles.igServiceBody}>
          <Text style={[styles.igHint, styles.igHintTight]}>{s.available ? s.agent : s.unavailable}</Text>
          {children}
        </View>
      ) : null}
    </View>
  )
}

/** What agents may do with one switched-on service on one account: a chip per
 *  operation. Filled with a tick = allowed, plain outline = not (no ✕: it read
 *  as "remove this chip"), "+" = needs a wider grant. */
function OpChips({ testPrefix, ops, busy, busyPrefix, onToggle, onGrant }: {
  testPrefix: string
  ops: { id: string; label: string; state: ServiceState }[]
  busy: string | null
  busyPrefix: string
  onToggle: (op: string, on: boolean) => void
  /** Absent where nothing is ever granted (the local disk). */
  onGrant?: (op: string) => void
}) {
  const styles = useStyles()
  const t = useTheme()
  return (
    <View style={styles.igChips}>
      <Text style={[styles.igHint, styles.igHintTight]}>Agents may</Text>
      {ops.map((o) => {
        const action = serviceAction(o.state)
        if (action === "none") return null
        const on = o.state === "on"
        return (
          <TouchableOpacity
            key={o.id}
            testID={`${testPrefix}-${o.id}`}
            accessibilityRole="switch"
            accessibilityState={{ checked: on }}
            accessibilityLabel={action === "grant" ? `${o.label}: needs access` : o.label}
            disabled={!!busy}
            onPress={() => (action === "grant" ? onGrant?.(o.id) : onToggle(o.id, !on))}
            style={[styles.filterChip, on && styles.filterChipActive, styles.igChip, !!busy && busy !== busyPrefix + o.id && styles.faded]}
          >
            {busy === busyPrefix + o.id ? <ActivityIndicator size="small" />
              : action === "grant" || on ? <Icon name={on ? "check" : "plus"} size={12} color={on ? t.onAccent : t.textMuted} /> : null}
            <Text style={[styles.filterChipText, on && styles.filterChipTextActive]}>{o.label}</Text>
          </TouchableOpacity>
        )
      })}
    </View>
  )
}

/** The folder a files account is narrowed to; agents and the Files tab see nothing above it. */
function RootRow({ conn, busy, disabled, onSave }: {
  conn: IntegrationConnection
  busy: boolean
  disabled: boolean
  onSave: (root: string) => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const [draft, setDraft] = useState<string | null>(null)
  if (draft === null) {
    return (
      <View style={styles.igRootRow}>
        <Icon name="folder" size={14} color={t.textMuted} />
        <Text testID={`root-${conn.id}`} numberOfLines={1} style={[styles.igHint, styles.igRootText]}>
          {conn.root === "/" ? "Whole account" : `Only ${conn.root}`}
        </Text>
        {busy ? <ActivityIndicator /> : (
          <TouchableOpacity testID={`root-edit-${conn.id}`} disabled={disabled} hitSlop={8} onPress={() => setDraft(conn.root === "/" ? "" : conn.root)}>
            <Text style={styles.igLink}>Limit to a folder</Text>
          </TouchableOpacity>
        )}
      </View>
    )
  }
  const save = () => { onSave(draft.trim() || "/"); setDraft(null) }
  return (
    <View style={styles.igGap6}>
      <TextInput
        testID={`root-input-${conn.id}`}
        style={styles.ssInput}
        value={draft}
        onChangeText={setDraft}
        placeholder="/Work/Shared — empty for the whole account"
        placeholderTextColor={t.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={save}
      />
      <View style={styles.igActions}>
        <TouchableOpacity testID={`root-save-${conn.id}`} style={styles.ssAddBtn} onPress={save}>
          <Text style={styles.ssAddBtnText}>Save</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setDraft(null)}>
          <Text style={[styles.igLink, styles.pvMuted]}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

/** This machine's disk: the folders agents may work in and what they may do there. */
function LocalDiskSection({ local, busy, disabled, onSave }: {
  local: LocalDisk
  busy: boolean
  disabled: boolean
  onSave: (roots: string[], ops: string[]) => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const [adding, setAdding] = useState<string | null>(null) // null: the add field is closed
  const ops = local.ops.filter((o) => o.on).map((o) => o.id)
  const add = () => {
    const r = adding?.trim()
    if (!r) return setAdding(null)
    onSave([...local.roots, r], ops)
    setAdding(null)
  }
  return (
    <View testID="integration-local">
      <Text style={styles.sheetSection}>THIS MACHINE</Text>
      <Text style={styles.sheetHint}>
        Folders agents may use on the computer running Harman{local.roots.length ? "." : " — none yet."}
      </Text>
      <View style={styles.spCard}>
      {local.roots.map((r, i) => (
        <View key={r} style={[styles.igFolderRow, i > 0 && styles.igHairTop]}>
          <Icon name="folder" size={16} color={t.textMuted} />
          <Text testID={`local-root-${i}`} numberOfLines={1} style={styles.igFolderText}>{folderLabel(r)}</Text>
          <TouchableOpacity testID={`local-remove-${i}`} disabled={disabled} hitSlop={8} style={styles.igIconBtn}
            onPress={() => {
              // Nothing on disk is touched — it's a flip, so instant with Undo.
              onSave(local.roots.filter((x) => x !== r), ops)
              offerUndo({ label: `Agents can no longer use ${folderLabel(r)}`, undo: () => onSave(local.roots, ops) })
            }} accessibilityLabel={`Remove ${folderLabel(r)}`}>
            <Icon name="trash" size={16} color={t.textMuted} />
          </TouchableOpacity>
        </View>
      ))}
      {adding === null ? (
        <TouchableOpacity testID="local-add-open" disabled={disabled} onPress={() => setAdding("")}
          style={[styles.igFolderRow, styles.igFolderAdd, local.roots.length > 0 && styles.igHairTop]}>
          {busy ? <ActivityIndicator size="small" /> : <Icon name="plus" size={16} color={t.accent} />}
          <Text style={[styles.igLink, styles.igLinkLarge]}>Add a folder</Text>
        </TouchableOpacity>
      ) : (
      <View style={[styles.igFolderRow, local.roots.length > 0 && styles.igHairTop]}>
        <TextInput
          testID="local-add-input"
          autoFocus
          style={[styles.ssInput, styles.igInline]}
          value={adding}
          onChangeText={setAdding}
          placeholder="e.g. ~/Projects"
          placeholderTextColor={t.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={add}
          onBlur={() => { if (!adding.trim()) setAdding(null) }}
        />
        <TouchableOpacity testID="local-add" style={[styles.ssAddBtn, (!adding.trim() || disabled) && styles.faded]} disabled={!adding.trim() || disabled} onPress={add}>
          <Text style={styles.ssAddBtnText}>Add</Text>
        </TouchableOpacity>
      </View>
      )}
      <View style={[styles.igSection, styles.igHairTop]}>
        <OpChips
          testPrefix="local-op"
          ops={local.ops.map((o) => ({ id: o.id, label: o.label, state: o.on ? "on" : "off" }))}
          busy={busy ? "local" : null}
          busyPrefix="local:"
          onToggle={(op, on) => onSave(local.roots, on ? [...ops, op] : ops.filter((x) => x !== op))}
        />
      </View>
      </View>
    </View>
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
  const styles = useStyles()
  const t = useTheme()
  const secret = useRef<TextInput>(null)
  const canSave = !!draft.client_id.trim() && !busy
  return (
    <View style={styles.igForm}>
      <SetupSteps p={p} redirect={
        <View style={styles.rowCenter}>
          <Text testID="integrations-redirect-uri" selectable style={styles.igRedirect}>
            {redirectUri || "…"}
          </Text>
          <TouchableOpacity testID="integrations-copy-uri" onPress={onCopy} disabled={!redirectUri} hitSlop={8} style={styles.igCopyBtn}>
            <Icon name={copied ? "check" : "copy"} size={18} color={t.accent} />
          </TouchableOpacity>
        </View>
      } />
      <TextInput
        testID="integrations-client-id"
        style={styles.ssInput}
        value={draft.client_id}
        onChangeText={(client_id) => onChange({ ...draft, client_id })}
        placeholder={p.public ? "App key / Application (client) ID" : "Client ID"}
        placeholderTextColor={t.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        returnKeyType={p.public ? "done" : "next"}
        blurOnSubmit={p.public}
        onSubmitEditing={() => (p.public ? canSave && onSave() : secret.current?.focus())}
      />
      {!p.public ? (
        <TextInput
          testID="integrations-client-secret"
          ref={secret}
          style={styles.ssInput}
          value={draft.client_secret}
          onChangeText={(client_secret) => onChange({ ...draft, client_secret })}
          placeholder={p.client.has_secret ? "Client secret (leave blank to keep current)" : "Client secret"}
          placeholderTextColor={t.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          returnKeyType="done"
          onSubmitEditing={() => canSave && onSave()}
        />
      ) : null}
      <View style={styles.igFormActions}>
        <TouchableOpacity
          testID="integrations-save"
          style={[styles.ssAddBtn, !canSave && styles.faded]}
          disabled={!canSave}
          onPress={onSave}
        >
          <Text style={styles.ssAddBtnText}>{busy ? "Saving…" : "Save"}</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="integrations-cancel" onPress={onCancel} disabled={busy}>
          <Text style={[styles.igLink, styles.pvMuted]}>Cancel</Text>
        </TouchableOpacity>
        <View style={styles.flex1} />
        {p.client.client_id ? (
          <TouchableOpacity testID={`integrations-forget-${p.id}`} onPress={onForget} disabled={busy} hitSlop={8}>
            <Icon name="trash" size={18} color={t.danger} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  )
}

/** A token provider under "Add an account" (Cloudflare, Hetzner…): its name,
 *  what agents get, and Connect — which opens `children` (the TokenForm). One
 *  nobody can connect yet (AWS) shows the reason and its links instead. */
function TokenRow({ p, first, open, busy, onOpen, children }: {
  p: IntegrationProvider; first: boolean; open: boolean; busy: string | null; onOpen: () => void; children?: React.ReactNode
}) {
  const styles = useStyles()
  const t = useTheme()
  const later = comingLater(p)
  return (
    <View testID={`integration-${p.id}`} style={[styles.igProvider, !first && styles.igHairTop]}>
      <View style={styles.igRow10}>
        <View style={styles.igTokenText}>
          <Text style={[styles.ssRowLabel, later && { color: t.textMuted }]}>{p.connections.length ? `Another ${p.label} account` : p.label}</Text>
          <Text style={styles.igHint}>{providerHint(p, false)}</Text>
          {later && p.setup[0]?.links.length ? (
            <View style={styles.igLinks}>
              {p.setup[0].links.map((l) => (
                <TouchableOpacity key={l.url} onPress={() => Linking.openURL(l.url)} hitSlop={6}>
                  <Text style={[styles.igLink, styles.igLinkSmall]}>{l.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
        </View>
        {later ? <Text style={[styles.ssRowHint, styles.igHintTight]}>Coming later</Text> : !open ? (
          <TouchableOpacity testID={`integration-token-${p.id}`} onPress={onOpen} disabled={!!busy} hitSlop={8}
            style={[styles.igConnect, !!busy && styles.faded]} accessibilityLabel={`Connect ${p.label}`}>
            <Icon name="plus" size={16} color={t.accent} />
            <Text style={styles.igLink}>Connect</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {children}
    </View>
  )
}

/** Paste an API token (plus any boxes the vendor needs, e.g. Odoo's address);
 *  the server checks it with the vendor before saving. Replacing a refused
 *  token (`draft.connection`) skips the account-name box. */
function TokenForm({ p, draft, busy, onChange, onCancel, onSave }: {
  p: IntegrationProvider; draft: TokenDraft; busy: boolean
  onChange: (d: TokenDraft) => void; onCancel: () => void; onSave: () => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const fields = (p.fields || []).filter((f) => !draft.connection || f.id !== "name")
  const ready = !!draft.token.trim() && fields.every((f) => !f.required || draft.fields[f.id]?.trim()) && !busy
  return (
    <View testID={`token-form-${p.id}`} style={styles.igForm}>
      <SetupSteps p={p} />
      {fields.map((f) => (
        <TextInput key={f.id} testID={`token-field-${f.id}`} style={styles.ssInput} value={draft.fields[f.id] || ""}
          onChangeText={(v) => onChange({ ...draft, fields: { ...draft.fields, [f.id]: v } })}
          placeholder={`${f.label}: ${f.placeholder}`} placeholderTextColor={t.textMuted} autoCapitalize="none" autoCorrect={false} />
      ))}
      <TextInput testID={`token-input-${p.id}`} style={styles.ssInput} value={draft.token}
        onChangeText={(token) => onChange({ ...draft, token })} placeholder={p.secret || "API token"} placeholderTextColor={t.textMuted}
        autoCapitalize="none" autoCorrect={false} secureTextEntry returnKeyType="done" onSubmitEditing={() => ready && onSave()} />
      <View style={styles.igFormActions}>
        <TouchableOpacity testID={`token-save-${p.id}`} style={[styles.ssAddBtn, !ready && styles.faded]} disabled={!ready} onPress={onSave}>
          <Text style={styles.ssAddBtnText}>{busy ? "Checking…" : "Check and save"}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onCancel} disabled={busy}>
          <Text style={[styles.igLink, styles.pvMuted]}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

/** A provider's numbered setup checklist with its links; `redirect` (OAuth
 *  client setup) renders under the step that needs the redirect address. */
function SetupSteps({ p, steps = p.setup, redirect }: { p: IntegrationProvider; steps?: SetupStep[]; redirect?: React.ReactNode }) {
  const styles = useStyles()
  return (
    <View testID={`setup-${p.id}`} style={styles.igGap8}>
      {steps.map((st, i) => (
        <View key={i} style={styles.igStep}>
          <Text style={[styles.ssRowHint, styles.igStepNum]}>{i + 1}.</Text>
          <View style={styles.igStepBody}>
            <Text style={styles.igHint}>{st.text}</Text>
            {st.links.length ? (
              <View style={styles.igLinks}>
                {st.links.map((l) => (
                  <TouchableOpacity key={l.url} onPress={() => Linking.openURL(l.url)} hitSlop={6}>
                    <Text style={styles.igLink}>{l.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
            {st.redirect ? redirect : null}
          </View>
        </View>
      ))}
    </View>
  )
}

function toggled(set: Set<string>, id: string): Set<string> {
  const n = new Set(set)
  if (n.has(id)) n.delete(id)
  else n.add(id)
  return n
}
