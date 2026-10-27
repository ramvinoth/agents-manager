import React, { useEffect, useRef, useState } from "react"
import { Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Provider } from "../api/client"
import { aiError, connectionPayload, type KeyAction } from "../lib/aiSelection"
import { offerUndo } from "../lib/undo"
import {
  editRows, effectiveWindow, formatTokens, mergeDiscovered, overrideError, overridesPayload, sortRows,
  windowLabel, type EditRow,
} from "../lib/providerModels"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"
import { useStyles } from "../lib/styles"

type Props = NativeStackScreenProps<RootStackParamList, "Providers">

/** The connection being edited: endpoint + key, and its model table (each model
 *  has its own context window; the owner may override what the endpoint reports). */
type Draft = { id: string; name: string; baseUrl: string; originalUrl: string; apiKey: string; apiKeyAction: KeyAction; model: string; rows: EditRow[] }

const KEY_LABEL: Record<KeyAction, string> = { keep: "Keep saved key", replace: "Set new key", remove: "No key" }

function summary(p: Provider): string {
  const rows = p.models || []
  const def = rows.find(r => r.id === p.model)
  const known = rows.filter(r => r.contextWindow).length
  return `Default ${p.model || "—"} · ${def?.contextWindow ? `${formatTokens(def.contextWindow)} context` : "context unknown"}` +
    (rows.length > 1 ? ` · ${rows.length} models, ${known} known` : "")
}

/** Shared server connections. Selecting AI for a chat never edits these. */
export default function ProvidersScreen(_: Props) {
  const styles = useStyles()
  const t = useTheme()

  const [providers, setProviders] = useState<Provider[]>([])
  const [editing, setEditing] = useState<Draft | null>(null) // null = list view
  const [discovering, setDiscovering] = useState(false)
  const [discoveryNote, setDiscoveryNote] = useState("")
  const [newModel, setNewModel] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  const load = () => api.providers().then(r => setProviders(r.providers || [])).catch(e => setError(aiError(e)))
  useEffect(() => { load() }, [])

  function openEditor(p?: Provider) {
    generation.current++; setDiscovering(false); setError(""); setDiscoveryNote(""); setNewModel("")
    setEditing(p
      ? { id: p.id, name: p.name, baseUrl: p.baseUrl, originalUrl: p.baseUrl, apiKey: "", apiKeyAction: "keep", model: p.model, rows: editRows(p.models) }
      : { id: "", name: "", baseUrl: "", originalUrl: "", apiKey: "", apiKeyAction: "remove", model: "", rows: [] })
  }
  /** Endpoint or key changed: a discovery in flight answers for the old connection. */
  function patchConnection(change: Partial<Draft>) {
    generation.current++; setDiscovering(false); setDiscoveryNote("")
    setEditing(e => e ? { ...e, ...change } : e)
  }
  function setRow(id: string, change: Partial<EditRow>) {
    setEditing(e => e ? { ...e, rows: e.rows.map(r => r.id === id ? { ...r, ...change } : r) } : e)
  }

  let keyProblem = ""
  if (editing) { try { connectionPayload(editing, editing.originalUrl) } catch (e) { keyProblem = aiError(e) } }
  const badOverride = editing?.rows.some(r => overrideError(r.override))
  const canSave = !!editing && !!editing.baseUrl.trim() && !!editing.model && !keyProblem && !badOverride && !saving

  async function discover() {
    if (!editing || keyProblem) return
    const request = ++generation.current
    setDiscovering(true); setDiscoveryNote("")
    try {
      const r = await api.providerDraftModels(connectionPayload(editing, editing.originalUrl))
      if (request !== generation.current) return
      if (r.status === "ok") {
        setEditing(d => d ? { ...d, rows: mergeDiscovered(d.rows, r.choices), model: d.model || r.choices[0]?.id || "" } : d)
        const known = r.choices.filter(c => c.contextWindow).length
        setDiscoveryNote(`${r.choices.length} model${r.choices.length === 1 ? "" : "s"} found` +
          (known === r.choices.length ? "." : `; the endpoint reports a context window for ${known}. Set the rest yourself if you know them.`))
      } else {
        setDiscoveryNote(r.status === "error" ? r.error || "Discovery failed." : "This provider didn't list any models. Add one by its ID below.")
      }
    } catch (e) { if (request === generation.current) setDiscoveryNote(aiError(e)) }
    finally { if (request === generation.current) setDiscovering(false) }
  }
  function addModel() {
    const id = newModel.trim()
    if (!editing || !id) return
    setEditing(e => e && !e.rows.some(r => r.id === id)
      ? { ...e, rows: [...e.rows, { id, discovered: 0, maxOutput: 0, override: "" }], model: e.model || id } : e)
    setNewModel("")
  }
  function removeRow(id: string) {
    setEditing(e => {
      if (!e) return e
      const rows = e.rows.filter(r => r.id !== id)
      return { ...e, rows, model: e.model === id ? rows[0]?.id || "" : e.model }
    })
  }
  async function save() {
    if (!editing || !canSave) return
    setSaving(true); setError("")
    try {
      const saved = await api.providerSave({
        ...connectionPayload(editing, editing.originalUrl), name: editing.name.trim() || editing.baseUrl.trim(),
        model: editing.model, modelOverrides: overridesPayload(editing.rows),
      })
      if (saved.error || !saved.id) throw new Error(saved.error || "Server did not confirm the connection.")
      await load()
      generation.current++; setEditing(null)
    } catch (e) { setError(aiError(e)) } finally { setSaving(false) }
  }
  function cancel() {
    if (saving) return
    // Closing drops the unsaved edits at once; Undo reopens them as they were.
    const draft = editing
    generation.current++; setEditing(null); setError("")
    if (draft) offerUndo({ label: "Changes discarded", undo: () => setEditing(draft) })
  }
  function deleteConnection() {
    if (!editing?.id) return
    const id = editing.id
    Alert.alert(editing.name, "Delete this connection? Chats using it need another provider.", [
      { text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: async () => {
        setError("")
        try {
          if (!(await api.providerDelete(id)).deleted) throw new Error("Server did not confirm deletion.")
          setProviders(all => all.filter(x => x.id !== id))
          generation.current++; setEditing(null)
        } catch (e) { setError(aiError(e)) }
      } },
    ])
  }

  const errorText = error ? <Text testID="provider-error" accessibilityRole="alert" style={[styles.sheetHint, { color: t.danger }]}>{error}</Text> : null

  if (!editing) return (
    <ScrollView style={styles.page} contentContainerStyle={styles.pvScroll}>
      <Text style={styles.sheetHint}>
        A provider is a connection to a model server. It can serve many models, and each model has its own
        context window. Chats pick a provider and model in their AI settings.
      </Text>
      {errorText}
      <Text style={styles.sheetSection}>BUILT-IN</Text>
      <View style={[styles.profileInfoRow, { justifyContent: "flex-start" }]}>
        <Icon name="sparkle" size={18} color={t.accent} />
        <View style={styles.flex1}>
          <Text style={styles.pvName}>Built-in (Claude)</Text>
          <Text style={styles.pvMeta}>Your Claude login. Always available.</Text>
        </View>
      </View>
      <Text style={styles.sheetSection}>CONNECTIONS</Text>
      {providers.length ? providers.map(p => (
        <TouchableOpacity key={p.id} testID={`provider-edit-${p.id}`} style={[styles.profileInfoRow, { justifyContent: "flex-start" }]} onPress={() => openEditor(p)}>
          <Icon name="server" size={18} color={t.accent} />
          <View style={styles.flex1}>
            <View style={[styles.rowCenter, styles.pvNameRow]}>
              <Text style={[styles.pvName, styles.pvShrink]} numberOfLines={1}>{p.name}</Text>
              {p.isDefault ? <Text style={styles.pvBadge}>NEW-CHAT DEFAULT</Text> : null}
            </View>
            <Text style={[styles.pvMeta, styles.pvMono]} numberOfLines={1}>{p.baseUrl}</Text>
            <Text style={styles.pvMeta} numberOfLines={1}>{summary(p)}</Text>
          </View>
          <Icon name="chevronRight" size={18} color={t.textMuted} />
        </TouchableOpacity>
      )) : <Text style={[styles.sheetHint, { fontStyle: "italic" }]}>No connections yet.</Text>}
      <View style={styles.pvAddWrap}>
        <TouchableOpacity testID="provider-add" style={styles.ssAddBtn} onPress={() => openEditor()}>
          <Text style={styles.ssAddBtnText}>+ Add connection</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  )

  const rows = sortRows(editing.rows, editing.model)
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.pvScroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      {errorText}
      <Text style={styles.sheetSection}>{editing.id ? "CONNECTION" : "NEW CONNECTION"}</Text>
      <TextInput testID="provider-name" style={styles.ssInput} value={editing.name}
        onChangeText={name => setEditing(e => e ? { ...e, name } : e)}
        placeholder="Name (e.g. Qwen on the GPU box)" placeholderTextColor={t.textMuted} />
      <TextInput testID="provider-baseurl" style={styles.ssInput} value={editing.baseUrl}
        onChangeText={baseUrl => patchConnection({ baseUrl })}
        placeholder="Endpoint URL (https://inference.example.com)" placeholderTextColor={t.textMuted}
        autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <View style={styles.pvSegment} accessibilityRole="radiogroup">
        {(["keep", "replace", "remove"] as KeyAction[]).filter(a => editing.id || a !== "keep").map(a => {
          const on = editing.apiKeyAction === a
          return (
            <TouchableOpacity key={a} testID={`provider-key-${a}`} accessibilityRole="radio" accessibilityState={{ selected: on }}
              onPress={() => patchConnection({ apiKeyAction: a })}
              style={[styles.pvSeg, on && styles.pvSegOn]}>
              <Text style={[styles.pvSegText, on && styles.pvSegTextOn]}>{KEY_LABEL[a]}</Text>
            </TouchableOpacity>
          )
        })}
      </View>
      {editing.apiKeyAction === "replace" ? (
        <TextInput testID="provider-key" style={styles.ssInput} value={editing.apiKey}
          onChangeText={apiKey => patchConnection({ apiKey })}
          placeholder="API key (sk-…)" placeholderTextColor={t.textMuted} autoCapitalize="none" autoCorrect={false} secureTextEntry />
      ) : null}
      <Text style={[styles.sheetHint, keyProblem ? { color: t.danger } : null]}>{keyProblem || "Stored on the server; never shown again."}</Text>

      <View style={styles.pvModelsHead}>
        <Text style={[styles.sheetSection, { marginTop: 0 }]}>MODELS</Text>
        <TouchableOpacity testID="provider-load-models" disabled={!editing.baseUrl.trim() || !!keyProblem || discovering} onPress={discover}
          style={(!editing.baseUrl.trim() || !!keyProblem) && styles.faded}>
          <Text style={styles.pvLink}>
            {discovering ? "Discovering…" : editing.rows.some(r => r.discovered) ? "Refresh model list" : "Discover models"}
          </Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.sheetHint}>
        Each model has its own context window; Manager compacts a chat before it overflows. Tap a model to make it the default. Leave the override blank to use what the endpoint reports.
      </Text>
      {discoveryNote ? <Text testID="provider-discovery-status" accessibilityRole="text" style={styles.sheetHint}>{discoveryNote}</Text> : null}

      <View style={[styles.pvModels, !rows.length && styles.pvModelsEmpty]}>
        {rows.map((r, i) => {
          const isDefault = r.id === editing.model
          const eff = effectiveWindow(r)
          const bad = overrideError(r.override)
          return (
            <View key={r.id} style={[styles.pvModelRow, i > 0 && styles.pvModelRowSep]}>
              <TouchableOpacity testID={`provider-model-${r.id}`} accessibilityRole="radio" accessibilityState={{ selected: isDefault }}
                onPress={() => setEditing(e => e ? { ...e, model: r.id } : e)} style={styles.pvModelPick} hitSlop={4}>
                <Icon name={isDefault ? "radioOn" : "radioOff"} size={18} color={isDefault ? t.accent : t.textMuted} />
                <View style={styles.flex1}>
                  <Text style={styles.pvModelId} numberOfLines={1}>{r.id}</Text>
                  <Text style={[styles.pvModelMeta, !eff.source && styles.pvWarn]}>
                    {isDefault ? "Default · " : ""}{windowLabel(eff)}
                  </Text>
                </View>
              </TouchableOpacity>
              <TextInput testID={`provider-override-${r.id}`} value={r.override} onChangeText={override => setRow(r.id, { override })}
                placeholder={r.discovered ? formatTokens(r.discovered) : "e.g. 128k"} placeholderTextColor={t.textMuted}
                autoCapitalize="none" autoCorrect={false} accessibilityLabel={`Context override for ${r.id}`}
                style={[styles.pvOverride, !!bad && styles.pvOverrideBad]} />
              {!r.discovered ? (
                <TouchableOpacity testID={`provider-remove-${r.id}`} onPress={() => removeRow(r.id)} hitSlop={8} accessibilityLabel={`Remove ${r.id}`}>
                  <Icon name="close" size={16} color={t.textMuted} />
                </TouchableOpacity>
              ) : null}
            </View>
          )
        })}
      </View>
      {badOverride ? <Text style={[styles.sheetHint, { color: t.danger }]}>Use a token count like 128000, 128k or 1m.</Text> : null}
      <View style={styles.pvAddModel}>
        <TextInput testID="provider-model-input" style={[styles.ssInput, styles.flex1]} value={newModel} onChangeText={setNewModel}
          onSubmitEditing={addModel} returnKeyType="done" placeholder="Add a model by ID" placeholderTextColor={t.textMuted}
          autoCapitalize="none" autoCorrect={false} />
        <TouchableOpacity testID="provider-model-add" onPress={addModel} disabled={!newModel.trim()} style={[styles.pvAddBtn, !newModel.trim() && styles.faded]}>
          <Text style={styles.pvAction}>Add</Text>
        </TouchableOpacity>
      </View>
      {!editing.model ? <Text style={styles.sheetHint}>Discover models or add one by ID; the default is what new chats on this connection use.</Text> : null}

      <View style={styles.pvActions}>
        <TouchableOpacity testID="provider-save" style={[styles.ssAddBtn, { opacity: canSave ? 1 : 0.5 }]} disabled={!canSave} onPress={save}>
          <Text style={styles.ssAddBtnText}>{saving ? "Saving…" : "Save"}</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="provider-cancel" onPress={cancel} disabled={saving}>
          <Text style={[styles.pvAction, styles.pvMuted]}>Cancel</Text>
        </TouchableOpacity>
        <View style={styles.flex1} />
        {editing.id ? (
          <TouchableOpacity testID={`provider-delete-${editing.id}`} onPress={deleteConnection} disabled={saving}>
            <Text style={[styles.pvAction, styles.pvDanger]}>Delete</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </ScrollView>
  )
}
