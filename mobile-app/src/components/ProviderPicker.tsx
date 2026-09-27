import React, { useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, FlatList, Modal, SafeAreaView, Text, TextInput, TouchableOpacity, View } from "react-native"
import { api, type Provider } from "../api/client"
import { aiError, modelChoices, sameAI, switchAIProvider, type AIConfig, type AISelection, type ModelDiscovery } from "../lib/aiSelection"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../screens/styles"

// Display labels for the two FIXED enum sets the server hands us (viewer/ai.py:
// conversationModes, EFFORTS). The set of valid values is the server's truth —
// we only iterate what `caps` returns — but how each value READS is a client
// presentation concern. Keyed by the raw value; an unknown future value falls
// back to its raw string, so a new server effort/mode still renders.
const CONVMODE_LABEL: Record<string, string> = { agent: "Agent", chat: "Chat" }
const EFFORT_LABEL: Record<string, string> = { "": "Auto", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" }

/** One staged transaction for all three scopes. Mounted afresh on each open. */
export default function ProviderPicker({ config, scope, providers, title, localOnly, onSave, onClose }: {
  config: AIConfig; scope: { id?: string; host: string; agent?: string }; providers: Provider[]; title: string; localOnly?: boolean
  onSave: (config: AIConfig) => void; onClose: () => void
}) {
  const t = useTheme(), styles = useStyles()
  const [draft, setDraft] = useState(config.selection)
  const [caps, setCaps] = useState(config.capabilities)
  const [capBusy, setCapBusy] = useState(true)
  const [capError, setCapError] = useState("")
  const [discovery, setDiscovery] = useState<ModelDiscovery | null>(null)
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [providerSearch, setProviderSearch] = useState("")
  const [search, setSearch] = useState("")
  const history = useRef(new Map<string, AISelection>())
  const dirty = !sameAI(config.selection, draft)
  const needsFirstSave = !scope.id && !localOnly && config.configured === false

  useEffect(() => {
    let alive = true
    setCapBusy(true); setCapError("")
    api.aiConfig(scope, draft).then(r => { if (alive) { setCaps(r.capabilities); if (!r.capabilities) setCapError("Server update required for AI settings.") } })
      .catch(e => { if (alive) setCapError(aiError(e)) }).finally(() => { if (alive) setCapBusy(false) })
    return () => { alive = false }
  }, [scope.id, scope.host, scope.agent, draft.provider, draft.convMode, retry])

  useEffect(() => {
    let alive = true
    setDiscovery(null); setLoading(true)
    api.providerModels({id: draft.provider}).then(r => {
      if (alive) setDiscovery(r.status ? r : { models: [], choices: [], status: "error", source: "endpoint", manualModelId: true, error: "Server update required for model discovery." })
    }).catch(e => { if (alive) setDiscovery({models: [], choices: [], status: "error", source: "endpoint", manualModelId: true, error: aiError(e)}) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [draft.provider, retry])

  function close() {
    if (busy) return
    if (!dirty) return onClose()
    Alert.alert("Discard changes?", "Your saved settings are unchanged.", [
      {text: "Keep editing", style: "cancel"}, {text: "Discard changes", style: "destructive", onPress: onClose},
    ])
  }
  function provider(id: string) {
    if (id === draft.provider) return
    setCapBusy(true)
    history.current.set(draft.provider, draft)
    setDraft(switchAIProvider(draft, id, history.current.get(id))); setSearch(""); setError("")
  }
  const missing = !!draft.provider && !providers.some(p => p.id === draft.provider)
  const incompatible = !caps?.editable || (!!draft.provider && !caps.customProviders) || !caps.conversationModes.includes(draft.convMode) || !caps.efforts.includes(draft.effort)
  const invalid = draft.model?.kind === "id" && !draft.model.id.trim()
  async function save() {
    if (busy || (!dirty && !needsFirstSave) || missing || incompatible || invalid || capBusy || capError) return
    setBusy(true); setError("")
    try {
      const result = localOnly ? {...config, selection: draft, capabilities: caps} : await api.aiSave(scope, config.revision, draft)
      if (!result.selection || !result.capabilities || typeof result.revision !== "number") throw new Error("Server update required: AI settings were not confirmed.")
      onSave(result); onClose()
    } catch (e) { setError(aiError(e)) } finally { setBusy(false) }
  }
  const row = (id: string, label: string, selected: boolean, action: () => void, disabled = false) => (
    <TouchableOpacity key={id} testID={id} accessibilityRole="radio" accessibilityState={{selected, disabled: disabled || busy}} disabled={disabled || busy}
      onPress={action} style={{minHeight: 48, paddingHorizontal: 18, paddingVertical: 12, backgroundColor: selected ? t.chipBg : t.surface, opacity: disabled ? .5 : 1}}>
      <Text style={{color: selected ? t.accent : t.text}}>{selected ? "✓ " : ""}{label}</Text>
    </TouchableOpacity>
  )
  // A fixed small enum (conversation mode, effort) reads as ONE control the eye
  // scans left-to-right — a segmented row — not a stack of radio rows. Same
  // idiom as the theme/loop pickers (styles.seg*), so the whole app picks small
  // sets the one way. Each segment keeps its per-value testID for the e2e specs.
  const segGroup = (testID: string, items: {key: string; id: string; label: string}[], selected: string, onPick: (key: string) => void) => (
    <View style={styles.segRow} testID={testID}>
      {items.map(it => {
        const active = it.key === selected
        return (
          <TouchableOpacity key={it.id} testID={it.id} accessibilityRole="radio" accessibilityState={{selected: active, disabled: busy}}
            disabled={busy} onPress={() => onPick(it.key)} style={[styles.seg, active ? styles.segActive : null]}>
            <Text style={[styles.segText, active ? styles.segTextActive : null]} numberOfLines={1}>{it.label}</Text>
          </TouchableOpacity>
        )
      })}
    </View>
  )
  const rows = [{id: "", name: "Built-in (runner default)"}, ...providers].filter(p => p.name.toLowerCase().includes(providerSearch.toLowerCase())).sort((a,b) => a.id === "" ? -1 : b.id === "" ? 1 : a.name.localeCompare(b.name))
  return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
    <SafeAreaView testID="ai-editor" style={{flex: 1, backgroundColor: t.bg}}>
      <View style={{flexDirection: "row", alignItems: "center", padding: 12, gap: 12}}>
        <TouchableOpacity testID="ai-cancel" onPress={close} disabled={busy} style={{padding: 8}}><Text style={{color: t.accent}}>Cancel</Text></TouchableOpacity>
        <Text accessibilityRole="header" style={{flex: 1, color: t.text, fontWeight: "700"}}>{title}</Text>
        <TouchableOpacity testID="ai-save" onPress={save} disabled={(!dirty && !needsFirstSave) || busy || incompatible || invalid || missing || capBusy || !!capError} style={{padding: 8, opacity: (!dirty && !needsFirstSave) || busy || incompatible || invalid || missing || capBusy || capError ? .4 : 1}}><Text style={{color: t.accent}}>{busy ? "Saving…" : localOnly ? "Use for this chat" : "Save"}</Text></TouchableOpacity>
      </View>
      <FlatList data={modelChoices(discovery, draft.model, search)} keyExtractor={r => r.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets
        ListHeaderComponent={<>
          <Text style={styles.sheetHint}>{localOnly ? "Only this unsent chat. Defaults are unchanged." : scope.id ? "Changes apply to future runs, not a response already in progress." : "For new chats on this Harman server. Existing chats are unchanged."}</Text>
          {error || capError || missing || incompatible ? <Text testID="ai-error" accessibilityRole="alert" style={[styles.sheetHint, {color: t.danger}]}>{error || capError || (missing ? "Selected connection is unavailable. Choose another provider." : "This selection is unsupported on this host or runner. Choose supported settings.")}</Text> : null}
          {config.issue ? <Text style={styles.sheetHint}>{config.issue}</Text> : null}
          <Text style={styles.sheetSection}>PROVIDER</Text>
          <TextInput testID="ai-provider-search" accessibilityLabel="Search providers" style={styles.ssInput} placeholder="Search providers" placeholderTextColor={t.textMuted} value={providerSearch} onChangeText={setProviderSearch}/>
          {rows.map(p => row(`ai-provider-${p.id || "default"}`, p.name, draft.provider === p.id, () => provider(p.id), !!p.id && !caps?.customProviders))}
          <Text style={styles.sheetSection}>CONVERSATION MODE</Text>
          {caps?.conversationModes.length ? segGroup("ai-convmode", caps.conversationModes.map(m => ({key: m, id: `ai-convmode-${m}`, label: CONVMODE_LABEL[m] || m})), draft.convMode, m => setDraft({...draft, convMode: m as AISelection["convMode"], effort: ""})) : null}
          <Text style={styles.sheetSection}>EFFORT</Text>
          {caps?.efforts.length ? segGroup("ai-effort", caps.efforts.map(e => ({key: e, id: `ai-effort-${e || "default"}`, label: EFFORT_LABEL[e] ?? (e || "Auto")})), draft.effort, e => setDraft({...draft, effort: e})) : null}
          <Text style={styles.sheetSection}>MODEL</Text>
          {row("ai-model-default", "Runner / provider default", draft.model?.kind === "default", () => setDraft({...draft, model: {kind: "default"}}))}
          {scope.id ? row("ai-model-legacy", "Remove explicit override (legacy request behavior)", draft.model === null, () => setDraft({...draft, model: null})) : null}
          {caps?.manualModelId ? <TextInput testID="ai-model-manual" accessibilityLabel="Explicit model ID" style={styles.ssInput} placeholder="Enter full model ID" placeholderTextColor={t.textMuted} autoCapitalize="none" autoCorrect={false} editable={!busy} value={draft.model?.kind === "id" ? draft.model.id : ""} onChangeText={id => setDraft({...draft, model: {kind: "id", id}})}/> : null}
          <Text testID="ai-discovery-status" style={styles.sheetHint}>{loading ? "Loading model choices…" : discovery?.status === "error" ? discovery.error || "Model discovery failed." : discovery?.status === "unsupported" ? "Discovery is unsupported. Use runner default or enter a model ID." : discovery?.status === "empty" ? "No models returned. Enter an explicit ID or use runner default." : "A discovered model is not a guarantee of execution access."}</Text>
          {loading ? <ActivityIndicator color={t.accent}/> : null}
          <TouchableOpacity testID="ai-discovery-retry" onPress={() => setRetry(r => r+1)} style={{padding: 16}}><Text style={{color: t.accent}}>Retry discovery</Text></TouchableOpacity>
          <TextInput testID="ai-model-search" accessibilityLabel="Search models" style={styles.ssInput} placeholder="Search model IDs" placeholderTextColor={t.textMuted} value={search} onChangeText={setSearch}/>
        </>}
        renderItem={({item}) => row(`ai-model-${item.id}`, item.label === item.id ? item.id : `${item.label}\n${item.id}`, draft.model?.kind === "id" && draft.model.id === item.id, () => setDraft({...draft, model: {kind: "id", id: item.id}}))}
        ListFooterComponent={<View style={{height: 40}}/>}/>
    </SafeAreaView>
  </Modal>
}
