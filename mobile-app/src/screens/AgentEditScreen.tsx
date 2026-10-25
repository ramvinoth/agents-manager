import React, { useCallback, useEffect, useLayoutEffect, useState } from "react"
import { ActivityIndicator, Alert, FlatList, Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import { UNSTABLE_usePreventRemove as usePreventRemove, type NavigationAction } from "@react-navigation/native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type AgentExtras, type McpServer, type Provider, type Skill } from "../api/client"
import { McpEditor, SkillEditor } from "../components/CapabilitiesEditors"
import MarketplaceSheet from "../components/MarketplaceSheet"
import ProviderPicker from "../components/ProviderPicker"
import HeaderButton from "../components/HeaderButton"
import Icon, { type IconName } from "../components/Icon"
import JobScheduler from "../components/JobScheduler"
import { draftBlocker, draftFrom, draftPayload, pickable, pluginLabel, pluginRows, sameDraft, type AgentDraft } from "../lib/agentEdit"
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
  const [skillEdit, setSkillEdit] = useState<Skill | null | undefined>(undefined)
  const [mcpEdit, setMcpEdit] = useState<McpServer | null | undefined>(undefined)
  const [market, setMarket] = useState<"skills" | "mcp" | null>(null)
  const [fromMac, setFromMac] = useState<"skill" | "mcp" | null>(null)
  const loadExtras = useCallback(() => {
    setExtrasError("")
    api.agentTemplateExtras(existing?.id).then(setExtras).catch((e) => setExtrasError(userError(e, "plugins, skills and MCP")))
  }, [existing?.id])
  useEffect(loadExtras, [loadExtras])
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
  const foot = (text: string, testID?: string) => <Text testID={testID} style={styles.aiSectionHint}>{text}</Text>
  const sep = (first: boolean) => (first ? null : styles.aiRowSep)
  // A setting that opens somewhere else: label left, current value + chevron right.
  const valueRow = (o: { testID: string; title: string; value?: string; sub?: string; onPress: () => void; first?: boolean; disabled?: boolean }) => (
    <TouchableOpacity testID={o.testID} activeOpacity={0.65} disabled={o.disabled} onPress={o.onPress}
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
  // A verb at the end of a list ("Add skill…"), in the accent colour like iOS.
  const actionRow = (testID: string, label: string, onPress: () => void, first: boolean) => (
    <TouchableOpacity testID={testID} activeOpacity={0.65} onPress={onPress} accessibilityRole="button" style={[styles.aiRow, sep(first)]}>
      <Icon name="add" size={16} color={t.accent} />
      <Text style={styles.aeAction}>{label}</Text>
    </TouchableOpacity>
  )
  // A field with its caption inside the row, for the longer text.
  const field = (id: string, caption: string, k: "system_prompt" | "goal", placeholder: string, first: boolean, multiline = false) => (
    <View style={[styles.aiRow, sep(first), { flexDirection: "column", alignItems: "stretch", gap: 0 }]}>
      <Text style={styles.aeFieldLabel}>{caption}</Text>
      <TextInput testID={id} accessibilityLabel={caption} style={[styles.aeInput, multiline ? { minHeight: 88, textAlignVertical: "top" } : null]}
        placeholder={placeholder} placeholderTextColor={t.textMuted + "99"} multiline={multiline}
        value={d[k]} onChangeText={(v) => set(k, v)} />
    </View>
  )
  const [iconsOpen, setIconsOpen] = useState(!existing)
  const category = TEMPLATE_CATEGORIES[d.category]

  return (
    <ScrollView style={styles.page} contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      {created ? <Text testID="agent-created" style={styles.aeNotice}>Created. Add its own skills and MCP tools below, or go back and start a chat with it.</Text> : null}
      {error || (blocker && d.name) ? (
        <Text testID="agent-error" accessibilityRole="alert" style={[styles.error, { marginHorizontal: 30, marginTop: 12 }]}>{error || blocker}</Text>
      ) : null}

      {/* Who it is: the big icon you recognise it by, then its name — like a contact card. */}
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
                onPress={() => set("icon", name)} style={[styles.aeIconCell, { backgroundColor: on ? t.accent : t.chipBg }]}>
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
      {foot("How it shows on the Agents tab.")}

      {head("HOW IT WORKS")}
      <View style={styles.aiGroup}>
        {field("agent-system-prompt", "Instructions", "system_prompt", "How it should behave, e.g. \"Edit for clarity; keep my voice\"", true, true)}
        {field("agent-goal", "Goal", "goal", "What counts as done — it checks this before stopping", false)}
      </View>
      <View style={styles.aiGroup}>
        {aiErrorText ? (
          <TouchableOpacity testID="agent-ai-retry" style={styles.aiRow} onPress={loadAI}>
            <Text style={[styles.error, styles.flex1]}>{aiErrorText} Tap to try again.</Text>
          </TouchableOpacity>
        ) : valueRow({ testID: "agent-ai-row", title: "AI", first: true, disabled: !aiDefaults, onPress: () => setAIOpen(true),
          value: !aiDefaults ? "Loading…" : aiSummary(d.ai ?? aiDefaults.selection, providers),
          sub: !aiDefaults ? undefined : d.ai ? "Its own — changing your default won't change it." : "Follows your default in Profile → AI." })}
        {d.ai && !aiErrorText ? (
          <TouchableOpacity testID="agent-ai-default" activeOpacity={0.65} onPress={() => set("ai", null)} style={[styles.aiRow, styles.aiRowSep]}>
            <Text style={styles.aeAction}>Use my default AI</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {foot("Every chat from this agent starts with these; a chat can still change its own copy.")}
      {aiOpen && aiDefaults ? (
        <ProviderPicker config={{ ...aiDefaults, selection: d.ai ?? aiDefaults.selection }} scope={{ host: "local" }} providers={providers}
          title="AI for this agent" localOnly hint="Every new chat from this agent starts on this. Your default AI is unchanged."
          onSave={(c) => set("ai", c.selection)} onClose={() => setAIOpen(false)} />
      ) : null}

      {head("WHAT IT CAN USE")}
      <View style={styles.aiGroup}>
        {extrasError ? (
          <TouchableOpacity testID="agent-extras-retry" style={styles.aiRow} onPress={loadExtras}>
            <Text style={[styles.error, styles.flex1]}>{extrasError} Tap to try again.</Text>
          </TouchableOpacity>
        ) : valueRow({ testID: "agent-plugins-row", title: "Plugins", first: true, disabled: !extras, onPress: () => setPluginsOpen(true),
          value: !extras ? "Loading…" : d.plugins.length ? `${d.plugins.length} on` : "None",
          sub: !extras ? undefined : d.plugins.length ? d.plugins.map(pluginLabel).join(", ") : `Ready-made kits of skills and tools · ${extras.catalog.length} available` })}
      </View>
      {pluginsOpen && extras ? <PluginPicker catalog={extras.catalog} on={d.plugins} onToggle={togglePlugin} onClose={() => setPluginsOpen(false)} /> : null}

      {(["skill", "mcp"] as const).map((kind) => {
        const rows: (Skill | McpServer)[] = (kind === "skill" ? extras?.skills : extras?.mcp) ?? []
        const noun = kind === "skill" ? "skill" : "MCP tool"
        return (
          <React.Fragment key={kind}>
            {head(kind === "skill" ? "SKILLS" : "MCP TOOLS")}
            {existing ? (
              <View style={styles.aiGroup}>
                {rows.map((r, i) => (
                  <TouchableOpacity key={r.name} testID={`agent-${kind}-${r.name}`} activeOpacity={0.65} style={[styles.aiRow, sep(i === 0)]}
                    onPress={() => (kind === "skill" ? setSkillEdit(r as Skill) : setMcpEdit(r as McpServer))}>
                    <Icon name={kind === "skill" ? "sparkle" : "tool"} size={16} color={t.accent} />
                    <View style={styles.flex1}>
                      <Text style={styles.aiRowTitle} numberOfLines={1}>{kind === "skill" ? `/${r.name}` : r.name}</Text>
                      {kind === "skill" ? ((r as Skill).description ? <Text style={styles.aiRowSub} numberOfLines={2}>{(r as Skill).description}</Text> : null)
                        : <Text style={styles.aiRowSub} numberOfLines={1}>{(r as McpServer).transport}{(r as McpServer).target ? ` · ${(r as McpServer).target}` : ""}</Text>}
                    </View>
                    <Icon name="chevronRight" size={14} color={t.textMuted} />
                  </TouchableOpacity>
                ))}
                {actionRow(`agent-add-${kind}`, `Add ${noun}…`, () => showActions(`Add ${kind === "skill" ? "a skill" : "an MCP tool"}`, [
                  { text: kind === "skill" ? "Write a new skill" : "Add manually", onPress: () => (kind === "skill" ? setSkillEdit(null) : setMcpEdit(null)) },
                  { text: "From this Mac", onPress: () => setFromMac(kind) },
                  { text: "Marketplace", onPress: () => setMarket(kind === "skill" ? "skills" : "mcp") },
                ]), !rows.length)}
              </View>
            ) : null}
            {foot(!existing ? `Tap Create first; adding its own ${noun}s unlocks right after.`
              : kind === "skill" ? "Instructions a chat can call by name, e.g. /weekly-review. Each new chat gets a copy."
              : "Tools a chat can use, e.g. a database or a web API. Each new chat gets a copy.")}
          </React.Fragment>
        )
      })}
      {existing && skillEdit !== undefined ? <SkillEditor skill={skillEdit} host="local" agent={existing.id} onClose={() => setSkillEdit(undefined)} onSaved={loadExtras} /> : null}
      {existing && mcpEdit !== undefined ? <McpEditor server={mcpEdit} host="local" agent={existing.id} onClose={() => setMcpEdit(undefined)} onSaved={loadExtras} /> : null}
      {existing && market ? <MarketplaceSheet kind={market} agent={{ id: existing.id, name: existing.name }} onClose={() => setMarket(null)} onInstalled={loadExtras} /> : null}
      {existing && fromMac && extras ? (
        <FromThisMac kind={fromMac} agentId={existing.id} onAgent={fromMac === "skill" ? extras.skills : extras.mcp}
          onClose={() => setFromMac(null)} onAdded={loadExtras} />
      ) : null}

      {head("ON THE BOARD, IT MAY CHANGE")}
      <View style={styles.aiSeg} testID="agent-level">
        {HARMAN_LEVELS.map((v) => {
          const on = v === d.level
          return (
            <TouchableOpacity key={v} testID={`agent-level-${v}`} accessibilityRole="button" accessibilityState={{ selected: on }}
              onPress={() => set("level", v)} style={[styles.aiSegItem, on && styles.aiSegItemActive]}>
              <Text style={[styles.segText, on && styles.segTextActive]} numberOfLines={1}>{LEVEL_NAME[v]}</Text>
            </TouchableOpacity>
          )
        })}
      </View>
      {foot(`${LEVEL_NAME[d.level]}: ${LEVEL_REACH[d.level]}. Anything beyond that waits for your approval.`, "agent-level-reach")}

      {head("SCHEDULED JOBS")}
      <View style={styles.aiGroup}>
        {d.jobs.map((job, i) => (
          <TouchableOpacity key={i} testID={`agent-job-${i}`} activeOpacity={0.65} style={[styles.aiRow, sep(i === 0)]}
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
        {actionRow("agent-add-job", "Add job", () => setJobForm(-1), !d.jobs.length)}
      </View>
      {foot("Every chat started from this agent comes back on these schedules — e.g. a daily summary.")}
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

      {existing ? (
        <View style={[styles.aiGroup, { marginTop: 32 }]}>
          <TouchableOpacity testID="agent-delete" accessibilityRole="button" style={[styles.aiRow, { justifyContent: "center" }]} onPress={remove} disabled={busy}>
            <Text style={{ color: t.danger, fontSize: 16 }}>Delete agent</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </ScrollView>
  )
}

/** The skills or MCP servers already set up on this Mac, to copy onto the agent
 *  in one tap. A skill is copied whole (scripts too); an MCP server by its config. */
function FromThisMac({ kind, agentId, onAgent, onClose, onAdded }: {
  kind: "skill" | "mcp"; agentId: number; onAgent: { name: string }[]; onClose: () => void; onAdded: () => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const [rows, setRows] = useState<(Skill | McpServer)[] | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const what = kind === "skill" ? "skills" : "MCP tools"
  const load = useCallback(() => {
    setError(""); setRows(null)
    api.capabilities("local")
      .then((c) => setRows(kind === "skill" ? pickable(c.skills, onAgent) : pickable(c.mcp, onAgent)))
      .catch((e) => setError(userError(e, `this Mac's ${what}`)))
  }, [kind, onAgent, what])
  useEffect(load, [load])

  async function add(r: Skill | McpServer) {
    setBusy(r.name); setError("")
    try {
      await api.agentTemplateExtra(kind === "skill"
        ? { id: agentId, kind, name: r.name, from_path: (r as Skill).path }
        : { id: agentId, kind, name: r.name, config: (r as McpServer).config })
      onAdded(); onClose()
    } catch (e) {
      setError(userError(e, r.name, "add"))
    } finally {
      setBusy("")
    }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.page}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 16, paddingBottom: 8 }}>
          <Text style={{ flex: 1, fontSize: 18, fontWeight: "700", color: t.text }}>{kind === "skill" ? "Skills" : "MCP tools"} on this Mac</Text>
          <TouchableOpacity testID="frommac-close" onPress={onClose} hitSlop={10}><Icon name="close" size={22} color={t.textMuted} /></TouchableOpacity>
        </View>
        <Text style={[styles.hint, { paddingHorizontal: 16 }]}>Tap one to give this agent its own copy. Later changes on the Mac don't reach the copy.</Text>
        {error ? (
          <TouchableOpacity testID="frommac-retry" onPress={load} style={{ padding: 16 }}>
            <Text testID="frommac-error" style={styles.error}>{error} Tap to try again.</Text>
          </TouchableOpacity>
        ) : null}
        {!rows && !error ? <ActivityIndicator color={t.textMuted} style={{ marginTop: 24 }} /> : rows ? (
          <FlatList
            testID="frommac-list"
            data={rows}
            keyExtractor={(r) => r.name}
            contentContainerStyle={{ paddingBottom: 40 }}
            ListEmptyComponent={<Text style={styles.capEmpty}>No other {what} on this Mac. Try the Marketplace.</Text>}
            renderItem={({ item: r }) => (
              <TouchableOpacity testID={`frommac-${r.name}`} style={styles.capRow} disabled={!!busy} onPress={() => add(r)}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>{kind === "skill" ? `/${r.name}` : r.name}</Text>
                  <Text style={[styles.capRowDesc, { color: t.textMuted }]} numberOfLines={2}>
                    {kind === "skill" ? (r as Skill).description || "" : `${(r as McpServer).transport}${(r as McpServer).target ? ` · ${(r as McpServer).target}` : ""}`}
                  </Text>
                </View>
                {busy === r.name ? <ActivityIndicator color={t.textMuted} />
                  : <Text style={styles.capBadge}>{kind === "skill" ? (r as Skill).source : (r as McpServer).scope}</Text>}
              </TouchableOpacity>
            )}
          />
        ) : null}
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
