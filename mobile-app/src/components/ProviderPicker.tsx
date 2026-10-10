import React, { useEffect, useRef, useState } from "react"
import { ActivityIndicator, FlatList, Modal, SafeAreaView, Text, TextInput, TouchableOpacity, View } from "react-native"
import { api, type Provider } from "../api/client"
import { aiError, modelChoices, sameAI, switchAIProvider, type AIConfig, type AISelection, type ModelDiscovery } from "../lib/aiSelection"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"

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
  // The typed ID is its own state: deriving it from the draft would blank the
  // box the moment the typed text happens to equal a listed model.
  const idOf = (sel: AISelection) => sel.model?.kind === "id" ? sel.model.id : ""
  const [manual, setManual] = useState(idOf(config.selection))
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

  // Inline, not Alert.alert: a native alert raised from inside this full-screen
  // Modal never presented (ai-settings e2e, 2026-10-06), so Cancel looked dead.
  const [confirming, setConfirming] = useState(false)
  function close() {
    if (busy) return
    if (!dirty) return onClose()
    setConfirming(true)
  }
  function provider(id: string) {
    if (id === draft.provider) return
    setCapBusy(true)
    history.current.set(draft.provider, draft)
    const next = switchAIProvider(draft, id, history.current.get(id))
    setDraft(next); setManual(idOf(next)); setSearch(""); setError("")
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
  // One grouped-list row (iOS Settings idiom): title, optional muted subtitle,
  // checkmark trailing. The "✓" is a real Text so VoiceOver and the e2e
  // `selected()` contract read the state from the row's label.
  const row = (id: string, title: string, sub: string, selected: boolean, action: () => void, opts: {disabled?: boolean; first?: boolean; style?: object} = {}) => (
    <TouchableOpacity key={id} testID={id} accessibilityRole="radio" accessibilityState={{selected, disabled: opts.disabled || busy}} disabled={opts.disabled || busy}
      onPress={action} style={[styles.aiRow, !opts.first && styles.aiRowSep, opts.style, opts.disabled && styles.faded]}>
      <View style={styles.flex1}>
        <Text style={[styles.aiRowTitle, selected && {color: t.accent}]} numberOfLines={2}>{title}</Text>
        {sub ? <Text style={styles.aiRowSub} numberOfLines={2}>{sub}</Text> : null}
      </View>
      {selected ? <Text style={styles.aiCheck}>✓</Text> : null}
    </TouchableOpacity>
  )
  // A fixed small enum (conversation mode, effort) reads as ONE control the eye
  // scans left-to-right — a segmented row — not a stack of radio rows. Same
  // idiom as the theme/loop pickers (styles.seg*), so the whole app picks small
  // sets the one way. Each segment keeps its per-value testID for the e2e specs.
  // A set with one value is not a choice, so callers render nothing for it.
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
  const section = (title: string, hint?: string) => <>
    <Text accessibilityRole="header" style={styles.aiSection}>{title}</Text>
    {hint ? <Text style={styles.aiSectionHint}>{hint}</Text> : null}
  </>
  const allProviders = [{id: "", name: "Built-in", baseUrl: "", model: ""}, ...providers]
  const rows = allProviders.filter(p => p.name.toLowerCase().includes(providerSearch.toLowerCase())).sort((a,b) => a.id === "" ? -1 : b.id === "" ? 1 : a.name.localeCompare(b.name))
  const providerSub = (p: {id: string; baseUrl?: string}) => !p.id ? "Claude on this Harman server — full agent tools"
    : !caps?.customProviders ? "Needs a newer Harman server" : (p.baseUrl || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "")
  const current = providers.find(p => p.id === draft.provider)
  // A typed ID lives in its own row, so the list must not echo it back as an
  // extra "(current; not in discovered list)" entry on every keystroke.
  const typed = !!manual && idOf(draft) === manual
  const known = modelChoices(discovery, typed ? null : draft.model, "")
  const models = modelChoices(discovery, typed ? null : draft.model, search)
  const manualSelected = typed && !known.some(c => c.id === manual)
  const pick = (id: string) => { setDraft({...draft, model: {kind: "id", id}}); setManual("") }
  // Built-in runs through the Claude CLI, which has no list endpoint: that is
  // normal, not a problem to report. Only a real failure offers Try again.
  const discoveryNote = loading ? "Loading models…"
    : discovery?.status === "error" ? discovery.error || "Couldn't load the model list."
    : discovery?.status === "unsupported" ? (draft.provider ? "This connection doesn't publish a model list. Use its default, or type a model ID." : "Built-in uses this server's Claude default. Type a model ID to pin a specific one.")
    : discovery?.status === "empty" ? "This connection listed no models. Use its default, or type a model ID."
    : known.length ? "Some listed models may need access enabled on your provider account." : ""
  return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
    <SafeAreaView testID="ai-editor" style={styles.page}>
      <View style={{flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6}}>
        <TouchableOpacity testID="ai-cancel" onPress={close} disabled={busy} style={{minWidth: 72, minHeight: 44, justifyContent: "center", paddingHorizontal: 8}}><Text style={{color: t.accent, fontSize: 16}}>Cancel</Text></TouchableOpacity>
        <Text accessibilityRole="header" numberOfLines={1} style={{flex: 1, textAlign: "center", color: t.text, fontSize: 16, fontWeight: "600"}}>{title}</Text>
        <TouchableOpacity testID="ai-save" onPress={save} disabled={(!dirty && !needsFirstSave) || busy || incompatible || invalid || missing || capBusy || !!capError} style={{minWidth: 72, minHeight: 44, alignItems: "flex-end", justifyContent: "center", paddingHorizontal: 8, opacity: (!dirty && !needsFirstSave) || busy || incompatible || invalid || missing || capBusy || !!capError ? .4 : 1}}><Text style={{color: t.accent, fontSize: 16, fontWeight: "700"}}>{busy ? "Saving…" : localOnly ? "Use" : "Save"}</Text></TouchableOpacity>
      </View>
      {confirming ? <View testID="ai-discard-confirm" style={{flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18, paddingBottom: 10}}>
        <Text style={{flex: 1, color: t.text}}>Discard changes? Your saved settings are unchanged.</Text>
        <TouchableOpacity testID="ai-keep-editing" accessibilityLabel="Keep editing" onPress={() => setConfirming(false)} style={{padding: 8}}><Text style={{color: t.accent}}>Keep editing</Text></TouchableOpacity>
        <TouchableOpacity testID="ai-discard" accessibilityLabel="Discard changes" onPress={onClose} style={{padding: 8}}><Text style={{color: t.danger, fontWeight: "600"}}>Discard</Text></TouchableOpacity>
      </View> : null}
      <FlatList data={models} keyExtractor={r => r.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets
        ListHeaderComponent={<>
          <Text style={styles.aiSectionHint}>{localOnly ? "Only this unsent chat. Your defaults are unchanged." : scope.id ? "Applies from this chat's next reply; a reply already running keeps its settings." : "What every new chat on this Harman server starts with. Existing chats keep their own."}</Text>
          {error || capError || missing || incompatible ? <Text testID="ai-error" accessibilityRole="alert" style={[styles.aiSectionHint, {color: t.danger}]}>{error || capError || (missing ? "Selected connection is unavailable. Choose another provider." : "This machine can't run that combination. Pick a different provider or model.")}</Text> : null}
          {config.issue ? <Text style={[styles.aiSectionHint, {color: t.danger}]}>{config.issue}</Text> : null}

          {section("Provider", "Who runs the model. Add connections under Profile → Model providers.")}
          {allProviders.length > 6 ? <TextInput testID="ai-provider-search" accessibilityLabel="Search providers" style={styles.ssInput} placeholder="Search providers" placeholderTextColor={t.textMuted} value={providerSearch} onChangeText={setProviderSearch} clearButtonMode="while-editing"/> : null}
          <View style={styles.aiGroup}>
            {rows.map((p, i) => row(`ai-provider-${p.id || "default"}`, p.name, providerSub(p), draft.provider === p.id, () => provider(p.id), {disabled: !!p.id && !caps?.customProviders, first: i === 0}))}
          </View>

          {caps && caps.conversationModes.length > 1 ? <>
            {section("Tools", "Agent reads files, runs commands and uses tools. Chat only talks — faster, but can't act.")}
            {segGroup("ai-convmode", caps.conversationModes.map(m => ({key: m, id: `ai-convmode-${m}`, label: CONVMODE_LABEL[m] || m})), draft.convMode, m => setDraft({...draft, convMode: m as AISelection["convMode"], effort: ""}))}
          </> : null}
          {caps && caps.efforts.length > 1 ? <>
            {section("Thinking effort", "How hard it thinks before answering. Higher is slower and uses more tokens; Auto lets the model decide.")}
            {segGroup("ai-effort", caps.efforts.map(e => ({key: e, id: `ai-effort-${e || "default"}`, label: EFFORT_LABEL[e] ?? (e || "Auto")})), draft.effort, e => setDraft({...draft, effort: e}))}
          </> : null}

          {section("Model")}
          {discoveryNote ? <Text testID="ai-discovery-status" style={styles.aiSectionHint}>{discoveryNote}</Text> : null}
          {discovery?.status === "error" && !loading ? <TouchableOpacity testID="ai-discovery-retry" onPress={() => setRetry(r => r+1)} style={{minHeight: 44, justifyContent: "center", paddingHorizontal: 30}}><Text style={{color: t.accent}}>Try again</Text></TouchableOpacity> : null}
          <View style={styles.aiGroup}>
            {row("ai-model-default", "Default", current?.model ? `Connection default · ${current.model}` : draft.provider ? "The connection's default model" : "This server's Claude default", draft.model?.kind === "default", () => { setDraft({...draft, model: {kind: "default"}}); setManual("") }, {first: true})}
            {scope.id ? row("ai-model-legacy", "Keep this chat's original model", "No override", draft.model === null, () => { setDraft({...draft, model: null}); setManual("") }) : null}
            {caps?.manualModelId ? <View style={[styles.aiRow, styles.aiRowSep]}>
              <View style={styles.flex1}>
                <Text style={styles.aiRowSub}>Model ID</Text>
                <TextInput testID="ai-model-manual" accessibilityLabel="Model ID" style={[styles.aiRowTitle, {paddingVertical: 4}, manualSelected && {color: t.accent}]} placeholder={draft.provider ? "Any model ID this connection serves" : "e.g. claude-opus-4-1"} placeholderTextColor={t.textMuted} autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" editable={!busy} value={manual} onChangeText={id => { setManual(id); setDraft({...draft, model: id ? {kind: "id", id} : {kind: "default"}}) }}/>
              </View>
              {manualSelected ? <Text style={styles.aiCheck}>✓</Text> : null}
            </View> : null}
          </View>
          {loading ? <ActivityIndicator style={{marginTop: 16}} color={t.accent}/> : null}
          {known.length ? section(`Available models · ${known.length}`) : null}
          {known.length > 8 ? <TextInput testID="ai-model-search" accessibilityLabel="Search models" style={styles.ssInput} placeholder="Search models" placeholderTextColor={t.textMuted} autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" value={search} onChangeText={setSearch}/> : null}
        </>}
        renderItem={({item, index}) => row(`ai-model-${item.id}`, item.label, item.label === item.id ? "" : item.id, draft.model?.kind === "id" && draft.model.id === item.id, () => pick(item.id),
          {first: index === 0, style: [styles.aiListRow, index === 0 && styles.aiListFirst, index === models.length - 1 && styles.aiListLast]})}
        ListEmptyComponent={search && known.length ? <Text style={styles.aiSectionHint}>No model matches “{search}”.</Text> : null}
        ListFooterComponent={<View style={{height: 40}}/>}/>
    </SafeAreaView>
  </Modal>
}
