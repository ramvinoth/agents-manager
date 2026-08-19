import React, { useEffect, useState } from "react"
import { Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Provider } from "../api/client"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "Providers">

type Draft = { id: string; name: string; baseUrl: string; apiKey: string; model: string; contextLimit: string }

/**
 * The GLOBAL provider library — add / edit / delete the custom model endpoints
 * (Qwen, LiteLLM, BrainTwin, …) that any chat session can then pick from. This is
 * the single home for provider CRUD: an individual session only SELECTS from this
 * list (see ProviderPicker), it never edits it. Backed entirely by /api/providers
 * (server-side source of truth in ~/.claude/.viewer-providers.json) — nothing is
 * cached or hardcoded on the device.
 *
 * "Default (Claude)" is not a stored provider; it's the built-in Claude login
 * (provider = ""), shown here as a pinned, non-editable header for orientation.
 */
export default function ProvidersScreen({ navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()

  const [providers, setProviders] = useState<Provider[]>([])
  const [editing, setEditing] = useState<Draft | null>(null) // null = list view; Draft = editor open
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [savingProvider, setSavingProvider] = useState(false)
  const [customModel, setCustomModel] = useState(false)

  useEffect(() => {
    api.providers().then((r) => setProviders(r.providers || [])).catch(() => {})
  }, [])

  // Open the editor: blank for a new preset, or pre-filled to edit one. The apiKey
  // is never returned by the server, so the field starts empty and an empty value
  // on save means "keep the existing key".
  function openEditor(p?: Provider) {
    setModelOptions([])
    setCustomModel(false)
    setEditing(
      p
        ? { id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: "", model: p.model, contextLimit: p.contextLimit ? String(p.contextLimit) : "" }
        : { id: "", name: "", baseUrl: "", apiKey: "", model: "", contextLimit: "" }
    )
  }

  // Populate the model dropdown from the endpoint (fetched server-side so the key
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

  // Create or update the preset in the shared library. Unlike the old per-session
  // editor, this does NOT select the preset for any session — it only manages the list.
  function saveProvider() {
    if (!editing) return
    const name = editing.name.trim()
    const baseUrl = editing.baseUrl.trim()
    const model = editing.model.trim()
    if (!baseUrl || !model) return
    setSavingProvider(true)
    api
      .providerSave({
        id: editing.id || undefined,
        name: name || baseUrl,
        baseUrl,
        model,
        ...(editing.apiKey.trim() ? { apiKey: editing.apiKey.trim() } : {}),
        // Always send contextLimit so clearing the field (→ 0) actually clears it.
        contextLimit: Math.max(0, parseInt(editing.contextLimit.trim(), 10) || 0),
      })
      .then((saved) => {
        if (saved.error) return
        setProviders((all) => {
          const rest = all.filter((x) => x.id !== saved.id)
          return [...rest, saved].sort((a, b) => a.name.localeCompare(b.name))
        })
        setEditing(null)
      })
      .catch(() => {})
      .finally(() => setSavingProvider(false))
  }

  function deleteProvider(p: Provider) {
    Alert.alert(p.name, "Delete this provider? Sessions using it fall back to Default (Claude).", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setProviders((all) => all.filter((x) => x.id !== p.id))
          if (editing?.id === p.id) setEditing(null)
          api.providerDelete(p.id).catch(() => {})
        },
      },
    ])
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 40 }}>
      <Text style={styles.sheetHint}>
        Providers route a session to your own model endpoint. Manage them here; pick one per chat in its
        settings.
      </Text>

      {/* Default (Claude) — the built-in login, not a stored provider. */}
      <Text style={styles.sheetSection}>DEFAULT</Text>
      <View style={styles.profileInfoRow}>
        <Icon name="sparkle" size={18} color={t.accent} />
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={{ color: t.text, fontWeight: "600" }}>Default (Claude)</Text>
          <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 1 }}>Uses your Claude login. Always available.</Text>
        </View>
      </View>

      {/* Custom providers — the editable library. */}
      <Text style={styles.sheetSection}>PROVIDERS</Text>
      {providers.length ? providers.map((p) => (
        <View key={p.id} style={styles.profileInfoRow}>
          <Icon name="server" size={18} color={t.accent} />
          <TouchableOpacity
            testID={`provider-edit-${p.id}`}
            style={{ flex: 1, marginLeft: 10 }}
            onPress={() => openEditor(p)}
          >
            <Text style={{ color: t.text, fontWeight: "600" }}>{p.name}</Text>
            <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 1 }} numberOfLines={1}>{p.baseUrl}</Text>
          </TouchableOpacity>
          <TouchableOpacity testID={`provider-delete-${p.id}`} onPress={() => deleteProvider(p)} hitSlop={8} style={{ marginRight: 6 }}>
            <Icon name="trash" size={17} color={t.danger} />
          </TouchableOpacity>
          <TouchableOpacity testID={`provider-edit-chevron-${p.id}`} onPress={() => openEditor(p)} hitSlop={8}>
            <Icon name="chevronRight" size={18} color={t.textMuted} />
          </TouchableOpacity>
        </View>
      )) : (
        <Text style={[styles.sheetHint, { fontStyle: "italic" }]}>No custom providers yet.</Text>
      )}

      {!editing ? (
        <TouchableOpacity testID="provider-add" style={[styles.ssAddBtn, { alignSelf: "flex-start", marginHorizontal: 18, marginTop: 14 }]} onPress={() => openEditor()}>
          <Text style={styles.ssAddBtnText}>+ Add provider</Text>
        </TouchableOpacity>
      ) : null}

      {/* Editor — create or edit one provider. */}
      {editing ? (
        <View style={{ paddingHorizontal: 18, gap: 8, marginTop: 16 }}>
          <Text style={styles.sheetSection}>{editing.id ? "EDIT PROVIDER" : "NEW PROVIDER"}</Text>
          <TextInput
            testID="provider-name"
            style={styles.ssInput}
            value={editing.name}
            onChangeText={(v) => setEditing((e) => (e ? { ...e, name: v } : e))}
            placeholder="Name (e.g. Qwen 3.8-27B)"
            placeholderTextColor={t.textMuted}
          />
          <TextInput
            testID="provider-baseurl"
            style={styles.ssInput}
            value={editing.baseUrl}
            onChangeText={(v) => setEditing((e) => (e ? { ...e, baseUrl: v } : e))}
            placeholder="Base URL (https://inference.braintwin.ai)"
            placeholderTextColor={t.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <TextInput
            testID="provider-key"
            style={styles.ssInput}
            value={editing.apiKey}
            onChangeText={(v) => setEditing((e) => (e ? { ...e, apiKey: v } : e))}
            placeholder={editing.id ? "API key (leave blank to keep current)" : "API key (sk-…, optional)"}
            placeholderTextColor={t.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <TouchableOpacity
              testID="provider-load-models"
              style={[styles.ssAddBtn, { opacity: editing.baseUrl.trim() ? 1 : 0.5 }]}
              disabled={!editing.baseUrl.trim() || loadingModels}
              onPress={loadModels}
            >
              <Text style={styles.ssAddBtnText}>{loadingModels ? "Loading…" : "Load models"}</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="provider-model-custom" onPress={() => setCustomModel((c) => !c)}>
              <Text style={{ color: t.accent, fontSize: 13, fontWeight: "600" }}>
                {customModel ? "Pick from list" : "Enter manually"}
              </Text>
            </TouchableOpacity>
          </View>
          {customModel || (!modelOptions.length && !!editing.model) ? (
            <TextInput
              testID="provider-model-input"
              style={styles.ssInput}
              value={editing.model}
              onChangeText={(v) => setEditing((e) => (e ? { ...e, model: v } : e))}
              placeholder="Model name (e.g. qwen3.8-27b)"
              placeholderTextColor={t.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
          ) : modelOptions.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
              {modelOptions.map((m) => {
                const active = editing.model === m
                return (
                  <TouchableOpacity
                    key={m}
                    testID={`provider-model-${m}`}
                    style={[styles.sheetPill, active ? styles.sheetPillActive : null]}
                    onPress={() => setEditing((e) => (e ? { ...e, model: m } : e))}
                  >
                    <Text style={[styles.sheetPillText, active ? styles.sheetPillTextActive : null]}>{m}</Text>
                  </TouchableOpacity>
                )
              })}
            </ScrollView>
          ) : (
            <Text style={styles.sheetHint}>Load models from the endpoint, or tap “Enter manually”.</Text>
          )}
          <TextInput
            testID="provider-context-limit"
            style={styles.ssInput}
            value={editing.contextLimit}
            onChangeText={(v) => setEditing((e) => (e ? { ...e, contextLimit: v.replace(/[^0-9]/g, "") } : e))}
            placeholder="Context limit (tokens, e.g. 242000)"
            placeholderTextColor={t.textMuted}
            keyboardType="number-pad"
          />
          <Text style={styles.sheetHint}>
            The endpoint&apos;s real max context. Lets the agent compact before overflowing it. Leave blank if unsure.
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 4 }}>
            <TouchableOpacity
              testID="provider-save"
              style={[styles.ssAddBtn, { opacity: editing.baseUrl.trim() && editing.model.trim() ? 1 : 0.5 }]}
              disabled={!editing.baseUrl.trim() || !editing.model.trim() || savingProvider}
              onPress={saveProvider}
            >
              <Text style={styles.ssAddBtnText}>{savingProvider ? "Saving…" : "Save"}</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="provider-cancel" onPress={() => setEditing(null)}>
              <Text style={{ color: t.textMuted, fontSize: 13, fontWeight: "600" }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </ScrollView>
  )
}
