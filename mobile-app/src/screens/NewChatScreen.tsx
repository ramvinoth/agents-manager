import React, { useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  Alert,
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

// Name, then message: both are required, in that order — the name is how the
// owner tells this chat apart in every list, push and decision card later, so
// it comes first and takes focus. Where/how/which-AI sit in one compact card
// under them; everything optional hides behind "More options". Start lives in a bar pinned above the
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
  const messageRef = useRef<TextInput>(null)
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
  // Jobs run on this machine's scheduler only (the server refuses them for a
  // remote chat), so a template's job is not sent when starting elsewhere.
  const sendJobs = local ? jobs : []

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
  const blocker = startBlocker({ title, message, aiReady, aiError: aiErrorText, busy })
  // Type a path when asked to, or when the folder isn't one of the recent ones
  // (e.g. typed before the list loaded) — the picker must never show a folder
  // other than the one the chat will start in.
  const typing = customCwd || !projects.some((p) => p.cwd === cwd)

  async function start() {
    const msg = message.trim()
    const name = title.trim()
    if (!name || !msg || busy || !ai || !aiConfig?.capabilities.editable) return
    setError("")
    setBusy(true)
    try {
      const res = await api.newSession({
        message: msg,
        // Sent with the create so the name rides on the run (claude --name)
        // instead of depending on the rename after the chat appears.
        title: name,
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
        jobs: sendJobs.length ? sendJobs : undefined,
      })
      // A server older than the `jobs` field ignores it — say so rather than
      // let the owner believe the schedule exists.
      if (sendJobs.length && (res.jobs?.length ?? 0) !== sendJobs.length) {
        Alert.alert("Chat started without its jobs", "This server didn't save the scheduled jobs. Add them from the chat's profile (tap its name).")
      }
      // Open it now: the thread shows the message and the working bubble,
      // resolves the transcript once the CLI writes it, then saves the name
      // (the rename still covers a remote host, whose run gets no --name).
      navigation.replace("Thread", {
        host,
        label: chatLabel(name, cwd, res.session),
        path: res.path,
        starting: { session: res.session, message: msg },
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
  const extras = [sendJobs.length && `${sendJobs.length} job${sendJobs.length > 1 ? "s" : ""}`,
    systemPrompt.trim() && "instructions", goal.trim() && "goal"].filter(Boolean).join(" · ")

  const divider = <View style={styles.ncDivider} />
  const rowLabel = (text: string) => <Text style={styles.ncLabel}>{text}</Text>
  const mode_ = modeOf(mode)

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={headerHeight}
    >
      <ScrollView
        style={styles.flex1}
        contentContainerStyle={styles.ncScroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {template ? (
          <View style={[styles.ncTemplate, { borderColor: catColor + "25", backgroundColor: catColor + "0C" }]}>
            <View style={[styles.ncTemplateIcon, { backgroundColor: catColor + "1A" }]}>
              <Icon name={iconName} size={17} color={catColor} />
            </View>
            <View style={styles.flex1}>
              <Text style={styles.ncTemplateName}>{template.name}</Text>
              {template.description ? (
                <Text style={styles.ncTemplateDesc} numberOfLines={2}>{template.description}</Text>
              ) : null}
            </View>
            <TouchableOpacity testID="newchat-clear-template" accessibilityLabel="Start without this agent" hitSlop={8} onPress={clearTemplate}
              style={styles.ncClose}>
              <Icon name="close" size={12} color={t.textMuted} />
            </TouchableOpacity>
          </View>
        ) : null}

        {/* The two required fields, name first. */}
        <View style={styles.ncCard}>
          <TextInput
            testID="newchat-title"
            autoFocus
            style={styles.ncName}
            placeholder="Chat name — e.g. Refactor auth"
            placeholderTextColor={t.textMuted + "80"}
            value={title}
            onChangeText={setTitle}
            returnKeyType="next"
            blurOnSubmit={false}
            onSubmitEditing={() => messageRef.current?.focus()}
            maxLength={200}
          />
          {divider}
          <TextInput
            testID="newchat-message"
            ref={messageRef}
            style={styles.ncMessage}
            placeholder={template ? `What should ${template.name} do?` : "What should the agent do?"}
            placeholderTextColor={t.textMuted + "80"}
            value={message}
            onChangeText={setMessage}
            multiline
          />
        </View>

        {/* Where it works, how much it may do on its own, which AI. */}
        <View style={styles.ncCard}>
          <View style={styles.ncRow}>
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
            {!typing && cwd ? <Text style={styles.ncSmallHint} numberOfLines={1}>{cwd}</Text> : null}
            {projectsError ? <Text style={styles.ncSmallHint}>{projectsError} Type a path instead.</Text> : null}
          </View>
          {divider}
          <View style={styles.ncRow}>
            {rowLabel("Permissions")}
            <Dropdown testIDPrefix="newchat-mode" value={mode} options={MODES} onChange={setMode} />
            <Text testID="newchat-mode-hint" style={[styles.ncSmallHint, mode === "bypassPermissions" && styles.ncDanger]}>{mode_.hint}</Text>
          </View>
          {divider}
          <TouchableOpacity testID="newchat-ai-row" disabled={!aiConfig?.capabilities.editable || busy} onPress={() => setProviderPickerOpen(true)}
            style={[styles.ncRow, styles.rowCenter]}>
            <View style={styles.flex1}>
              {rowLabel("AI")}
              <Text style={styles.ncValue} numberOfLines={2}>{ai ? aiSummary(ai, providers) : aiErrorText || "Loading AI settings…"}</Text>
            </View>
            {aiConfig?.capabilities.editable ? <Icon name="chevronRight" size={14} color={t.textMuted} /> : null}
          </TouchableOpacity>
          {aiErrorText ? <Text testID="newchat-ai-error" style={styles.sheetHint}>{aiErrorText}</Text> : null}
          {providerPickerOpen && aiConfig ? <ProviderPicker config={aiConfig} scope={{host}} providers={providers} title="AI for this chat" localOnly onSave={setAIConfig} onClose={() => setProviderPickerOpen(false)}/> : null}
        </View>

        {/* Everything optional, collapsed until wanted; the summary says what is set. */}
        <View style={styles.ncCard}>
          <TouchableOpacity testID="newchat-more" style={[styles.ncRow, styles.rowCenter, styles.ncMoreRow]} onPress={() => setShowMore((v) => !v)}>
            <Icon name={showMore ? "chevronDown" : "chevronRight"} size={13} color={t.textMuted} />
            <Text style={styles.ncMoreTitle}>More options</Text>
            <Text style={styles.ncMoreSummary} numberOfLines={1}>
              {extras || "Jobs, instructions, goal"}
            </Text>
          </TouchableOpacity>
          {showMore ? (
            <>
              {divider}
              <View style={styles.ncRow}>
                <View style={styles.ncSpread}>
                  <Text style={styles.ncJobsLabel}>Scheduled jobs</Text>
                  {local ? (
                    <TouchableOpacity testID="newchat-add-job" hitSlop={8} onPress={() => setJobForm(-1)}
                      style={styles.ncAddBtn}>
                      <Icon name="add" size={13} color={t.accent} />
                      <Text style={styles.ncAddText}>Add</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                {!local ? (
                  <Text style={styles.ncJobsHint}>Jobs run on this machine's scheduler — start the chat here to add one.</Text>
                ) : !jobs.length ? (
                  <Text style={styles.ncJobsHint}>Have the agent come back on a schedule — e.g. a daily summary.</Text>
                ) : null}
                {sendJobs.map((job, i) => (
                  <View key={i}>
                    <TouchableOpacity testID={`newchat-job-${i}`} activeOpacity={0.65} onPress={() => setJobForm(i)}
                      style={styles.ncJob}>
                      <Icon name="repeat" size={15} color={t.accent} />
                      <View style={styles.flex1}>
                        <Text style={styles.ncJobPrompt} numberOfLines={2}>{job.prompt}</Text>
                        <Text style={styles.ncJobWhen}>{describeSchedule(job)}</Text>
                      </View>
                      <TouchableOpacity testID={`newchat-remove-job-${i}`} accessibilityLabel="Remove job" hitSlop={8}
                        onPress={() => { setJobs((prev) => prev.filter((_, j) => j !== i)); setJobForm(-2) }}>
                        <Icon name="trash" size={14} color={t.danger} />
                      </TouchableOpacity>
                    </TouchableOpacity>
                  </View>
                ))}
                <JobScheduler
                  visible={jobForm !== -2}
                  styles={styles}
                  initialValues={jobForm >= 0 ? jobs[jobForm] : undefined}
                  onClose={() => setJobForm(-2)}
                  onSubmit={(prompt, schedule) => {
                    const job = { prompt, ...schedule }
                    setJobs((prev) => jobForm >= 0 ? prev.map((j, k) => k === jobForm ? job : j) : [...prev, job])
                    setJobForm(-2)
                  }}
                />
              </View>
              {divider}
              <View style={styles.ncRow}>
                {rowLabel("Instructions (system prompt)")}
                <TextInput testID="newchat-system-prompt" style={[styles.input, { fontSize: 14, minHeight: 72, textAlignVertical: "top" }]}
                  placeholder="How the agent should behave in this chat" placeholderTextColor={t.textMuted + "80"} multiline
                  value={systemPrompt} onChangeText={setSystemPrompt} />
              </View>
              {divider}
              <View style={styles.ncRow}>
                {rowLabel("Goal")}
                <TextInput testID="newchat-goal" style={[styles.input, { fontSize: 14 }]} placeholder="What counts as done — the agent checks it before stopping"
                  placeholderTextColor={t.textMuted + "80"} value={goal} onChangeText={setGoal} />
              </View>
            </>
          ) : null}
        </View>
      </ScrollView>

      {/* Pinned above the keyboard: the error, why Start is off, and Start. */}
      <View style={styles.ncFooter}>
        {error ? (
          <Text testID="newchat-error" style={styles.ncError}>{error}</Text>
        ) : null}
        <TouchableOpacity
          testID="newchat-start"
          style={[styles.ncStart, (!!blocker || busy) && styles.ncStartOff]}
          onPress={start}
          disabled={!!blocker || busy}
        >
          {busy ? (
            <View style={styles.ncBusy}>
              <ActivityIndicator color={t.onAccent} size="small" />
              <Text style={styles.ncBusyText}>Starting…</Text>
            </View>
          ) : (
            <Text style={styles.ncStartText}>Start chat</Text>
          )}
        </TouchableOpacity>
        <Text testID="newchat-start-hint" style={styles.ncStartHint}>
          {blocker || `Runs on ${local ? "this machine" : host} · ${mode_.label}`}
        </Text>
      </View>
    </KeyboardAvoidingView>
  )
}
