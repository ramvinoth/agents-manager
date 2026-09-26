import React, { useEffect, useRef, useState } from "react"
import { Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Provider } from "../api/client"
import { aiError, connectionPayload, type KeyAction } from "../lib/aiSelection"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "Providers">

type Draft = { id: string; name: string; baseUrl: string; apiKey: string; model: string; contextLimit: string; originalUrl: string; originalContext: string; apiKeyAction: KeyAction }

/** Shared server connections. Selecting AI for a chat never edits these presets. */
export default function ProvidersScreen({ navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()

  const [providers, setProviders] = useState<Provider[]>([])
  const [editing, setEditing] = useState<Draft | null>(null) // null = list view; Draft = editor open
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [savingProvider, setSavingProvider] = useState(false)
  const [customModel, setCustomModel] = useState(false)

  const [error, setError] = useState("")
  const [discoveryStatus, setDiscoveryStatus] = useState("")
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => {
    api.providers().then((r) => setProviders(r.providers || [])).catch(e => setError(aiError(e)))
  }, [])

  // Open the editor: blank for a new preset, or pre-filled to edit one. The apiKey
  // is never returned by the server, so the field starts empty and an empty value
  // on save means "keep the existing key".
  function openEditor(p?: Provider) {
    generation.current++; setLoadingModels(false); setError(""); setDiscoveryStatus("")
    setModelOptions([])
    setCustomModel(false)
    setEditing(
      p
        ? { id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: "", model: p.model, contextLimit: p.contextLimit ? String(p.contextLimit) : "", originalContext: p.contextLimit ? String(p.contextLimit) : "", originalUrl: p.baseUrl, apiKeyAction: "keep" }
        : { id: "", name: "", baseUrl: "", apiKey: "", model: "", contextLimit: "", originalContext: "", originalUrl: "", apiKeyAction: "remove" }
    )
  }

  function changeDraft(change: Partial<Draft>) {
    generation.current++; setLoadingModels(false); setModelOptions([]); setDiscoveryStatus("")
    setEditing(e => e ? {...e, ...change} : e)
  }
  async function loadModels() {
    if (!editing) return
    const request = ++generation.current
    setLoadingModels(true); setError("")
    try {
      const result = await api.providerDraftModels(connectionPayload(editing, editing.originalUrl))
      if (request !== generation.current) return
      if (!result.status) throw new Error("Server update required for draft model discovery.")
      setModelOptions(result.models || [])
      setDiscoveryStatus(result.status === "error" ? result.error || "Discovery failed" : result.status === "empty" ? "No models returned. Enter a model ID manually." : result.status === "unsupported" ? "Discovery unsupported. Enter a model ID manually." : "Models loaded from the draft endpoint.")
      if (result.status !== "ok") setCustomModel(true)
    } catch (e) { if (request === generation.current) { setError(aiError(e)); setCustomModel(true) } }
    finally { if (request === generation.current) setLoadingModels(false) }
  }
  async function saveProvider() {
    if (!editing || savingProvider) return
    setSavingProvider(true); setError("")
    try {
      const saved = await api.providerSave({
        ...connectionPayload(editing, editing.originalUrl), name: editing.name.trim() || editing.baseUrl.trim(), model: editing.model.trim(),
        ...(editing.contextLimit !== editing.originalContext ? {contextLimit: Number(editing.contextLimit) || 0} : {}),
      })
      if (saved.error || !saved.id) throw new Error(saved.error || "Server did not confirm the connection.")
      setProviders(all => [...all.filter(p => p.id !== saved.id), saved].sort((a,b) => a.name.localeCompare(b.name)))
      generation.current++; setEditing(null)
    } catch (e) { setError(aiError(e)) } finally { setSavingProvider(false) }
  }
  function cancel() {
    if (savingProvider) return
    Alert.alert("Discard connection changes?", "The saved connection is unchanged.", [{text: "Keep editing", style: "cancel"}, {text: "Discard changes", style: "destructive", onPress: () => { generation.current++; setEditing(null); setError("") }}])
  }
  function deleteProvider(p: Provider) {
    Alert.alert(p.name, "Delete this connection? Chats using it may become unavailable until you choose another provider.", [
      {text: "Cancel", style: "cancel"}, {text: "Delete", style: "destructive", onPress: async () => {
        setError("")
        try {
          const result = await api.providerDelete(p.id)
          if (!result.deleted) throw new Error("Server did not confirm deletion.")
          setProviders(all => all.filter(x => x.id !== p.id))
          if (editing?.id === p.id) { generation.current++; setEditing(null) }
        } catch (e) { setError(aiError(e)) }
      }},
    ])
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      <Text style={styles.sheetHint}>
        Providers route a session to your own model endpoint. Manage them here; pick one per chat in its
        settings. Changing a preset default affects chats that use that default. Saving a connection does not change new-chat defaults.
      </Text>

      {error ? <Text testID="provider-error" accessibilityRole="alert" style={[styles.sheetHint, {color: t.danger}]}>{error}</Text> : null}

      {/* Built-in (Claude) — the built-in login, not a stored provider. */}
      <Text style={styles.sheetSection}>BUILT-IN</Text>
      <View style={styles.profileInfoRow}>
        <Icon name="sparkle" size={18} color={t.accent} />
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={{ color: t.text, fontWeight: "600" }}>Built-in (Claude)</Text>
          <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 1 }}>Uses the host’s runner configuration and authentication.</Text>
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
            <Text style={{ color: t.text, fontWeight: "600" }}>
              {p.name}
            </Text>
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
        <View style={{ flexDirection: "row", gap: 14, marginHorizontal: 18, marginTop: 14, flexWrap: "wrap" }}>
          <TouchableOpacity testID="provider-add" style={styles.ssAddBtn} onPress={() => openEditor()}>
            <Text style={styles.ssAddBtnText}>+ Add provider</Text>
          </TouchableOpacity>

        </View>
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
            onChangeText={(baseUrl) => changeDraft({baseUrl})}
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
            onChangeText={(apiKey) => changeDraft({apiKey, apiKeyAction: apiKey.trim() ? "replace" : editing.id ? "keep" : "remove"})}
            placeholder={editing.id ? "API key (leave blank to keep current)" : "API key (sk-…, optional)"}
            placeholderTextColor={t.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <View style={{flexDirection: "row", flexWrap: "wrap", gap: 12}}>
            {(["keep", "remove", "replace"] as KeyAction[]).filter(action => editing.id || action !== "keep").map(action => <TouchableOpacity key={action} testID={`provider-key-${action}`} onPress={() => changeDraft({apiKeyAction: action})} style={{padding: 12}} accessibilityState={{selected: editing.apiKeyAction === action}}><Text style={{color: editing.apiKeyAction === action ? t.accent : t.textMuted}}>{action === "keep" ? "Keep saved key" : action === "remove" ? "Remove key" : "Replace key"}</Text></TouchableOpacity>)}
          </View>
          <Text testID="provider-discovery-status" style={styles.sheetHint}>{discoveryStatus}</Text>
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
            <TouchableOpacity testID="provider-cancel" onPress={cancel} disabled={savingProvider}>
              <Text style={{ color: t.textMuted, fontSize: 13, fontWeight: "600" }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </ScrollView>
  )
}
