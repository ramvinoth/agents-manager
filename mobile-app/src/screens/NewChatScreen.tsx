import React, { useCallback, useEffect, useState } from "react"
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Project, type Provider } from "../api/client"
import { composerPrefs, currentHost, setComposerPrefs } from "../state/config"
import Dropdown from "../components/Dropdown"
import Icon, { type IconName } from "../components/Icon"
import JobScheduler from "../components/JobScheduler"
import ProviderPicker from "../components/ProviderPicker"
import { describeSchedule } from "../lib/interval"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "NewChat">

const MODES = [
  { v: "acceptEdits", label: "Accept edits" },
  { v: "default", label: "Ask" },
  { v: "plan", label: "Plan" },
  { v: "bypassPermissions", label: "Bypass" },
]

const MODELS = [
  { v: "default", label: "Default" },
  { v: "sonnet", label: "Sonnet" },
  { v: "opus", label: "Opus" },
  { v: "haiku", label: "Haiku" },
]

const EFFORTS = [
  { v: "low", label: "Low" },
  { v: "medium", label: "Medium" },
  { v: "high", label: "High (default)" },
  { v: "xhigh", label: "Extra High" },
  { v: "max", label: "Max" },
]

function short(p: string): string {
  const parts = p.split("/").filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

const CATEGORY_COLOR: Record<string, string> = {
  personal: "#6b8e6b",
  engineering: "#7a8eb5",
  design: "#b07aad",
  business: "#c2884a",
}

/**
 * Poll /api/resolve until the session JSONL appears (Claude creates it
 * asynchronously after /api/new-session returns). Retries up to ~20s.
 */
async function waitForPath(sessionId: string, host: string): Promise<string | null> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      const res = await api.resolve(sessionId, host)
      if (res.found && res.path) return res.path
    } catch { /* retry */ }
  }
  return null
}

export default function NewChatScreen({ navigation, route }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const template = route.params?.template

  // Host is always the current active host — no picker needed.
  const host = currentHost()

  const [projects, setProjects] = useState<Project[]>([])
  const [cwd, setCwd] = useState("")
  const [message, setMessage] = useState("")
  const [title, setTitle] = useState(template?.name ?? "")
  const [systemPrompt, setSystemPrompt] = useState(template?.system_prompt ?? "")
  const [goal, setGoal] = useState(template?.goal ?? "")
  const [mode, setModeState] = useState(composerPrefs().mode)
  const setMode = (v: string) => {
    setModeState(v)
    setComposerPrefs({ mode: v })
  }
  const [model, setModelState] = useState(
    template?.model && template.model !== "default" ? template.model : composerPrefs().model || "default"
  )
  const setModel = (v: string) => {
    setModelState(v)
    if (!template?.model) setComposerPrefs({ model: v })
  }
  const [effort, setEffort] = useState("high")
  const [busy, setBusy] = useState(false)
  const [busyText, setBusyText] = useState("")
  const [error, setError] = useState("")
  const [showAdvanced, setShowAdvanced] = useState(!!template)

  // Scheduled jobs
  type Job = { prompt: string; cron?: string; interval?: number }
  const [jobs, setJobs] = useState<Job[]>(() => {
    if (template?.cron && template?.job_prompt) {
      return [{ prompt: template.job_prompt, cron: template.cron }]
    }
    return []
  })
  const [showJobForm, setShowJobForm] = useState(false)
  const [editingJobIdx, setEditingJobIdx] = useState(-1)

  // Provider
  const [provider, setProvider] = useState("")
  const [providers, setProviders] = useState<Provider[]>([])
  const [providerPickerOpen, setProviderPickerOpen] = useState(false)

  useEffect(() => {
    api.providers().then((r) => {
      const list = r.providers || []
      setProviders(list)
      // Auto-select the default provider (if one is marked) for new sessions.
      const def = list.find((p) => p.isDefault)
      if (def) setProvider(def.id)
    }).catch(() => {})
  }, [])

  const loadProjects = useCallback(async () => {
    try {
      const p = await api.projects(host)
      setProjects(Array.isArray(p) ? p : [])
      if (!cwd && p.length) setCwd(p[0].cwd)
    } catch {
      setProjects([])
    }
  }, [host]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadProjects() }, [loadProjects])

  async function start() {
    const msg = message.trim()
    if (!msg || busy) return
    setError("")
    setBusy(true)
    setBusyText("Starting session…")
    try {
      const res = await api.newSession({
        message: msg,
        cwd: cwd.trim() || "~",
        mode,
        model: model !== "default" ? model : undefined,
        host,
        agent: "claude",
        systemPrompt: systemPrompt.trim() || undefined,
        goal: goal.trim() || undefined,
        effort: effort !== "high" ? effort : undefined,
      })

      // The server may return `path` (for codex/copilot) or not (Claude).
      // For Claude, poll /api/resolve until the JSONL appears.
      let sessionPath: string | undefined = res.path
      if (!sessionPath) {
        setBusyText("Waiting for session…")
        const resolved = await waitForPath(res.session, host)
        if (resolved) sessionPath = resolved
      }
      if (!sessionPath) {
        setError("Session started but transcript not found. Check the Chats tab.")
        setBusy(false)
        return
      }

      // Save title to session meta (the server's new-session handler doesn't do this for Claude).
      const trimTitle = title.trim()
      if (trimTitle) {
        api.renameSession({ session: sessionPath, title: trimTitle, host }).catch(() => {})
      }

      // Save provider to session meta.
      if (provider) {
        api.sessionMetaSave({ session: sessionPath, provider, host }).catch(() => {})
      }

      // Create all scheduled jobs.
      if (jobs.length > 0) {
        for (const job of jobs) {
          api.loopsCreate({
            session: sessionPath,
            prompt: job.prompt,
            cron: job.cron,
            interval: job.interval,
            model: model !== "default" ? model : undefined,
          }).catch(() => {})
        }
      }

      navigation.replace("Thread", {
        host,
        label: trimTitle || short(cwd) || res.session.slice(0, 8),
        path: sessionPath,
      })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  function clearTemplate() {
    navigation.setParams({ template: undefined })
    setTitle("")
    setSystemPrompt("")
    setGoal("")
    setJobs([])
    setShowAdvanced(false)
  }

  const catColor = template ? (CATEGORY_COLOR[template.category] ?? t.accent) : t.accent
  const iconName = (template?.icon || "sparkle") as IconName
  const providerName = provider === "" ? "Built-in (Claude)" : providers.find((p) => p.id === provider)?.name || "Custom"

  // --- Card wrapper ---
  const card = (children: React.ReactNode) => (
    <View style={{
      backgroundColor: t.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: t.border,
      marginTop: 14,
      overflow: "hidden",
    }}>
      {children}
    </View>
  )

  const sectionLabel = (text: string) => (
    <Text style={{
      fontSize: 11,
      fontWeight: "700",
      color: t.textMuted,
      letterSpacing: 0.5,
      textTransform: "uppercase",
      paddingHorizontal: 14,
      paddingTop: 14,
      paddingBottom: 6,
    }}>{text}</Text>
  )

  const divider = () => <View style={{ height: 1, backgroundColor: t.border, marginHorizontal: 14 }} />

  const selectorRow = (label: string, value: string, icon: IconName, onPress?: () => void) => (
    <TouchableOpacity
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
      activeOpacity={onPress ? 0.5 : 1}
      onPress={onPress}
      disabled={!onPress}
    >
      <Icon name={icon} size={16} color={t.textMuted} />
      <Text style={{ fontSize: 13, color: t.textMuted, marginLeft: 8, flex: 1 }}>{label}</Text>
      <Text style={{ fontSize: 14, color: t.text, fontWeight: "500" }}>{value}</Text>
      {onPress ? <View style={{ marginLeft: 6 }}><Icon name="chevronRight" size={12} color={t.border} /></View> : null}
    </TouchableOpacity>
  )

  // Build project dropdown options from recent projects
  const projectOptions = [
    { v: "", label: "Custom path…" },
    ...projects.slice(0, 12).map((p) => ({ v: p.cwd, label: short(p.cwd) })),
  ]

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
      >
        {/* Template banner */}
        {template ? (
          <View style={{
            backgroundColor: catColor + "0C",
            borderRadius: 12,
            borderWidth: 1,
            borderColor: catColor + "25",
            padding: 14,
            marginTop: 6,
          }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{
                width: 38, height: 38, borderRadius: 10,
                alignItems: "center", justifyContent: "center",
                backgroundColor: catColor + "1A",
              }}>
                <Icon name={iconName} size={18} color={catColor} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: "700", color: t.text }}>{template.name}</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
                  <Text style={{ fontSize: 11, color: t.textMuted }}>
                    {template.category.charAt(0).toUpperCase() + template.category.slice(1)}
                  </Text>
                  {template.model ? (
                    <View style={{ backgroundColor: t.chipBg, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
                      <Text style={{ fontSize: 9, fontWeight: "700", color: t.textMuted, textTransform: "capitalize" }}>
                        {template.model}
                      </Text>
                    </View>
                  ) : null}
                  {template.cron ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                      <Icon name="repeat" size={9} color={t.textMuted} />
                      <Text style={{ fontSize: 9, color: t.textMuted }}>Scheduled</Text>
                    </View>
                  ) : null}
                </View>
              </View>
              <TouchableOpacity
                style={{ width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: t.chipBg }}
                onPress={clearTemplate}
              >
                <Icon name="close" size={12} color={t.textMuted} />
              </TouchableOpacity>
            </View>
            {template.description ? (
              <Text style={{ fontSize: 12, color: t.textMuted, marginTop: 8, lineHeight: 17 }}>
                {template.description}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* ── First message ── */}
        {card(<>
          {sectionLabel("First message")}
          <TextInput
            testID="newchat-message"
            style={{
              fontSize: 15,
              color: t.text,
              paddingHorizontal: 14,
              paddingVertical: 10,
              minHeight: 80,
              textAlignVertical: "top",
            }}
            placeholder={template ? `What should ${template.name} do?` : "What should the agent do?"}
            placeholderTextColor={t.textMuted + "80"}
            value={message}
            onChangeText={setMessage}
            multiline
          />
        </>)}

        {/* ── Working directory + Chat name ── */}
        {card(<>
          {sectionLabel("Working directory")}
          <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
            {projects.length > 0 ? (
              <>
                <Dropdown
                  testIDPrefix="newchat-project"
                  value={projects.some((p) => p.cwd === cwd) ? cwd : ""}
                  options={projectOptions}
                  onChange={(v) => setCwd(v)}
                />
                {/* Show text input when custom path is selected or cwd doesn't match any project */}
                {!projects.some((p) => p.cwd === cwd) ? (
                  <TextInput
                    testID="newchat-cwd"
                    style={{
                      fontSize: 14,
                      color: t.text,
                      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                      backgroundColor: t.bg,
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      borderWidth: 1,
                      borderColor: t.border,
                      marginTop: 8,
                    }}
                    placeholder="~/path/to/project"
                    placeholderTextColor={t.textMuted + "80"}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={cwd}
                    onChangeText={setCwd}
                  />
                ) : null}
              </>
            ) : (
              <TextInput
                testID="newchat-cwd"
                style={{
                  fontSize: 14,
                  color: t.text,
                  fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                  backgroundColor: t.bg,
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  borderWidth: 1,
                  borderColor: t.border,
                }}
                placeholder="~/path/to/project"
                placeholderTextColor={t.textMuted + "80"}
                autoCapitalize="none"
                autoCorrect={false}
                value={cwd}
                onChangeText={setCwd}
              />
            )}
          </View>
          {divider()}
          <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
            <Text style={{ fontSize: 12, color: t.textMuted, marginBottom: 6 }}>Chat name</Text>
            <TextInput
              testID="newchat-title"
              style={{
                fontSize: 14,
                color: t.text,
                backgroundColor: t.bg,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderWidth: 1,
                borderColor: t.border,
              }}
              placeholder="Optional — e.g. refactor auth"
              placeholderTextColor={t.textMuted + "80"}
              value={title}
              onChangeText={setTitle}
            />
          </View>
        </>)}

        {/* ── Configuration: mode, model, provider ── */}
        {card(<>
          {sectionLabel("Configuration")}
          <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
            <Text style={{ fontSize: 12, color: t.textMuted, marginBottom: 6 }}>Permission mode</Text>
            <Dropdown testIDPrefix="newchat-mode" value={mode} options={MODES} onChange={setMode} />
          </View>
          {divider()}
          <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
            <Text style={{ fontSize: 12, color: t.textMuted, marginBottom: 6 }}>Model</Text>
            <Dropdown testIDPrefix="newchat-model" value={model} options={MODELS} onChange={setModel} />
          </View>
          {divider()}
          <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
            <Text style={{ fontSize: 12, color: t.textMuted, marginBottom: 6 }}>Effort level</Text>
            <Dropdown testIDPrefix="newchat-effort" value={effort} options={EFFORTS} onChange={setEffort} />
          </View>
          {divider()}
          {selectorRow("Provider", providerName, provider === "" ? "sparkle" : "server", () => setProviderPickerOpen(true))}
          <ProviderPicker
            visible={providerPickerOpen}
            providers={providers}
            selected={provider}
            onSelect={(id) => setProvider(id)}
            onClose={() => setProviderPickerOpen(false)}
            onManage={() => { setProviderPickerOpen(false); navigation.navigate("Providers" as never) }}
          />
        </>)}

        {/* ── Scheduled jobs ── */}
        {card(<>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingRight: 14 }}>
            {sectionLabel("Scheduled jobs")}
            {!showJobForm ? (
              <TouchableOpacity
                testID="newchat-add-job"
                style={{ flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: t.accent + "15" }}
                onPress={() => { setEditingJobIdx(-1); setShowJobForm(true) }}
              >
                <Icon name="add" size={13} color={t.accent} />
                <Text style={{ fontSize: 11, fontWeight: "600", color: t.accent }}>Add</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {jobs.map((job, i) => {
            const isEditing = showJobForm && editingJobIdx === i
            return (
              <View key={i}>
                <TouchableOpacity
                  testID={`newchat-job-${i}`}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    backgroundColor: isEditing ? t.accent + "08" : "transparent",
                  }}
                  activeOpacity={0.65}
                  onPress={() => {
                    if (isEditing) { setShowJobForm(false); setEditingJobIdx(-1) }
                    else { setEditingJobIdx(i); setShowJobForm(true) }
                  }}
                >
                  <Icon name="repeat" size={15} color={t.accent} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, color: t.text }} numberOfLines={2}>{job.prompt}</Text>
                    <Text style={{ fontSize: 11, color: t.textMuted, marginTop: 1 }}>
                      {describeSchedule({ cron: job.cron, interval: job.interval ?? 0 })}
                    </Text>
                  </View>
                  <TouchableOpacity
                    testID={`newchat-remove-job-${i}`}
                    onPress={() => {
                      setJobs((prev) => prev.filter((_, j) => j !== i))
                      if (editingJobIdx === i) { setShowJobForm(false); setEditingJobIdx(-1) }
                    }}
                    hitSlop={8}
                  >
                    <Icon name="trash" size={14} color={t.danger} />
                  </TouchableOpacity>
                </TouchableOpacity>
                {isEditing ? (
                  <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
                    <JobScheduler
                      styles={styles}
                      initialValues={job}
                      onCancel={() => { setShowJobForm(false); setEditingJobIdx(-1) }}
                      onSubmit={(prompt, schedule) => {
                        setJobs((prev) => prev.map((j, idx) => idx === i ? { prompt, ...schedule } : j))
                        setShowJobForm(false)
                        setEditingJobIdx(-1)
                      }}
                    />
                  </View>
                ) : null}
              </View>
            )
          })}

          {jobs.length === 0 && !showJobForm ? (
            <Text style={{ fontSize: 12, color: t.textMuted + "80", paddingHorizontal: 14, paddingBottom: 14, fontStyle: "italic" }}>
              No scheduled jobs
            </Text>
          ) : null}

          {showJobForm && editingJobIdx === -1 ? (
            <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
              <JobScheduler
                styles={styles}
                onCancel={() => setShowJobForm(false)}
                onSubmit={(prompt, schedule) => {
                  setJobs((prev) => [...prev, { prompt, ...schedule }])
                  setShowJobForm(false)
                }}
              />
            </View>
          ) : null}
        </>)}

        {/* ── System prompt & goal (collapsible) ── */}
        {card(<>
          <TouchableOpacity
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 14,
              paddingVertical: 12,
            }}
            onPress={() => setShowAdvanced((v) => !v)}
          >
            <Icon name={showAdvanced ? "chevronDown" : "chevronRight"} size={13} color={t.textMuted} />
            <Text style={{ fontSize: 11, fontWeight: "700", color: t.textMuted, letterSpacing: 0.5, textTransform: "uppercase", marginLeft: 6, flex: 1 }}>
              System prompt & goal
            </Text>
            {(systemPrompt.trim() || goal.trim()) && !showAdvanced ? (
              <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: t.accent }} />
            ) : null}
          </TouchableOpacity>

          {showAdvanced ? (
            <>
              {divider()}
              <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
                <Text style={{ fontSize: 12, color: t.textMuted, marginBottom: 6 }}>System prompt</Text>
                <TextInput
                  testID="newchat-system-prompt"
                  style={{
                    fontSize: 14,
                    color: t.text,
                    backgroundColor: t.bg,
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    borderWidth: 1,
                    borderColor: t.border,
                    minHeight: 72,
                    textAlignVertical: "top",
                  }}
                  placeholder="Instructions for the agent..."
                  placeholderTextColor={t.textMuted + "80"}
                  multiline
                  value={systemPrompt}
                  onChangeText={setSystemPrompt}
                />
              </View>
              {divider()}
              <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
                <Text style={{ fontSize: 12, color: t.textMuted, marginBottom: 6 }}>Goal</Text>
                <TextInput
                  testID="newchat-goal"
                  style={{
                    fontSize: 14,
                    color: t.text,
                    backgroundColor: t.bg,
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    borderWidth: 1,
                    borderColor: t.border,
                  }}
                  placeholder="What should this session accomplish?"
                  placeholderTextColor={t.textMuted + "80"}
                  value={goal}
                  onChangeText={setGoal}
                />
              </View>
            </>
          ) : null}
        </>)}

        {/* ── Error ── */}
        {error ? (
          <View style={{ marginTop: 12, backgroundColor: t.danger + "15", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 }}>
            <Text style={{ fontSize: 13, color: t.danger }}>{error}</Text>
          </View>
        ) : null}

        {/* ── Start button ── */}
        <TouchableOpacity
          testID="newchat-start"
          style={{
            backgroundColor: t.accent,
            borderRadius: 12,
            paddingVertical: 15,
            alignItems: "center",
            marginTop: 20,
            opacity: !message.trim() || busy ? 0.45 : 1,
          }}
          onPress={start}
          disabled={busy || !message.trim()}
        >
          {busy ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={{ color: "#fff", fontSize: 15, fontWeight: "500" }}>{busyText}</Text>
            </View>
          ) : (
            <Text style={{ color: "#fff", fontSize: 16, fontWeight: "600" }}>Start chat</Text>
          )}
        </TouchableOpacity>
        <Text style={{ fontSize: 11, color: t.textMuted + "80", textAlign: "center", marginTop: 8 }}>
          Creates a new session on {host === "local" ? "this machine" : host}
        </Text>
      </ScrollView>
    </View>
  )
}
