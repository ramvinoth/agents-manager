import React, { useState } from "react"
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api } from "../api/client"
import Icon, { type IconName } from "../components/Icon"
import JobScheduler from "../components/JobScheduler"
import { MODEL_CHOICES, draftBlocker, draftFrom, draftPayload, type AgentDraft } from "../lib/agentEdit"
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
 * Create or edit a personal agent: a preset a new chat starts from (name,
 * instructions, goal, model, board level, scheduled jobs). Only its owner sees
 * or edits it; the server enforces both. Built-ins are duplicated, not edited.
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
