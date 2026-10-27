import React, { useCallback, useEffect, useLayoutEffect, useState } from "react"
import { ActivityIndicator, Alert, FlatList, Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import { UNSTABLE_usePreventRemove as usePreventRemove, useFocusEffect, type NavigationAction } from "@react-navigation/native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type AgentExtras, type Provider } from "../api/client"
import ProviderPicker from "../components/ProviderPicker"
import HeaderButton from "../components/HeaderButton"
import Icon, { type IconName } from "../components/Icon"
import JobScheduler from "../components/JobScheduler"
import { draftBlocker, draftFrom, draftPayload, pluginLabel, pluginRows, sameDraft, type AgentDraft } from "../lib/agentEdit"
import { aiError, aiSummary, type AIConfig } from "../lib/aiSelection"
import { showActions } from "../lib/actionSheet"
import { HARMAN_LEVELS, LEVEL_NAME, LEVEL_REACH } from "../lib/harmanLevel"
import { describeSchedule } from "../lib/interval"
import { TEMPLATE_CATEGORIES } from "../lib/templateCategories"
import { userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"

type Props = NativeStackScreenProps<RootStackParamList, "AgentEdit">

const ICONS: IconName[] = ["sparkle", "book", "school", "barbell", "airplane", "code", "bug", "brush", "megaphone",
  "clipboard", "shield", "calculator", "mail", "calendar", "user", "star"]

/**
 * Create or edit a personal agent — the hub a new chat starts from: name,
 * instructions, goal, AI (provider + model), board level, scheduled jobs, Harman plugins, and
 * its own skills and MCP servers (each new chat gets a copy). Only its owner
 * sees or edits it; the server enforces both. Built-ins are duplicated, not edited.
 * Plugins save with the form; skills and MCP save one by one, so they need the
 * agent to exist first: creating keeps you here with them unlocked. A skill or
 * MCP tool is written here, copied from this Mac's own setup, or installed from
 * the Marketplace — all onto the agent.
 *
 * Laid out in the order you decide: who it is, how it works, what it can use,
 * what it does alone. Save sits in the header so it is reachable from any
 * section, and leaving with unsaved changes asks first.
 */
export default function AgentEditScreen({ route, navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const existing = route.params?.template
  const [d, setD] = useState<AgentDraft>(() => draftFrom(existing))
  // What the server holds; leaving with a draft that differs asks first.
  const [saved, setSaved] = useState<AgentDraft>(d)
  const [created, setCreated] = useState(false)
  const [leaving, setLeaving] = useState<NavigationAction | "back" | null>(null)
  const set = <K extends keyof AgentDraft>(k: K, v: AgentDraft[K]) => setD((prev) => ({ ...prev, [k]: v }))
  // -2 = no form, -1 = adding, ≥0 = editing that job.
  const [jobForm, setJobForm] = useState(-2)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const blocker = draftBlocker(d)
  const [extras, setExtras] = useState<AgentExtras | null>(null)
  const [extrasError, setExtrasError] = useState("")
  const loadExtras = useCallback(() => {
    setExtrasError("")
    api.agentTemplateExtras(existing?.id).then(setExtras).catch((e) => setExtrasError(userError(e, "plugins, skills and MCP")))
  }, [existing?.id])
  // On focus: the tools screen changes the counts this shows.
  useFocusEffect(loadExtras)
  const togglePlugin = (name: string) =>
    setD((prev) => ({ ...prev, plugins: prev.plugins.includes(name) ? prev.plugins.filter((p) => p !== name) : [...prev.plugins, name] }))
  const [pluginsOpen, setPluginsOpen] = useState(false)

  // The agent's AI is the same server-owned selection a chat has (any provider,
  // any model the provider lists), picked in the one ProviderPicker. The owner's
  // defaults are what "no AI of its own" means, so they are loaded to show it.
  const [aiDefaults, setAIDefaults] = useState<AIConfig | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])
  const [aiErrorText, setAIErrorText] = useState("")
  const [aiOpen, setAIOpen] = useState(false)
  const loadAI = useCallback(() => {
    setAIErrorText("")
    Promise.all([api.aiConfig({ host: "local" }), api.providers()]).then(([config, result]) => {
      if (!config.capabilities || !config.selection) throw new Error("Server update required for AI settings.")
      setAIDefaults(config); setProviders(result.providers || [])
    }).catch((e) => setAIErrorText(aiError(e)))
  }, [])
  useEffect(loadAI, [loadAI])

  const dirty = !sameDraft(d, saved)
  usePreventRemove(dirty && !leaving, ({ data }) => {
    Alert.alert("Discard your changes?", `${d.name.trim() || "This agent"} has edits you haven't saved.`, [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => setLeaving(data.action) },
    ])
  })
  // Leave only after the render that lifted the guard, or the guard would block it again.
  useEffect(() => {
    if (leaving === "back") navigation.goBack()
    else if (leaving) navigation.dispatch(leaving)
  }, [leaving, navigation])

  async function save() {
    setError(""); setBusy(true)
    try {
      if (existing) {
        await api.agentTemplateUpdate(existing.id, draftPayload(d))
        setSaved(d); setLeaving("back")
      } else {
        // Stay: skills and MCP tools unlock once the agent exists.
        const { template } = await api.agentTemplateCreate(draftPayload(d))
        setSaved(d); setCreated(true)
        navigation.setParams({ template })
      }
    } catch (e) {
      setError(userError(e, "this agent", "save"))
    } finally {
      setBusy(false)
    }
  }

  const canSave = !blocker && !busy && (dirty || !existing)
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => busy ? <ActivityIndicator color={t.accent} /> : (
        <HeaderButton testID="agent-save" label={existing ? "Save agent" : "Create agent"} onPress={save} disabled={!canSave}
          style={{ width: undefined, paddingHorizontal: 4 }}>
          <Text style={{ color: t.accent, fontSize: 17, fontWeight: "600" }}>{existing ? "Save" : "Create"}</Text>
        </HeaderButton>
      ),
    })
  }, [navigation, busy, canSave, existing, d, t.accent]) // save reads d and existing

  function remove() {
    if (!existing) return
    Alert.alert(`Delete ${existing.name}?`, "Chats already started from it keep running; new chats can't start from it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        setBusy(true)
        try { await api.agentTemplateDelete(existing.id); setLeaving("back") }
        catch (e) { setError(userError(e, existing.name, "delete")) }
        finally { setBusy(false) }
      } },
    ])
  }

  // iOS grouped-inset building blocks, the same rows Profile → AI uses: a
  // header above a group, a footer below it, rows separated by hairlines.
  const head = (title: string) => <Text accessibilityRole="header" style={styles.aiSection}>{title}</Text>
  const foot = (text: string) => <Text style={styles.aiSectionHint}>{text}</Text>
  const sep = (first: boolean) => (first ? null : styles.aiRowSep)
  // A setting that opens somewhere else: label left, current value + chevron right.
  const valueRow = (o: { testID: string; title: string; value?: string; sub?: string; onPress: () => void; first?: boolean; disabled?: boolean }) => (
    <TouchableOpacity key={o.testID} testID={o.testID} activeOpacity={0.65} disabled={o.disabled} onPress={o.onPress}
      accessibilityRole="button" accessibilityLabel={`${o.title}${o.value ? `, ${o.value}` : ""}`}
      style={[styles.aiRow, sep(!!o.first), o.disabled && styles.faded]}>
      <View style={styles.flex1}>
        <Text style={styles.aiRowTitle} numberOfLines={1}>{o.title}</Text>
        {o.sub ? <Text style={styles.aiRowSub} numberOfLines={2}>{o.sub}</Text> : null}
      </View>
      {o.value ? <Text style={styles.aeValue} numberOfLines={1}>{o.value}</Text> : null}
      <Icon name="chevronRight" size={14} color={t.textMuted} />
    </TouchableOpacity>
  )
  const [iconsOpen, setIconsOpen] = useState(false)
  const [textEdit, setTextEdit] = useState<"system_prompt" | "goal" | null>(null)
  const category = TEMPLATE_CATEGORIES[d.category]
  const count = (n: number | undefined) => (n === undefined ? "Loading…" : n ? `${n}` : "None")
  const toolsRow = (kind: "skill" | "mcp") => {
    const n = kind === "skill" ? extras?.skills.length : extras?.mcp.length
    return valueRow({ testID: `agent-${kind}s-row`, title: kind === "skill" ? "Skills" : "MCP tools",
      disabled: !existing,
      value: existing ? count(n) : undefined,
      sub: !existing ? "After you tap Create" : kind === "skill" ? "Instructions it can call by name" : "Databases, web APIs and other tools",
      onPress: () => existing && navigation.navigate("AgentTools", { id: existing.id, name: existing.name, kind }) })
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      {created ? <Text testID="agent-created" style={styles.aeNotice}>Created. You can now give it its own skills and MCP tools.</Text> : null}
      {error || (blocker && d.name) ? (
        <Text testID="agent-error" accessibilityRole="alert" style={[styles.error, { marginHorizontal: 30, marginTop: 12 }]}>{error || blocker}</Text>
      ) : null}

      {/* Who it is, like a contact card: the icon you recognise it by (tap to change), its name, one line on what it's for. */}
      <View style={styles.aeHero}>
        <TouchableOpacity testID="agent-icon-change" accessibilityRole="button" accessibilityLabel={`Icon ${d.icon}. Change icon`}
          activeOpacity={0.7} onPress={() => setIconsOpen((o) => !o)} style={styles.aeHeroIcon}>
          <Icon name={d.icon as IconName} size={40} color={t.onAccent} />
        </TouchableOpacity>
        <TouchableOpacity hitSlop={8} onPress={() => setIconsOpen((o) => !o)}>
          <Text style={styles.aeHeroAction}>{iconsOpen ? "Done" : "Change icon"}</Text>
        </TouchableOpacity>
      </View>
      {iconsOpen ? (
        <View style={[styles.aiGroup, styles.aeIconGrid]}>
          {ICONS.map((name) => {
            const on = d.icon === name
            return (
              <TouchableOpacity key={name} testID={`agent-icon-${name}`} accessibilityLabel={`Icon ${name}`} accessibilityState={{ selected: on }}
                onPress={() => { set("icon", name); setIconsOpen(false) }} style={[styles.aeIconCell, { backgroundColor: on ? t.accent : t.chipBg }]}>
                <Icon name={name} size={20} color={on ? t.onAccent : t.textMuted} />
              </TouchableOpacity>
            )
          })}
        </View>
      ) : null}

      <View style={styles.aiGroup}>
        <View style={styles.aiRow}>
          <TextInput testID="agent-name" accessibilityLabel="Name" style={[styles.aeInput, styles.flex1]} placeholder="Name, e.g. Writing Coach"
            placeholderTextColor={t.textMuted + "99"} value={d.name} onChangeText={(v) => set("name", v)} returnKeyType="next" />
        </View>
        <View style={[styles.aiRow, styles.aiRowSep]}>
          <TextInput testID="agent-description" accessibilityLabel="Description" style={[styles.aeInput, styles.flex1]}
            placeholder="One line on what it's for" placeholderTextColor={t.textMuted + "99"}
            value={d.description} onChangeText={(v) => set("description", v)} />
        </View>
        {valueRow({ testID: "agent-category", title: "Category", value: category?.label ?? d.category, onPress: () =>
          showActions("Category", Object.keys(TEMPLATE_CATEGORIES).map((k) => ({
            text: `${TEMPLATE_CATEGORIES[k].label}${k === d.category ? "  ✓" : ""}`, onPress: () => set("category", k),
          }))) })}
      </View>

      {head("ROLE")}
      <View style={styles.aiGroup}>
        {valueRow({ testID: "agent-system-prompt-row", title: "Instructions", first: true, onPress: () => setTextEdit("system_prompt"),
          sub: d.system_prompt.trim() || "How it should behave", value: d.system_prompt.trim() ? undefined : "Not set" })}
        {valueRow({ testID: "agent-goal-row", title: "Goal", onPress: () => setTextEdit("goal"),
          sub: d.goal.trim() || "What counts as done", value: d.goal.trim() ? undefined : "Not set" })}
        {aiErrorText ? (
          <TouchableOpacity testID="agent-ai-retry" style={[styles.aiRow, styles.aiRowSep]} onPress={loadAI}>
            <Text style={[styles.error, styles.flex1]}>{aiErrorText} Tap to try again.</Text>
          </TouchableOpacity>
        ) : valueRow({ testID: "agent-ai-row", title: "AI", disabled: !aiDefaults, onPress: () => setAIOpen(true),
          value: !aiDefaults ? "Loading…" : aiSummary(d.ai ?? aiDefaults.selection, providers),
          sub: !aiDefaults ? undefined : d.ai ? "Its own" : "Your default" })}
        {d.ai && !aiErrorText ? (
          <TouchableOpacity testID="agent-ai-default" activeOpacity={0.65} onPress={() => set("ai", null)} style={[styles.aiRow, styles.aiRowSep]}>
            <Text style={styles.aeAction}>Use my default AI</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {foot("New chats start with these; a chat can change its own copy.")}

      {head("TOOLS")}
      <View style={styles.aiGroup}>
        {extrasError ? (
          <TouchableOpacity testID="agent-extras-retry" style={styles.aiRow} onPress={loadExtras}>
            <Text style={[styles.error, styles.flex1]}>{extrasError} Tap to try again.</Text>
          </TouchableOpacity>
        ) : valueRow({ testID: "agent-plugins-row", title: "Plugins", first: true, disabled: !extras, onPress: () => setPluginsOpen(true),
          value: !extras ? "Loading…" : d.plugins.length ? `${d.plugins.length} on` : "None",
          sub: !extras ? undefined : d.plugins.length ? d.plugins.map(pluginLabel).join(", ") : "Ready-made kits of skills and tools" })}
        {toolsRow("skill")}
        {toolsRow("mcp")}
      </View>

      {head("ON ITS OWN")}
      <View style={styles.aiGroup}>
        {valueRow({ testID: "agent-level", title: "Board access", first: true, value: LEVEL_NAME[d.level], sub: LEVEL_REACH[d.level],
          onPress: () => showActions("Board access", HARMAN_LEVELS.map((v) => ({
            text: `${LEVEL_NAME[v]}${v === d.level ? "  ✓" : ""}`, onPress: () => set("level", v),
          }))) })}
        {d.jobs.map((job, i) => (
          <TouchableOpacity key={i} testID={`agent-job-${i}`} activeOpacity={0.65} style={[styles.aiRow, styles.aiRowSep]}
            onPress={() => showActions(job.prompt, [
              { text: "Edit job", onPress: () => setJobForm(i) },
              { text: "Remove job", destructive: true, onPress: () => set("jobs", d.jobs.filter((_, j) => j !== i)) },
            ])}>
            <Icon name="repeat" size={16} color={t.accent} />
            <View style={styles.flex1}>
              <Text style={styles.aiRowTitle} numberOfLines={2}>{job.prompt}</Text>
              <Text style={styles.aiRowSub}>{describeSchedule(job)}</Text>
            </View>
            <Icon name="chevronRight" size={14} color={t.textMuted} />
          </TouchableOpacity>
        ))}
        <TouchableOpacity testID="agent-add-job" activeOpacity={0.65} onPress={() => setJobForm(-1)} accessibilityRole="button" style={[styles.aiRow, styles.aiRowSep]}>
          <Icon name="add" size={16} color={t.accent} />
          <Text style={styles.aeAction}>Add scheduled job</Text>
        </TouchableOpacity>
      </View>
      {foot("Beyond its access, it asks you first. Jobs bring each of its chats back on a schedule, e.g. a daily summary.")}

      {existing ? (
        <View style={[styles.aiGroup, { marginTop: 32 }]}>
          <TouchableOpacity testID="agent-delete" accessibilityRole="button" style={[styles.aiRow, { justifyContent: "center" }]} onPress={remove} disabled={busy}>
            <Text style={{ color: t.danger, fontSize: 16 }}>Delete agent</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {aiOpen && aiDefaults ? (
        <ProviderPicker config={{ ...aiDefaults, selection: d.ai ?? aiDefaults.selection }} scope={{ host: "local" }} providers={providers}
          title="AI for this agent" localOnly hint="Every new chat from this agent starts on this. Your default AI is unchanged."
          onSave={(c) => set("ai", c.selection)} onClose={() => setAIOpen(false)} />
      ) : null}
      {pluginsOpen && extras ? <PluginPicker catalog={extras.catalog} on={d.plugins} onToggle={togglePlugin} onClose={() => setPluginsOpen(false)} /> : null}
      {textEdit ? (
        <TextSheet title={textEdit === "goal" ? "Goal" : "Instructions"} value={d[textEdit]} testID={textEdit === "goal" ? "agent-goal" : "agent-system-prompt"}
          hint={textEdit === "goal" ? "What counts as done. It checks this before it stops."
            : "How it should behave, e.g. \"Edit for clarity; keep my voice.\""}
          onDone={(v) => set(textEdit, v)} onClose={() => setTextEdit(null)} />
      ) : null}
      <JobScheduler
        visible={jobForm !== -2}
        styles={styles}
        initialValues={jobForm >= 0 ? d.jobs[jobForm] : undefined}
        repeatOnly
        onClose={() => setJobForm(-2)}
        onSubmit={(prompt, schedule) => {
          const job = { prompt, ...schedule }
          set("jobs", jobForm >= 0 ? d.jobs.map((j, k) => (k === jobForm ? job : j)) : [...d.jobs, job])
          setJobForm(-2)
        }}
      />
    </ScrollView>
  )
}

/** Long text gets the whole screen to write in; Cancel keeps what was there. */
function TextSheet({ title, value, hint, testID, onDone, onClose }: {
  title: string; value: string; hint: string; testID: string; onDone: (v: string) => void; onClose: () => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const [text, setText] = useState(value)
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.page}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 16, paddingBottom: 8 }}>
          <TouchableOpacity testID={`${testID}-cancel`} onPress={onClose} hitSlop={10}><Text style={{ color: t.accent, fontSize: 17 }}>Cancel</Text></TouchableOpacity>
          <Text style={{ flex: 1, textAlign: "center", fontSize: 17, fontWeight: "600", color: t.text }}>{title}</Text>
          <TouchableOpacity testID={`${testID}-done`} onPress={() => { onDone(text); onClose() }} hitSlop={10}>
            <Text style={{ color: t.accent, fontSize: 17, fontWeight: "600" }}>Done</Text>
          </TouchableOpacity>
        </View>
        <Text style={[styles.hint, { paddingHorizontal: 16 }]}>{hint}</Text>
        <TextInput testID={testID} accessibilityLabel={title} autoFocus multiline value={text} onChangeText={setText}
          style={[styles.aeInput, { flex: 1, margin: 16, textAlignVertical: "top" }]} />
      </View>
    </Modal>
  )
}

/** The plugin catalog to tick from — searchable and virtualized, so a catalog of
 *  a thousand stays one scroll; the agent's own sit first. Ticks edit the draft
 *  directly (it saves with the form), so Done only closes. */
function PluginPicker({ catalog, on, onToggle, onClose }: {
  catalog: AgentExtras["catalog"]; on: string[]; onToggle: (name: string) => void; onClose: () => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const [query, setQuery] = useState("")
  // Order is fixed while the sheet is open: a row jumping to the top under your
  // finger as you tick it would be worse than the agent's own scrolling off.
  const [opened] = useState(on)
  const rows = pluginRows(catalog, opened, query)
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.page}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 16, paddingBottom: 8 }}>
          <Text style={{ flex: 1, fontSize: 18, fontWeight: "700", color: t.text }}>Plugins · {on.length} on</Text>
          <TouchableOpacity testID="plugins-done" onPress={onClose} hitSlop={10}><Text style={{ color: t.accent, fontSize: 17, fontWeight: "600" }}>Done</Text></TouchableOpacity>
        </View>
        <TextInput testID="plugins-search" style={[styles.input, { marginHorizontal: 16 }]} placeholder={`Search ${catalog.length} plugins`}
          placeholderTextColor={t.textMuted + "80"} value={query} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" />
        <FlatList
          testID="plugins-list"
          data={rows}
          keyExtractor={(p) => p.name}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
          ListEmptyComponent={<Text style={styles.capEmpty}>{catalog.length ? `No plugin matches "${query.trim()}".` : "No plugins on this server yet."}</Text>}
          renderItem={({ item: p }) => {
            const checked = on.includes(p.name)
            return (
              <TouchableOpacity testID={`agent-plugin-${p.name}`} accessibilityRole="checkbox" accessibilityState={{ checked }}
                activeOpacity={0.65} onPress={() => onToggle(p.name)} style={styles.ncJob}>
                <View style={[styles.aeCheck, checked ? { backgroundColor: t.accent, borderColor: t.accent } : null]}>
                  {checked ? <Icon name="check" size={13} color={t.onAccent} /> : null}
                </View>
                <View style={styles.flex1}>
                  <Text style={styles.ncJobPrompt}>{pluginLabel(p.name)}</Text>
                  {p.description ? <Text style={styles.ncJobWhen} numberOfLines={2}>{p.description}</Text> : null}
                </View>
              </TouchableOpacity>
            )
          }}
        />
      </View>
    </Modal>
  )
}
