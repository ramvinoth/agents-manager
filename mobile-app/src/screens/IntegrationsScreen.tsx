import React, { useEffect, useState } from "react"
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import * as Clipboard from "expo-clipboard"
import { api, type DriveClient, type DriveClientList } from "../api/client"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"
import { useStyles } from "./styles"

type Draft = { kind: string; client_id: string; client_secret: string }

/**
 * Integrations — where the owner enters Harman's OWN OAuth client for each
 * cloud-drive vendor (one per vendor, shared by every drive of that kind).
 * Reached from Profile and from the Files location picker (directly, or when a
 * connect attempt is refused because the vendor has no client yet). Shows the
 * one string the vendor console needs — this deployment's redirect URI — so
 * setup is copy/paste, not a server file. The secret is write-only: the server
 * reports only whether one is stored, and a save with the field blank keeps it.
 */
export default function IntegrationsScreen() {
  const styles = useStyles()
  const t = useTheme()
  const [clients, setClients] = useState<DriveClient[] | null>(null)
  const [redirectUri, setRedirectUri] = useState("")
  const [editing, setEditing] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState("")

  function apply(r: Partial<DriveClientList> & { error?: string }) {
    if (r.error) throw new Error(r.error)
    if (r.clients) setClients(r.clients)
    if (r.redirect_uri !== undefined) setRedirectUri(r.redirect_uri)
  }
  useEffect(() => {
    api.driveClients().then(apply).catch((e) => setError((e as Error).message))
  }, [])

  async function save() {
    if (!editing) return
    setBusy(true)
    setError("")
    try {
      const body: { kind: string; client_id: string; client_secret?: string } = { kind: editing.kind, client_id: editing.client_id.trim() }
      if (editing.client_secret.trim()) body.client_secret = editing.client_secret.trim()
      apply(await api.driveClientSave(body))
      setEditing(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function remove(c: DriveClient) {
    Alert.alert(`Forget the ${c.label} client?`, `Existing ${c.label} drives stay listed but cannot connect or refresh until a client is entered again.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Forget", style: "destructive",
        onPress: async () => {
          setError("")
          try { apply(await api.driveClientDelete(c.kind)) } catch (e) { setError((e as Error).message) }
        },
      },
    ])
  }

  async function copyUri() {
    await Clipboard.setStringAsync(redirectUri)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const current = editing ? clients?.find((c) => c.kind === editing.kind) : undefined

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Text style={[styles.ssRowHint, { paddingHorizontal: 18, paddingTop: 12, maxWidth: undefined }]}>
        Each cloud-drive vendor needs one OAuth client that identifies this Harman to it. Create the
        client in the vendor&apos;s developer console with the redirect URI below, then paste its id (and
        secret, where the vendor issues one) here. Every drive of that kind shares it.
      </Text>

      <Text style={styles.sheetSection}>REDIRECT URI TO REGISTER WITH EACH VENDOR</Text>
      <View style={[styles.profileInfoRow, { alignItems: "center" }]}>
        <Text testID="integrations-redirect-uri" selectable style={[styles.profileInfoValue, { color: t.text, flex: 1, textAlign: "left", fontFamily: "Menlo", fontSize: 12 }]}>
          {redirectUri || "…"}
        </Text>
        <TouchableOpacity testID="integrations-copy-uri" onPress={copyUri} disabled={!redirectUri} hitSlop={8} style={{ padding: 6 }}>
          <Icon name={copied ? "check" : "copy"} size={18} color={t.accent} />
        </TouchableOpacity>
      </View>

      <Text style={styles.sheetSection}>VENDOR CLIENTS</Text>
      {clients === null ? (
        <View style={{ padding: 18 }}><ActivityIndicator /></View>
      ) : editing ? (
        <View style={{ paddingHorizontal: 18, gap: 10 }}>
          <Text style={styles.ssRowLabel}>{current?.label} client</Text>
          <TextInput
            testID="integrations-client-id"
            style={styles.ssInput}
            value={editing.client_id}
            onChangeText={(client_id) => setEditing((d) => (d ? { ...d, client_id } : d))}
            placeholder={current?.public ? "App key / Application (client) ID" : "Client ID"}
            placeholderTextColor={t.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
          {current?.public ? (
            <Text style={styles.sheetHint}>{current.label} uses a public PKCE client — no secret is issued or needed.</Text>
          ) : (
            <TextInput
              testID="integrations-client-secret"
              style={styles.ssInput}
              value={editing.client_secret}
              onChangeText={(client_secret) => setEditing((d) => (d ? { ...d, client_secret } : d))}
              placeholder={current?.has_secret ? "Client secret (leave blank to keep current)" : "Client secret"}
              placeholderTextColor={t.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
          )}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 4 }}>
            <TouchableOpacity
              testID="integrations-save"
              style={[styles.ssAddBtn, { opacity: editing.client_id.trim() ? 1 : 0.5 }]}
              disabled={!editing.client_id.trim() || busy}
              onPress={save}
            >
              <Text style={styles.ssAddBtnText}>{busy ? "Saving…" : "Save"}</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="integrations-cancel" onPress={() => setEditing(null)} disabled={busy}>
              <Text style={{ color: t.textMuted, fontSize: 13, fontWeight: "600" }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        clients.map((c) => (
          <View key={c.kind} testID={`integrations-${c.kind}`} style={[styles.profileInfoRow, { alignItems: "center" }]}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={styles.ssRowLabel}>{c.label}</Text>
                <Text style={[styles.ssRowHint, { color: c.configured ? t.accent : t.textMuted }]}>
                  {c.configured ? "ready" : c.client_id ? "secret missing" : "not set up"}
                </Text>
              </View>
              {c.client_id ? <Text style={[styles.ssRowHint, { fontFamily: "Menlo", fontSize: 11 }]} numberOfLines={1}>{c.client_id}</Text> : null}
            </View>
            <TouchableOpacity testID={`integrations-edit-${c.kind}`} onPress={() => setEditing({ kind: c.kind, client_id: c.client_id, client_secret: "" })} hitSlop={8} style={{ padding: 6 }}>
              <Text style={{ color: t.accent, fontSize: 13, fontWeight: "600" }}>{c.client_id ? "Edit" : "Set up"}</Text>
            </TouchableOpacity>
            {c.client_id ? (
              <TouchableOpacity testID={`integrations-forget-${c.kind}`} onPress={() => remove(c)} hitSlop={8} style={{ padding: 6 }}>
                <Icon name="trash" size={18} color={t.danger} />
              </TouchableOpacity>
            ) : null}
          </View>
        ))
      )}
      {error ? <Text style={[styles.error, { paddingHorizontal: 18, marginTop: 10 }]}>{error}</Text> : null}
    </ScrollView>
  )
}
