import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, Linking, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from "react-native"
import * as Clipboard from "expo-clipboard"
import { api, type IntegrationConnection, type IntegrationProvider, type IntegrationService, type IntegrationsView, type ServiceState } from "../api/client"
import { serviceAction, waitForConsent } from "../lib/integrations"
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
 * Per provider: its OAuth client (entered once, with this deployment's
 * redirect URI), then each signed-in account with a row per service. A granted
 * service is a switch (the grant is kept); a missing one runs consent in the
 * system browser that ADDS the permission and keeps the rest; an unavailable
 * one (Google Keep) says why. Reached from Profile and the Files location picker.
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

  function connect(service: string, connection?: string) {
    return run(`${connection || "new"}:${service}`, async () => {
      const r = await api.integrationConnect({ service, connection })
      setConsenting(true)
      try {
        await Linking.openURL(r.url)
        await waitForConsent(() => api.driveOAuthStatus(r.pending), undefined, () => left.current)
      } finally {
        if (!left.current) setConsenting(false)
      }
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
              {p.client.client_id ? "Client secret missing. " : ""}Set up the {p.label} client to connect: {p.services.map((s) => s.label).join(", ")}.
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
      <Text style={[styles.ssRowHint, { maxWidth: undefined }]}>
        Create an OAuth client in the {p.label} developer console, register this redirect URI on it, then
        paste its id{p.public ? "" : " and secret"} here.{p.id === "google" ? " Enable the Drive, Gmail and Calendar APIs in the same project." : ""}
      </Text>
      <TouchableOpacity onPress={() => Linking.openURL(p.console)}>
        <Text style={{ color: t.accent, fontSize: 13, fontWeight: "600" }}>Open the {p.label} console</Text>
      </TouchableOpacity>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text testID="integrations-redirect-uri" selectable style={{ color: t.text, flex: 1, fontFamily: "Menlo", fontSize: 12 }}>
          {redirectUri || "…"}
        </Text>
        <TouchableOpacity testID="integrations-copy-uri" onPress={onCopy} disabled={!redirectUri} hitSlop={8} style={{ padding: 6 }}>
          <Icon name={copied ? "check" : "copy"} size={18} color={t.accent} />
        </TouchableOpacity>
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
      {p.public ? (
        <Text style={styles.sheetHint}>{p.label} uses a public PKCE client — no secret is issued or needed.</Text>
      ) : (
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
      )}
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
