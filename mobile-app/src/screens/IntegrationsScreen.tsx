import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, Linking, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from "react-native"
import * as Clipboard from "expo-clipboard"
import { api, type IntegrationConnection, type IntegrationProvider, type IntegrationService, type IntegrationsView, type LocalDisk, type ServiceState } from "../api/client"
import { useNavigation } from "@react-navigation/native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { reconnectService, serviceAction, setupHint, tryPrompt, waitForConsent } from "../lib/integrations"
import { resolveSessionPath } from "../lib/session"
import { useHost } from "../lib/useHost"
import { userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"
import { useStyles } from "./styles"

type Draft = { provider: string; client_id: string; client_secret: string }

/**
 * Integrations — the one place the owner connects outside accounts (Google,
 * Dropbox, Microsoft) and decides which services agents may use on each:
 * Drive/Dropbox/OneDrive files, Gmail (read + drafts, never send), Calendar
 * (read). Renders GET /api/integrations verbatim — the server owns the catalog
 * and every rule, so a new service needs no app change. Twin of the web
 * IntegrationsDialog; both share lib/integrations for the state→control map
 * and the consent wait.
 *
 * Per provider: its OAuth client (entered once, by following the server's
 * numbered setup checklist with deep links and this deployment's redirect
 * URI), then each signed-in account (a red Reconnect banner when the vendor
 * ended its sign-in), then each signed-in account with a row per service. A granted
 * service is a switch (the grant is kept); a missing one runs consent in the
 * system browser that ADDS the permission and keeps the rest; an unavailable
 * one (Google Keep) says why. Under a switched-on service, one chip per
 * operation (read, write, delete, create…) says what AGENTS may do there; a
 * chip that needs a wider grant runs consent for just that op. A files account
 * can be narrowed to one folder. Last, "This machine": the folders agents may
 * touch on the local disk and what they may do in them. Reached from the side
 * menu and the Files location picker.
 */
export default function IntegrationsScreen() {
  const styles = useStyles()
  const t = useTheme()
  const [view, setView] = useState<IntegrationsView | null>(null)
  const [editing, setEditing] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // key of the control mid-request
  const [copied, setCopied] = useState(false)
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

  function toggle(conn: IntegrationConnection, service: string, on: boolean) {
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

  return (
    <ScrollView testID="integrations-screen" style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
      <Text style={[styles.ssRowHint, { paddingHorizontal: 18, paddingTop: 12, maxWidth: undefined }]}>
        Connect your accounts and choose what agents may use on each. Mail is draft-only: agents write
        drafts, you press Send in Gmail.
      </Text>

      {view.providers.map((p) => (
        <View key={p.id} testID={`integration-${p.id}`}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingRight: 18, marginTop: 16, marginBottom: 6 }}>
            <Text style={[styles.sheetSection, { flex: 1, marginTop: 0, marginBottom: 0 }]}>{p.label.toUpperCase()}</Text>
            <TouchableOpacity
              testID={`integrations-edit-${p.id}`}
              onPress={() => setEditing({ provider: p.id, client_id: p.client.client_id, client_secret: "" })}
              disabled={!!busy}
              hitSlop={8}
            >
              <Text style={[link, { fontSize: 12 }]}>{p.client.client_id ? "Edit client" : "Set up client"}</Text>
            </TouchableOpacity>
          </View>

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
          ) : !p.client.configured ? (
            <Text style={[styles.ssRowHint, { paddingHorizontal: 18, maxWidth: undefined }]}>
              {p.client.client_id ? "Client secret missing. " : ""}{setupHint(p)}
            </Text>
          ) : (
            <>
              {p.connections.map((c) => (
                <View key={c.id} testID={`integration-conn-${c.id}`} style={{ marginBottom: 6 }}>
                  <View style={[styles.profileInfoRow, { alignItems: "center" }]}>
                    <Icon name="user" size={16} color={t.textMuted} />
                    <Text numberOfLines={1} style={[styles.profileInfoValue, { color: t.text, flex: 1, marginLeft: 8, textAlign: "left" }]}>
                      {c.account || `${p.label} account`}
                    </Text>
                    <TouchableOpacity testID={`integration-disconnect-${c.id}`} onPress={() => disconnect(p, c)} disabled={!!busy} hitSlop={8} style={{ padding: 4 }}>
                      <Icon name="trash" size={16} color={t.danger} />
                    </TouchableOpacity>
                  </View>
                  {c.expired ? (
                    <View testID={`expired-${c.id}`} style={{ flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 18, marginBottom: 6, padding: 10, borderRadius: 8, backgroundColor: t.danger + "1A" }}>
                      <Text style={{ flex: 1, color: t.danger, fontSize: 13 }}>
                        {p.label} ended this sign-in, so agents can't use it. Sign in again to restore it.
                      </Text>
                      <TouchableOpacity testID={`integration-reconnect-${c.id}`} disabled={!!busy} onPress={() => connect(reconnectService(p, c), c.id)} hitSlop={8}>
                        <Text style={{ color: t.danger, fontSize: 13, fontWeight: "700", opacity: busy ? 0.5 : 1 }}>Reconnect</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                  {p.services.map((s) => (
                    <React.Fragment key={s.id}>
                      <ServiceRow
                        s={s}
                        state={c.services[s.id] || "grant"}
                        busy={busy === `${c.id}:${s.id}`}
                        disabled={!!busy}
                        onToggle={(on) => toggle(c, s.id, on)}
                        onGrant={() => connect(s.id, c.id)}
                      />
                      {c.services[s.id] === "on" && s.ops.length ? (
                        <OpChips
                          testPrefix={`op-${c.id}-${s.id}`}
                          ops={s.ops.map((o) => ({ ...o, state: c.ops[s.id]?.[o.id] || "grant" }))}
                          busy={busy}
                          busyPrefix={`${c.id}:${s.id}:`}
                          onToggle={(op, on) => setOp(c, s.id, op, on)}
                          onGrant={(op) => connect(s.id, c.id, op)}
                        />
                      ) : null}
                      {c.services[s.id] === "on" && s.try && !c.expired ? (
                        <TouchableOpacity
                          testID={`try-${c.id}-${s.id}`}
                          onPress={() => tryInChat(s, c)}
                          disabled={!!busy}
                          hitSlop={8}
                          style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 42, paddingVertical: 6, opacity: busy ? 0.5 : 1 }}
                        >
                          {busy === `${c.id}:${s.id}:try` ? <ActivityIndicator size="small" /> : <Icon name="chat" size={14} color={t.accent} />}
                          <Text style={{ color: t.accent, fontSize: 13, fontWeight: "600" }}>Try it in a chat</Text>
                        </TouchableOpacity>
                      ) : null}
                      {c.services[s.id] === "on" && s.kind === "files" ? (
                        <RootRow conn={c} busy={busy === `${c.id}:root`} disabled={!!busy} onSave={(root) => setRoot(c, root)} />
                      ) : null}
                    </React.Fragment>
                  ))}
                </View>
              ))}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 18, paddingVertical: 6, alignItems: "center" }}>
                <Text style={styles.ssRowHint}>{p.connections.length ? "Add another account with" : "Connect an account with"}</Text>
                {p.services.filter((s) => s.available).map((s) => (
                  <TouchableOpacity
                    key={s.id}
                    testID={`integration-new-${s.id}`}
                    style={[styles.ssAddBtn, { opacity: busy ? 0.5 : 1, flexDirection: "row", alignItems: "center", gap: 4 }]}
                    disabled={!!busy}
                    onPress={() => connect(s.id)}
                  >
                    {busy === `new:${s.id}` ? <ActivityIndicator size="small" /> : <Icon name="plus" size={14} color={t.onAccent} />}
                    <Text style={styles.ssAddBtnText}>{s.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}
        </View>
      ))}

      <LocalDiskSection local={view.local} busy={busy === "local"} disabled={!!busy} onSave={setLocal} />

      {consenting ? (
        <Text style={[styles.ssRowHint, { paddingHorizontal: 18, marginTop: 10, maxWidth: undefined }]}>
          Finish signing in in the browser, then come back — this screen updates on its own.
        </Text>
      ) : null}
      {error ? <Text testID="integrations-error" style={[styles.error, { paddingHorizontal: 18, marginTop: 10 }]}>{error}</Text> : null}
    </ScrollView>
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
  const styles = useStyles()
  const t = useTheme()
  const action = serviceAction(state)
  return (
    <View testID={`service-${s.id}`} style={[styles.profileInfoRow, { alignItems: "center", paddingLeft: 42 }]}>
      <View style={{ flex: 1, marginRight: 10 }}>
        <Text style={styles.ssRowLabel}>{s.label}</Text>
        <Text style={[styles.ssRowHint, { maxWidth: undefined }]}>{s.available ? s.agent : s.unavailable}</Text>
      </View>
      {busy ? (
        <ActivityIndicator />
      ) : action === "toggle" ? (
        <Switch testID={`service-switch-${s.id}`} value={state === "on"} disabled={disabled} onValueChange={onToggle} trackColor={{ true: t.accent, false: t.border }} />
      ) : action === "grant" ? (
        <TouchableOpacity testID={`service-grant-${s.id}`} onPress={onGrant} disabled={disabled} hitSlop={8}>
          <Text style={{ color: t.accent, fontSize: 13, fontWeight: "600", opacity: disabled ? 0.5 : 1 }}>Grant access</Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.ssRowHint}>Not available</Text>
      )}
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
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingLeft: 42, paddingRight: 18, paddingBottom: 8 }}>
      <Text style={[styles.ssRowHint, { width: "100%", maxWidth: undefined }]}>Agents may</Text>
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
      <View style={[styles.profileInfoRow, { alignItems: "center", paddingLeft: 42 }]}>
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
    <View style={{ paddingLeft: 42, paddingRight: 18, paddingBottom: 8, gap: 6 }}>
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
  const [adding, setAdding] = useState("")
  const ops = local.ops.filter((o) => o.on).map((o) => o.id)
  const add = () => {
    const r = adding.trim()
    if (!r) return
    onSave([...local.roots, r], ops)
    setAdding("")
  }
  return (
    <View testID="integration-local">
      <Text style={[styles.sheetSection, { marginTop: 16, marginBottom: 6 }]}>THIS MACHINE</Text>
      <Text style={[styles.ssRowHint, { paddingHorizontal: 18, maxWidth: undefined }]}>
        Folders agents may work in on this computer{local.roots.length ? "" : " — none, so agents cannot touch the disk"}. You are never limited.
      </Text>
      {local.roots.map((r, i) => (
        <View key={r} style={[styles.profileInfoRow, { alignItems: "center" }]}>
          <Icon name="folder" size={16} color={t.textMuted} />
          <Text testID={`local-root-${i}`} numberOfLines={1} style={[styles.profileInfoValue, { color: t.text, flex: 1, marginLeft: 8, textAlign: "left" }]}>{r}</Text>
          <TouchableOpacity testID={`local-remove-${i}`} disabled={disabled} hitSlop={8} style={{ padding: 4 }}
            onPress={() => onSave(local.roots.filter((x) => x !== r), ops)}>
            <Icon name="trash" size={16} color={t.danger} />
          </TouchableOpacity>
        </View>
      ))}
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 18, paddingVertical: 6, alignItems: "center" }}>
        <TextInput
          testID="local-add-input"
          style={[styles.ssInput, { flex: 1 }]}
          value={adding}
          onChangeText={setAdding}
          placeholder="~/Projects"
          placeholderTextColor={t.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={add}
        />
        <TouchableOpacity testID="local-add" style={[styles.ssAddBtn, { opacity: adding.trim() && !disabled ? 1 : 0.5 }]} disabled={!adding.trim() || disabled} onPress={add}>
          {busy ? <ActivityIndicator size="small" /> : <Text style={styles.ssAddBtnText}>Add</Text>}
        </TouchableOpacity>
      </View>
      <OpChips
        testPrefix="local-op"
        ops={local.ops.map((o) => ({ id: o.id, label: o.label, state: o.on ? "on" : "off" }))}
        busy={busy ? "local" : null}
        busyPrefix="local:"
        onToggle={(op, on) => onSave(local.roots, on ? [...ops, op] : ops.filter((x) => x !== op))}
      />
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
    <View style={{ paddingHorizontal: 18, gap: 10 }}>
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
