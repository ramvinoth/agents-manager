import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, Linking, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from "react-native"
import * as Clipboard from "expo-clipboard"
import { api, type IntegrationConnection, type IntegrationProvider, type IntegrationService, type IntegrationsView, type LocalDisk, type ServiceState } from "../api/client"
import { useNavigation } from "@react-navigation/native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { providerHint, providerOpen, reconnectService, serviceAction, serviceSummary, tryPrompt, unavailableNote, waitForConsent } from "../lib/integrations"
import { resolveSessionPath } from "../lib/session"
import { useHost } from "../lib/useHost"
import { userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"
import { useStyles } from "./styles"

type Draft = { provider: string; client_id: string; client_secret: string }

/** iOS 26 draws a Switch ~12pt wider than the frame RN lays out, so it spills
 *  past the row's padding; this margin keeps it inside the card. */
const SWITCH_OVERHANG = Platform.OS === "ios" && Number(Platform.Version) >= 26 ? 12 : 0

/**
 * Integrations — the one place the owner connects outside accounts (Google,
 * Dropbox, Microsoft) and decides which services agents may use on each:
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
 * row folds to one line until tapped, so the page reads as the accounts. Tapping a line opens its details: one chip per
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

  function connect(service: string, connection?: string, op?: string) {
    return run(`${connection || "new"}:${service}${op ? `:${op}` : ""}`, async () => {
      const r = await api.integrationConnect({ service, connection, op })
      setConsenting(true)
      try {
        await Linking.openURL(r.url)
        await waitForConsent(() => api.driveOAuthStatus(r.pending), undefined, () => left.current)
        if (!connection && !left.current) setAdding(null) // the new account is listed; the add row has done its job
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
      const res = await api.newSession({ message: tryPrompt(s, c), cwd: "~", host, agent: "claude", title })
      const path = res.path ?? (await resolveSessionPath(res.session, host))
      if (!path) throw new Error("The chat started but its transcript wasn't found yet. Find it in Chats shortly.")
      api.renameSession({ session: path, title, host }).catch(() => {})
      if (!left.current) navigation.navigate("Thread", { host, label: title, path })
    })
  }

  const expand = (key: string, on: boolean) => setOpen((o) => {
    const n = new Set(o)
    if (on) n.add(key)
    else n.delete(key)
    return n
  })

  function toggle(conn: IntegrationConnection, service: string, on: boolean) {
    if (on) expand(`${conn.id}:${service}`, true)
    return run(`${conn.id}:${service}`, async () => { await api.integrationService({ connection: conn.id, service, on }) })
  }

  function disconnect(p: IntegrationProvider, conn: IntegrationConnection) {
    Alert.alert(`Disconnect ${conn.account || `this ${p.label} account`}?`,
      `Harman forgets its access; agents lose every ${p.label} service on it. Nothing in the account itself is touched.`, [
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
  const divider = { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border }

  if (view === null) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, padding: 18 }}>
        {error ? (
          <>
            <Text testID="integrations-error" style={styles.error}>{error}</Text>
            <TouchableOpacity onPress={() => { setError(""); load().catch((e) => setError(userError(e, "integrations"))) }} style={{ marginTop: 12 }}>
              <Text style={link}>Try again</Text>
            </TouchableOpacity>
          </>
        ) : <ActivityIndicator />}
      </View>
    )
  }

  const accounts = view.providers.flatMap((p) => p.connections.map((c) => ({ p, c })))

  return (
    <ScrollView testID="integrations-screen" style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
      <Text style={[styles.sheetHint, { marginTop: 12 }]}>
        Connect an account once; every agent chat can then use it, within the limits you set here.
      </Text>

      <Text style={styles.sheetSection}>ACCOUNTS</Text>
      {accounts.length === 0 ? (
        <Text style={styles.sheetHint}>None yet. Add one below — agents can use it the moment you sign in.</Text>
      ) : null}
      {accounts.map(({ p, c }) => (
        <View key={c.id} testID={`integration-conn-${c.id}`} style={styles.spCard}>
          <View style={styles.spCardHead}>
            <View style={styles.spCardIcon}><Icon name="cloud" size={16} color={t.textMuted} /></View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={styles.spCardTitle}>{c.account || `${p.label} account`}</Text>
              <Text style={styles.spCardSummary}>{p.label}</Text>
            </View>
            <TouchableOpacity testID={`integration-disconnect-${c.id}`} onPress={() => disconnect(p, c)} disabled={!!busy} hitSlop={8} style={{ padding: 4 }}
              accessibilityLabel={`Disconnect ${c.account || p.label}`}>
              <Icon name="trash" size={16} color={t.textMuted} />
            </TouchableOpacity>
          </View>
          {c.expired ? (
            <View testID={`expired-${c.id}`} style={{ flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 14, marginBottom: 10, padding: 10, borderRadius: 8, backgroundColor: t.danger + "1A" }}>
              <Text style={{ flex: 1, color: t.danger, fontSize: 13 }}>
                {p.label} ended this sign-in, so agents can't use it. Sign in again to restore it.
              </Text>
              <TouchableOpacity testID={`integration-reconnect-${c.id}`} disabled={!!busy} onPress={() => connect(reconnectService(p, c), c.id)} hitSlop={8}>
                <Text style={{ color: t.danger, fontSize: 13, fontWeight: "700", opacity: busy ? 0.5 : 1 }}>Reconnect</Text>
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
                    style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, opacity: busy ? 0.5 : 1 }}
                  >
                    {busy === `${key}:try` ? <ActivityIndicator size="small" /> : <Icon name="chat" size={14} color={t.accent} />}
                    <Text style={{ color: t.accent, fontSize: 13, fontWeight: "600" }}>Try it in a chat</Text>
                  </TouchableOpacity>
                ) : null}
              </ServiceRow>
            )
          })}
        </View>
      ))}

      <Text style={styles.sheetSection}>ADD AN ACCOUNT</Text>
      <View style={styles.spCard}>
        {view.providers.map((p, i) => {
          const isOpen = providerOpen(p, adding, accounts.length > 0)
          return (
          <View key={p.id} testID={`integration-${p.id}`} style={[{ paddingHorizontal: 14, paddingVertical: 12, gap: 8 }, i > 0 && divider]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <TouchableOpacity testID={`integration-open-${p.id}`} style={{ flex: 1 }} disabled={!p.client.configured}
                onPress={() => setAdding(adding === p.id ? null : p.id)} accessibilityRole="button" accessibilityState={{ expanded: isOpen }}>
                <Text style={styles.ssRowLabel}>{p.connections.length ? `Another ${p.label} account` : p.label}</Text>
                <Text style={[styles.ssRowHint, { maxWidth: undefined }]}>{providerHint(p, isOpen)}</Text>
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
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {p.services.filter((s) => s.available).map((s) => (
                  <TouchableOpacity
                    key={s.id}
                    testID={`integration-new-${s.id}`}
                    style={[styles.filterChip, { flexDirection: "row", alignItems: "center", gap: 4, opacity: busy ? 0.5 : 1 }]}
                    disabled={!!busy}
                    onPress={() => connect(s.id)}
                  >
                    {busy === `new:${s.id}` ? <ActivityIndicator size="small" /> : <Icon name="plus" size={12} color={t.textMuted} />}
                    <Text style={styles.filterChipText}>{s.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
            {isOpen && unavailableNote(p) ? <Text testID={`integration-unavailable-${p.id}`} style={[styles.ssRowHint, { maxWidth: undefined, marginTop: 0 }]}>{unavailableNote(p)}</Text> : null}
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
      </View>

      <LocalDiskSection local={view.local} busy={busy === "local"} disabled={!!busy} onSave={setLocal} />

      {consenting ? (
        <Text style={[styles.sheetHint, { marginTop: 10 }]}>
          Finish signing in in the browser, then come back — this screen updates on its own.
        </Text>
      ) : null}
      {error ? <Text testID="integrations-error" style={[styles.error, { paddingHorizontal: 18, marginTop: 10 }]}>{error}</Text> : null}
    </ScrollView>
  )
}

/** One service on one account: a single line saying what agents may do there
 *  now, with its switch (or Grant access). Tapping the line opens the details —
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
    <View testID={`service-${s.id}`} style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, gap: 10 }}>
        <TouchableOpacity testID={`service-expand-${s.id}`} onPress={() => onExpand(!expanded)} style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6 }}
          accessibilityRole="button" accessibilityState={{ expanded }}>
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={14} color={t.textMuted} />
          <View style={{ flex: 1 }}>
            <Text style={styles.ssRowLabel}>{s.label}</Text>
            <Text numberOfLines={1} style={[styles.ssRowHint, { maxWidth: undefined }, state === "on" && { color: t.text }]}>{summary}</Text>
          </View>
        </TouchableOpacity>
        {busy ? (
          <ActivityIndicator />
        ) : action === "toggle" ? (
          <Switch testID={`service-switch-${s.id}`} value={state === "on"} disabled={disabled} onValueChange={onToggle} trackColor={{ true: t.accent, false: t.border }}
            style={{ marginRight: SWITCH_OVERHANG }} />
        ) : action === "grant" ? (
          <TouchableOpacity testID={`service-grant-${s.id}`} onPress={onGrant} disabled={disabled} hitSlop={8}>
            <Text style={{ color: t.accent, fontSize: 13, fontWeight: "600", opacity: disabled ? 0.5 : 1 }}>Grant access</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {expanded ? (
        <View style={{ paddingLeft: 34, paddingRight: 14, paddingBottom: 12, gap: 8 }}>
          <Text style={[styles.ssRowHint, { maxWidth: undefined, marginTop: 0 }]}>{s.available ? s.agent : s.unavailable}</Text>
          {children}
        </View>
      ) : null}
    </View>
  )
}

/** What agents may do with one switched-on service on one account: a chip per
 *  operation. Filled = allowed, outlined = not, "+" = needs a wider grant. */
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
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <Text style={[styles.ssRowHint, { maxWidth: undefined, marginTop: 0 }]}>Agents may</Text>
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
            style={[styles.filterChip, on && styles.filterChipActive, { flexDirection: "row", alignItems: "center", gap: 4, opacity: busy && busy !== busyPrefix + o.id ? 0.5 : 1 }]}
          >
            {busy === busyPrefix + o.id ? <ActivityIndicator size="small" />
              : <Icon name={action === "grant" ? "plus" : on ? "check" : "close"} size={12} color={on ? t.onAccent : t.textMuted} />}
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
      <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 4 }}>
        <Icon name="folder" size={14} color={t.textMuted} />
        <Text testID={`root-${conn.id}`} numberOfLines={1} style={[styles.ssRowHint, { flex: 1, marginLeft: 6, maxWidth: undefined }]}>
          {conn.root === "/" ? "Whole account" : `Only ${conn.root}`}
        </Text>
        {busy ? <ActivityIndicator /> : (
          <TouchableOpacity testID={`root-edit-${conn.id}`} disabled={disabled} hitSlop={8} onPress={() => setDraft(conn.root === "/" ? "" : conn.root)}>
            <Text style={{ color: t.accent, fontSize: 13, fontWeight: "600" }}>Limit to a folder</Text>
          </TouchableOpacity>
        )}
      </View>
    )
  }
  const save = () => { onSave(draft.trim() || "/"); setDraft(null) }
  return (
    <View style={{ gap: 6 }}>
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
      <View style={{ flexDirection: "row", gap: 14, alignItems: "center" }}>
        <TouchableOpacity testID={`root-save-${conn.id}`} style={styles.ssAddBtn} onPress={save}>
          <Text style={styles.ssAddBtnText}>Save</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setDraft(null)}>
          <Text style={{ color: t.textMuted, fontSize: 13, fontWeight: "600" }}>Cancel</Text>
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
        Folders agents may use on the computer running Harman{local.roots.length ? "" : " — none yet, so agents can't touch its disk"}. Limits apply to agents only, never to you.
      </Text>
      <View style={styles.spCard}>
      {local.roots.map((r, i) => (
        <View key={r} style={[styles.profileInfoRow, { alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderTopColor: t.border }]}>
          <Icon name="folder" size={16} color={t.textMuted} />
          <Text testID={`local-root-${i}`} numberOfLines={1} style={[styles.profileInfoValue, { color: t.text, flex: 1, marginLeft: 8, textAlign: "left" }]}>{r}</Text>
          <TouchableOpacity testID={`local-remove-${i}`} disabled={disabled} hitSlop={8} style={{ padding: 4 }}
            onPress={() => onSave(local.roots.filter((x) => x !== r), ops)} accessibilityLabel={`Remove ${r}`}>
            <Icon name="trash" size={16} color={t.textMuted} />
          </TouchableOpacity>
        </View>
      ))}
      {adding === null ? (
        <TouchableOpacity testID="local-add-open" disabled={disabled} onPress={() => setAdding("")}
          style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: local.roots.length ? StyleSheet.hairlineWidth : 0, borderTopColor: t.border }}>
          {busy ? <ActivityIndicator size="small" /> : <Icon name="plus" size={16} color={t.accent} />}
          <Text style={{ color: t.accent, fontSize: 15, fontWeight: "600" }}>Add a folder</Text>
        </TouchableOpacity>
      ) : (
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingVertical: 10, alignItems: "center", borderTopWidth: local.roots.length ? StyleSheet.hairlineWidth : 0, borderTopColor: t.border }}>
        <TextInput
          testID="local-add-input"
          autoFocus
          style={[styles.ssInput, { flex: 1, marginHorizontal: 0, marginTop: 0 }]}
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
        <TouchableOpacity testID="local-add" style={[styles.ssAddBtn, { opacity: adding.trim() && !disabled ? 1 : 0.5 }]} disabled={!adding.trim() || disabled} onPress={add}>
          <Text style={styles.ssAddBtnText}>Add</Text>
        </TouchableOpacity>
      </View>
      )}
      <View style={{ paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border }}>
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
    <View style={{ gap: 10, padding: 12, borderRadius: 10, backgroundColor: t.bg }}>
      <View testID={`setup-${p.id}`} style={{ gap: 8 }}>
        {p.setup.map((st, i) => (
          <View key={i} style={{ flexDirection: "row", gap: 6 }}>
            <Text style={[styles.ssRowHint, { width: 16 }]}>{i + 1}.</Text>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={[styles.ssRowHint, { maxWidth: undefined }]}>{st.text}</Text>
              {st.links.length ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
                  {st.links.map((l) => (
                    <TouchableOpacity key={l.url} onPress={() => Linking.openURL(l.url)} hitSlop={6}>
                      <Text style={{ color: t.accent, fontSize: 13, fontWeight: "600" }}>{l.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
              {st.redirect ? (
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Text testID="integrations-redirect-uri" selectable style={{ color: t.text, flex: 1, fontFamily: "Menlo", fontSize: 12 }}>
                    {redirectUri || "…"}
                  </Text>
                  <TouchableOpacity testID="integrations-copy-uri" onPress={onCopy} disabled={!redirectUri} hitSlop={8} style={{ padding: 6 }}>
                    <Icon name={copied ? "check" : "copy"} size={18} color={t.accent} />
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          </View>
        ))}
      </View>
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
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 4 }}>
        <TouchableOpacity
          testID="integrations-save"
          style={[styles.ssAddBtn, { opacity: canSave ? 1 : 0.5 }]}
          disabled={!canSave}
          onPress={onSave}
        >
          <Text style={styles.ssAddBtnText}>{busy ? "Saving…" : "Save"}</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="integrations-cancel" onPress={onCancel} disabled={busy}>
          <Text style={{ color: t.textMuted, fontSize: 13, fontWeight: "600" }}>Cancel</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        {p.client.client_id ? (
          <TouchableOpacity testID={`integrations-forget-${p.id}`} onPress={onForget} disabled={busy} hitSlop={8}>
            <Icon name="trash" size={18} color={t.danger} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  )
}
