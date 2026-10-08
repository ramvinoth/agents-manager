import React, { useEffect, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"
import { useHeaderHeight } from "@react-navigation/elements"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Project, type Provider } from "../api/client"
import { composerPrefs, currentHost, setComposerPrefs } from "../state/config"
import Dropdown from "../components/Dropdown"
import Icon, { type IconName } from "../components/Icon"
import JobScheduler from "../components/JobScheduler"
import ProviderPicker from "../components/ProviderPicker"
import { aiError, aiSummary, newChatAI, type AIConfig } from "../lib/aiSelection"
import { TEMPLATE_CATEGORIES } from "../lib/templateCategories"
import { userError } from "../lib/errors"
import { describeSchedule } from "../lib/interval"
import { chatLabel, MODES, modeOf, projectOptions, startBlocker, type NewChatJob } from "../lib/newChat"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"

type Props = NativeStackScreenProps<RootStackParamList, "NewChat">

// Chat-first: the message is the one required thing, so it comes first and
// takes focus; where/how/which-AI sit in one compact card under it; everything
// optional hides behind "More options". Start lives in a bar pinned above the
// keyboard and says why it is disabled. The chat opens the moment the server
// accepts it (ThreadScreen's `starting`), and its jobs ride on that same
// request so none is lost if the owner leaves.
export default function NewChatScreen({ navigation, route }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const headerHeight = useHeaderHeight()
  const template = route.params?.template
  const host = currentHost()
  const local = host === "local"

  const [projects, setProjects] = useState<Project[]>([])
  const [projectsError, setProjectsError] = useState("")
  const [cwd, setCwd] = useState("")
  const [customCwd, setCustomCwd] = useState(false)
  const [message, setMessage] = useState("")
  const [title, setTitle] = useState(template?.name ?? "")
  const [systemPrompt, setSystemPrompt] = useState(template?.system_prompt ?? "")
  const [goal, setGoal] = useState(template?.goal ?? "")
  const [mode, setModeState] = useState(composerPrefs().mode)
  const setMode = (v: string) => {
    setModeState(v)
    setComposerPrefs({ mode: v })
  }
  const [aiConfig, setAIConfig] = useState<AIConfig | null>(null)
  const [aiErrorText, setAIErrorText] = useState("")
  const ai = aiConfig?.selection
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [showMore, setShowMore] = useState(!!template)
  const [jobs, setJobs] = useState<NewChatJob[]>(() =>
    template?.cron && template?.job_prompt ? [{ prompt: template.job_prompt, cron: template.cron }] : [])
  // -2 = no form, -1 = adding, ≥0 = editing that job.
  const [jobForm, setJobForm] = useState(-2)

  const [providers, setProviders] = useState<Provider[]>([])
  const [providerPickerOpen, setProviderPickerOpen] = useState(false)
  useEffect(() => {
    let alive = true
    setAIConfig(null); setAIErrorText("")
    Promise.all([api.aiConfig({host}), api.providers()]).then(([config, result]) => {
      if (!alive) return
      if (!config.capabilities || !config.selection) throw new Error("Server update required for AI settings.")
      setProviders(result.providers || [])
      setAIConfig({...config, selection: newChatAI(config, composerPrefs().model, template?.model)})
    }).catch(e => { if (alive) setAIErrorText(aiError(e)) })
    return () => { alive = false }
  }, [host, template?.model])

  useEffect(() => {
    let alive = true
    api.projects(host).then((p) => {
      if (!alive) return
      const list = Array.isArray(p) ? p : []
      setProjects(list)
      setCwd((c) => c || list[0]?.cwd || "")
    }).catch((e) => {
      if (alive) setProjectsError(userError(e, "recent folders", "load"))
    })
    return () => { alive = false }
  }, [host])

  const aiReady = !!ai && !!aiConfig?.capabilities.editable
  const blocker = startBlocker({ message, aiReady, aiError: aiErrorText, busy })
  // Type a path when asked to, or when the folder isn't one of the recent ones
  // (e.g. typed before the list loaded) — the picker must never show a folder
  // other than the one the chat will start in.
  const typing = customCwd || !projects.some((p) => p.cwd === cwd)

  async function start() {
    const msg = message.trim()
    if (!msg || busy || !ai || !aiConfig?.capabilities.editable) return
    setError("")
    setBusy(true)
    try {
      const res = await api.newSession({
        message: msg,
        cwd: cwd.trim() || "~",
        mode,
        ai,
        host,
        agent: "claude",
        systemPrompt: systemPrompt.trim() || undefined,
        goal: goal.trim() || undefined,
        // The server reads the template's plugin (role skills) and lens from
        // its own row; a client can only name which template it started from.
        template: template?.id,
        jobs: jobs.length ? jobs : undefined,
      })
      // Open it now: the thread shows the message and the working bubble,
      // resolves the transcript once the CLI writes it, then saves the name.
      const name = title.trim()
      navigation.replace("Thread", {
        host,
        label: chatLabel(name, cwd, res.session),
        path: res.path,
        starting: { session: res.session, message: msg, title: name || undefined },
      })
    } catch (e) {
      setError(userError(e, "the chat", "start"))
      setBusy(false)
    }
  }

  function clearTemplate() {
    navigation.setParams({ template: undefined })
    setTitle("")
    setSystemPrompt("")
    setGoal("")
    setJobs([])
    setShowMore(false)
  }

  const catColor = template ? (TEMPLATE_CATEGORIES[template.category]?.color ?? t.accent) : t.accent
  const iconName = (template?.icon || "sparkle") as IconName
  const extras = [title.trim() && "name", jobs.length && `${jobs.length} job${jobs.length > 1 ? "s" : ""}`,
    systemPrompt.trim() && "instructions", goal.trim() && "goal"].filter(Boolean).join(" · ")

  const card = { backgroundColor: t.surface, borderRadius: 12, borderWidth: 1, borderColor: t.border, marginTop: 12, overflow: "hidden" as const }
  const row = { paddingHorizontal: 14, paddingVertical: 10 }
  const divider = <View style={{ height: 1, backgroundColor: t.border, marginHorizontal: 14 }} />
  const rowLabel = (text: string) => <Text style={{ fontSize: 12, color: t.textMuted, marginBottom: 6 }}>{text}</Text>
  const mode_ = modeOf(mode)

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.bg }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={headerHeight}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {template ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12, marginTop: 4, borderRadius: 12, borderWidth: 1, borderColor: catColor + "25", backgroundColor: catColor + "0C" }}>
            <View style={{ width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: catColor + "1A" }}>
              <Icon name={iconName} size={17} color={catColor} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: "700", color: t.text }}>{template.name}</Text>
              {template.description ? (
                <Text style={{ fontSize: 12, color: t.textMuted, marginTop: 2, lineHeight: 16 }} numberOfLines={2}>{template.description}</Text>
              ) : null}
            </View>
            <TouchableOpacity testID="newchat-clear-template" accessibilityLabel="Start without this agent" hitSlop={8} onPress={clearTemplate}
              style={{ width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: t.chipBg }}>
              <Icon name="close" size={12} color={t.textMuted} />
            </TouchableOpacity>
          </View>
        ) : null}

        {/* The one required field. */}
        <View style={card}>
          <TextInput
            testID="newchat-message"
            autoFocus
            style={{ fontSize: 16, color: t.text, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 14, minHeight: 110, maxHeight: 260, textAlignVertical: "top" }}
            placeholder={template ? `What should ${template.name} do?` : "What should the agent do?"}
            placeholderTextColor={t.textMuted + "80"}
            value={message}
            onChangeText={setMessage}
            multiline
          />
        </View>

        {/* Where it works, how much it may do on its own, which AI. */}
        <View style={card}>
          <View style={row}>
            {rowLabel("Folder")}
            {projects.length ? (
              <Dropdown
                testIDPrefix="newchat-project"
                value={typing ? "" : cwd}
                options={[...projectOptions(projects), { v: "", label: "Other folder…" }]}
                onChange={(v) => { setCustomCwd(!v); if (v) setCwd(v) }}
              />
            ) : null}
            {typing ? (
              <TextInput
                testID="newchat-cwd"
                style={[styles.input, { fontSize: 14, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", marginTop: projects.length ? 8 : 0 }]}
                placeholder="~/path/to/project"
                placeholderTextColor={t.textMuted + "80"}
                autoCapitalize="none"
                autoCorrect={false}
                value={cwd}
                onChangeText={setCwd}
              />
            ) : null}
            {!typing && cwd ? <Text style={{ fontSize: 11, color: t.textMuted, marginTop: 4 }} numberOfLines={1}>{cwd}</Text> : null}
            {projectsError ? <Text style={{ fontSize: 11, color: t.textMuted, marginTop: 4 }}>{projectsError} Type a path instead.</Text> : null}
          </View>
          {divider}
          <View style={row}>
            {rowLabel("Permissions")}
            <Dropdown testIDPrefix="newchat-mode" value={mode} options={MODES} onChange={setMode} />
            <Text testID="newchat-mode-hint" style={{ fontSize: 11, marginTop: 4, color: mode === "bypassPermissions" ? t.danger : t.textMuted }}>{mode_.hint}</Text>
          </View>
          {divider}
          <TouchableOpacity testID="newchat-ai-row" disabled={!aiConfig?.capabilities.editable || busy} onPress={() => setProviderPickerOpen(true)}
            style={[row, { flexDirection: "row", alignItems: "center" }]}>
            <View style={{ flex: 1 }}>
              {rowLabel("AI")}
              <Text style={{ color: t.text, fontSize: 14 }} numberOfLines={2}>{ai ? aiSummary(ai, providers) : aiErrorText || "Loading AI settings…"}</Text>
            </View>
            {aiConfig?.capabilities.editable ? <Icon name="chevronRight" size={14} color={t.textMuted} /> : null}
          </TouchableOpacity>
          {aiErrorText ? <Text testID="newchat-ai-error" style={styles.sheetHint}>{aiErrorText}</Text> : null}
          {providerPickerOpen && aiConfig ? <ProviderPicker config={aiConfig} scope={{host}} providers={providers} title="AI for this chat" localOnly onSave={setAIConfig} onClose={() => setProviderPickerOpen(false)}/> : null}
        </View>

        {/* Everything optional, collapsed until wanted; the summary says what is set. */}
        <View style={card}>
          <TouchableOpacity testID="newchat-more" style={[row, { flexDirection: "row", alignItems: "center", paddingVertical: 12 }]} onPress={() => setShowMore((v) => !v)}>
            <Icon name={showMore ? "chevronDown" : "chevronRight"} size={13} color={t.textMuted} />
            <Text style={{ fontSize: 14, fontWeight: "600", color: t.text, marginLeft: 8 }}>More options</Text>
            <Text style={{ fontSize: 12, color: t.textMuted, marginLeft: 8, flex: 1 }} numberOfLines={1}>
              {extras || "Name, jobs, instructions, goal"}
            </Text>
          </TouchableOpacity>
          {showMore ? (
            <>
              {divider}
              <View style={row}>
                {rowLabel("Chat name")}
                <TextInput testID="newchat-title" style={[styles.input, { fontSize: 14 }]} placeholder="Optional — e.g. Refactor auth"
                  placeholderTextColor={t.textMuted + "80"} value={title} onChangeText={setTitle} />
              </View>
              {divider}
              <View style={row}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Text style={{ fontSize: 12, color: t.textMuted }}>Scheduled jobs</Text>
                  {local && jobForm === -2 ? (
                    <TouchableOpacity testID="newchat-add-job" hitSlop={8} onPress={() => setJobForm(-1)}
                      style={{ flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: t.accent + "15" }}>
                      <Icon name="add" size={13} color={t.accent} />
                      <Text style={{ fontSize: 11, fontWeight: "600", color: t.accent }}>Add</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                {!local ? (
                  <Text style={{ fontSize: 12, color: t.textMuted, marginTop: 6 }}>Jobs run on this machine's scheduler — start the chat here to add one.</Text>
                ) : !jobs.length && jobForm === -2 ? (
                  <Text style={{ fontSize: 12, color: t.textMuted, marginTop: 6 }}>Have the agent come back on a schedule — e.g. a daily summary.</Text>
                ) : null}
                {jobs.map((job, i) => (
                  <View key={i}>
                    <TouchableOpacity testID={`newchat-job-${i}`} activeOpacity={0.65} onPress={() => setJobForm(jobForm === i ? -2 : i)}
                      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 }}>
                      <Icon name="repeat" size={15} color={t.accent} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 13, color: t.text }} numberOfLines={2}>{job.prompt}</Text>
                        <Text style={{ fontSize: 11, color: t.textMuted, marginTop: 1 }}>{describeSchedule(job)}</Text>
                      </View>
                      <TouchableOpacity testID={`newchat-remove-job-${i}`} accessibilityLabel="Remove job" hitSlop={8}
                        onPress={() => { setJobs((prev) => prev.filter((_, j) => j !== i)); setJobForm(-2) }}>
                        <Icon name="trash" size={14} color={t.danger} />
                      </TouchableOpacity>
                    </TouchableOpacity>
                    {jobForm === i ? (
                      <JobScheduler styles={styles} initialValues={job} onCancel={() => setJobForm(-2)}
                        onSubmit={(prompt, schedule) => { setJobs((prev) => prev.map((j, k) => k === i ? { prompt, ...schedule } : j)); setJobForm(-2) }} />
                    ) : null}
                  </View>
                ))}
                {jobForm === -1 ? (
                  <JobScheduler styles={styles} onCancel={() => setJobForm(-2)}
                    onSubmit={(prompt, schedule) => { setJobs((prev) => [...prev, { prompt, ...schedule }]); setJobForm(-2) }} />
                ) : null}
              </View>
              {divider}
              <View style={row}>
                {rowLabel("Instructions (system prompt)")}
                <TextInput testID="newchat-system-prompt" style={[styles.input, { fontSize: 14, minHeight: 72, textAlignVertical: "top" }]}
                  placeholder="How the agent should behave in this chat" placeholderTextColor={t.textMuted + "80"} multiline
                  value={systemPrompt} onChangeText={setSystemPrompt} />
              </View>
              {divider}
              <View style={row}>
                {rowLabel("Goal")}
                <TextInput testID="newchat-goal" style={[styles.input, { fontSize: 14 }]} placeholder="What counts as done — the agent checks it before stopping"
                  placeholderTextColor={t.textMuted + "80"} value={goal} onChangeText={setGoal} />
              </View>
            </>
          ) : null}
        </View>
      </ScrollView>

      {/* Pinned above the keyboard: the error, why Start is off, and Start. */}
      <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14, borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.bg }}>
        {error ? (
          <Text testID="newchat-error" style={{ fontSize: 13, color: t.danger, marginBottom: 8 }}>{error}</Text>
        ) : null}
        <TouchableOpacity
          testID="newchat-start"
          style={{ backgroundColor: t.accent, borderRadius: 12, paddingVertical: 14, alignItems: "center", opacity: blocker || busy ? 0.45 : 1 }}
          onPress={start}
          disabled={!!blocker || busy}
        >
          {busy ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ActivityIndicator color={t.onAccent} size="small" />
              <Text style={{ color: t.onAccent, fontSize: 15, fontWeight: "500" }}>Starting…</Text>
            </View>
          ) : (
            <Text style={{ color: t.onAccent, fontSize: 16, fontWeight: "600" }}>Start chat</Text>
          )}
        </TouchableOpacity>
        <Text testID="newchat-start-hint" style={{ fontSize: 11, color: t.textMuted, textAlign: "center", marginTop: 6 }}>
          {blocker || `Runs on ${local ? "this machine" : host} · ${mode_.label}`}
        </Text>
      </View>
    </KeyboardAvoidingView>
  )
}
