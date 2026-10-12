import React, { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, Alert, FlatList, Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type AgentExtras, type McpServer, type Skill } from "../api/client"
import { McpEditor, SkillEditor } from "../components/CapabilitiesEditors"
import MarketplaceSheet from "../components/MarketplaceSheet"
import Icon, { type IconName } from "../components/Icon"
import JobScheduler from "../components/JobScheduler"
import { MODEL_CHOICES, draftBlocker, draftFrom, draftPayload, pickable, type AgentDraft } from "../lib/agentEdit"
import { showActions } from "../lib/actionSheet"
import { HARMAN_LEVELS, LEVEL_NAME } from "../lib/harmanLevel"
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
 * instructions, goal, model, board level, scheduled jobs, Harman plugins, and
 * its own skills and MCP servers (each new chat gets a copy). Only its owner
 * sees or edits it; the server enforces both. Built-ins are duplicated, not edited.
 * Plugins save with the form; skills and MCP save one by one, so they need the
 * agent to exist first. A skill or MCP tool is written here, copied from this
 * Mac's own setup, or installed from the Marketplace — all onto the agent.
 */
export default function AgentEditScreen({ route, navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const existing = route.params?.template
  const [d, setD] = useState<AgentDraft>(() => draftFrom(existing))
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
    set("plugins", d.plugins.includes(name) ? d.plugins.filter((p) => p !== name) : [...d.plugins, name])

  async function save() {
    setError(""); setBusy(true)
    try {
      if (existing) await api.agentTemplateUpdate(existing.id, draftPayload(d))
      else await api.agentTemplateCreate(draftPayload(d))
      navigation.goBack()
    } catch (e) {
      setError(userError(e, "this agent", "save"))
    } finally {
      setBusy(false)
    }
  }

  function remove() {
    if (!existing) return
    Alert.alert(`Delete ${existing.name}?`, "Chats already started from it keep running; new chats can't start from it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        setBusy(true)
        try { await api.agentTemplateDelete(existing.id); navigation.goBack() }
        catch (e) { setError(userError(e, existing.name, "delete")) }
        finally { setBusy(false) }
      } },
    ])
  }

  const chips = <T extends string>(id: string, items: readonly T[], value: T, label: (v: T) => string, onPick: (v: T) => void) => (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {items.map((v) => {
        const on = v === value
        return (
          <TouchableOpacity key={v} testID={`${id}-${v || "default"}`} onPress={() => onPick(v)}
            style={[styles.agCat, on ? { backgroundColor: t.accent, borderColor: t.accent } : null]}>
            <Text style={[styles.agCatText, on ? styles.agCatTextActive : null]}>{label(v)}</Text>
          </TouchableOpacity>
        )
      })}
    </View>
  )
  const field = (id: string, label: string, k: "name" | "description" | "system_prompt" | "goal", placeholder: string, multiline = false) => (
    <>
      <Text style={styles.label}>{label}</Text>
      <TextInput testID={id} style={[styles.input, multiline ? { minHeight: 96, textAlignVertical: "top" } : null]}
        placeholder={placeholder} placeholderTextColor={t.textMuted + "80"} multiline={multiline}
        value={d[k]} onChangeText={(v) => set(k, v)} />
    </>
  )

  return (
    <ScrollView style={styles.screen} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      {field("agent-name", "Name", "name", "Writing Coach")}

      <Text style={styles.label}>Icon</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {ICONS.map((name) => {
          const on = d.icon === name
          return (
            <TouchableOpacity key={name} testID={`agent-icon-${name}`} accessibilityLabel={`Icon ${name}`} onPress={() => set("icon", name)}
              style={[styles.agIcon, { backgroundColor: on ? t.accent : t.chipBg }]}>
              <Icon name={name} size={18} color={on ? t.onAccent : t.textMuted} />
            </TouchableOpacity>
          )
        })}
      </View>

      <Text style={styles.label}>Category</Text>
      {chips("agent-category", Object.keys(TEMPLATE_CATEGORIES), d.category, (v) => TEMPLATE_CATEGORIES[v].label, (v) => set("category", v))}

      {field("agent-description", "Description", "description", "One line on what it's for")}
      {field("agent-system-prompt", "Instructions (system prompt)", "system_prompt", "How the agent should behave", true)}
      {field("agent-goal", "Goal", "goal", "What counts as done — the agent checks it before stopping")}

      <Text style={styles.label}>Model</Text>
      {chips("agent-model", MODEL_CHOICES, d.model as (typeof MODEL_CHOICES)[number], (v) => v ? v[0].toUpperCase() + v.slice(1) : "Default", (v) => set("model", v))}

      <Text style={styles.label}>On the board, it may change</Text>
      {chips("agent-level", HARMAN_LEVELS, d.level, (v) => LEVEL_NAME[v], (v) => set("level", v))}

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={styles.label}>Scheduled jobs</Text>
        <TouchableOpacity testID="agent-add-job" hitSlop={8} onPress={() => setJobForm(-1)} style={styles.ncAddBtn}>
          <Icon name="add" size={13} color={t.accent} />
          <Text style={styles.ncAddText}>Add</Text>
        </TouchableOpacity>
      </View>
      {!d.jobs.length ? <Text style={styles.hint}>Every chat started from this agent comes back on these schedules — e.g. a daily summary.</Text> : null}
      {d.jobs.map((job, i) => (
        <TouchableOpacity key={i} testID={`agent-job-${i}`} activeOpacity={0.65} onPress={() => setJobForm(i)} style={styles.ncJob}>
          <Icon name="repeat" size={15} color={t.accent} />
          <View style={styles.flex1}>
            <Text style={styles.ncJobPrompt} numberOfLines={2}>{job.prompt}</Text>
            <Text style={styles.ncJobWhen}>{describeSchedule(job)}</Text>
          </View>
          <TouchableOpacity testID={`agent-remove-job-${i}`} accessibilityLabel="Remove job" hitSlop={8}
            onPress={() => set("jobs", d.jobs.filter((_, j) => j !== i))}>
            <Icon name="trash" size={14} color={t.danger} />
          </TouchableOpacity>
        </TouchableOpacity>
      ))}
      <JobScheduler
        visible={jobForm !== -2}
        styles={styles}
        initialValues={jobForm >= 0 ? d.jobs[jobForm] : undefined}
        onClose={() => setJobForm(-2)}
        onSubmit={(prompt, schedule) => {
          const job = { prompt, ...schedule }
          set("jobs", jobForm >= 0 ? d.jobs.map((j, k) => (k === jobForm ? job : j)) : [...d.jobs, job])
          setJobForm(-2)
        }}
      />

      <Text style={styles.label}>Plugins</Text>
      {extrasError ? (
        <TouchableOpacity testID="agent-extras-retry" onPress={loadExtras}>
          <Text style={styles.error}>{extrasError} Tap to try again.</Text>
        </TouchableOpacity>
      ) : !extras ? <ActivityIndicator size="small" color={t.textMuted} style={{ alignSelf: "flex-start" }} /> : (
        <>
          <Text style={styles.hint}>Harman's ready-made kits. Every chat from this agent starts with the ones you pick.</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {extras.catalog.map((p) => {
              const on = d.plugins.includes(p.name)
              return (
                <TouchableOpacity key={p.name} testID={`agent-plugin-${p.name}`} accessibilityState={{ selected: on }}
                  accessibilityHint={p.description} onPress={() => togglePlugin(p.name)}
                  style={[styles.agCat, on ? { backgroundColor: t.accent, borderColor: t.accent } : null]}>
                  <Text style={[styles.agCatText, on ? styles.agCatTextActive : null]}>{p.name}</Text>
                </TouchableOpacity>
              )
            })}
          </View>
        </>
      )}

      {(["skill", "mcp"] as const).map((kind) => {
        const rows: (Skill | McpServer)[] = (kind === "skill" ? extras?.skills : extras?.mcp) ?? []
        return (
          <React.Fragment key={kind}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={styles.label}>{kind === "skill" ? "Skills" : "MCP tools"}</Text>
              {existing ? (
                <TouchableOpacity testID={`agent-add-${kind}`} hitSlop={8} style={styles.ncAddBtn}
                  onPress={() => showActions(kind === "skill" ? "Add a skill" : "Add an MCP tool", [
                    { text: kind === "skill" ? "Write a new skill" : "Add manually", onPress: () => (kind === "skill" ? setSkillEdit(null) : setMcpEdit(null)) },
                    { text: "From this Mac", onPress: () => setFromMac(kind) },
                    { text: "Marketplace", onPress: () => setMarket(kind === "skill" ? "skills" : "mcp") },
                  ])}>
                  <Icon name="add" size={13} color={t.accent} />
                  <Text style={styles.ncAddText}>Add</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            {!existing ? <Text style={styles.hint}>Create the agent first, then add its own {kind === "skill" ? "skills" : "MCP tools"} here.</Text>
              : !rows.length && extras ? <Text style={styles.hint}>{kind === "skill"
                ? "Instructions a chat can call by name, e.g. /weekly-review. Each new chat gets a copy."
                : "Tools a chat can use, e.g. a database or a web API. Each new chat gets a copy."}</Text> : null}
            {rows.map((r) => (
              <TouchableOpacity key={r.name} testID={`agent-${kind}-${r.name}`} activeOpacity={0.65} style={styles.ncJob}
                onPress={() => (kind === "skill" ? setSkillEdit(r as Skill) : setMcpEdit(r as McpServer))}>
                <Icon name={kind === "skill" ? "sparkle" : "tool"} size={15} color={t.accent} />
                <View style={styles.flex1}>
                  <Text style={styles.ncJobPrompt} numberOfLines={1}>{kind === "skill" ? `/${r.name}` : r.name}</Text>
                  {kind === "skill" ? ((r as Skill).description ? <Text style={styles.ncJobWhen} numberOfLines={2}>{(r as Skill).description}</Text> : null)
                    : <Text style={styles.ncJobWhen} numberOfLines={1}>{(r as McpServer).transport}{(r as McpServer).target ? ` · ${(r as McpServer).target}` : ""}</Text>}
                </View>
              </TouchableOpacity>
            ))}
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

      {error || (blocker && d.name) ? <Text style={styles.error}>{error || blocker}</Text> : null}
      <TouchableOpacity testID="agent-save" style={[styles.button, { marginTop: 20 }, blocker || busy ? { opacity: 0.5 } : null]}
        onPress={save} disabled={!!blocker || busy}>
        {busy ? <ActivityIndicator color={t.onAccent} /> : <Text style={styles.buttonText}>{existing ? "Save" : "Create agent"}</Text>}
      </TouchableOpacity>
      {existing ? (
        <TouchableOpacity testID="agent-delete" style={{ alignItems: "center", padding: 16 }} onPress={remove} disabled={busy}>
          <Text style={{ color: t.danger, fontWeight: "600" }}>Delete agent</Text>
        </TouchableOpacity>
      ) : null}
      <View style={{ height: 40 }} />
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
