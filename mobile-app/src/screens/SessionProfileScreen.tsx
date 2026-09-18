import React, { useEffect, useState } from "react"
import {
  ActivityIndicator,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Capabilities, type GitStatus, type Job, type Provider, type SessionSummary } from "../api/client"
import { AVATARS, avatarGlyph } from "../lib/avatars"
import { describeSchedule, fmtNextRun } from "../lib/interval"
import { compactNumber, durationBetween, shortModel, topTools } from "../lib/stats"
import { groupThread, itemPreview, itemUuid, parseTranscript, type ThreadItem } from "../lib/thread"
import { composerPrefs, notifyEveryReply, setComposerPrefs, setNotifyEveryReply } from "../state/config"
import { useTheme } from "../lib/useTheme"
import Avatar from "../components/Avatar"
import Icon from "../components/Icon"
import JobScheduler from "../components/JobScheduler"
import ProviderPicker from "../components/ProviderPicker"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "SessionProfile">

const MODES = [
  { v: "acceptEdits", label: "Accept edits" },
  { v: "default", label: "Ask" },
  { v: "plan", label: "Plan" },
  { v: "bypassPermissions", label: "Bypass" },
]
const MODELS = [
  { v: "default", label: "Default model" },
  { v: "sonnet", label: "Sonnet" },
  { v: "haiku", label: "Haiku" },
]

/**
 * The session's home page — reached by tapping its name in the thread header.
 * Consolidates everything about one session in one place (WhatsApp contact
 * style): its avatar + name at the top, then the controls that used to live in
 * the composer's gear sheet (permission mode, model, system prompt, goal,
 * scheduled jobs, notify) plus its read-only stats. With NO provider, the
 * model pick here is the DEVICE-WIDE composer default (it drives every
 * provider-less session); WITH a provider, the model is the preset's own
 * model — shown read-only, because the provider is the editing surface. The
 * rest persists via /api/session-meta and /api/loops.
 */
export default function SessionProfileScreen({ route, navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const { host, path, sessionId } = route.params
  // A stable, always-defined key for the avatar's default glyph + colour.
  const seed = sessionId || path || "session"

  const [avatar, setAvatar] = useState("")
  const [title, setTitle] = useState(route.params.label || "")
  const [systemPrompt, setSystemPrompt] = useState("")
  const [goal, setGoal] = useState("")
  const [saved, setSaved] = useState<"systemPrompt" | "goal" | "title" | null>(null)
  const [mode, setModeState] = useState(composerPrefs().mode)
  const [model, setModelState] = useState(
    MODELS.some((m) => m.v === composerPrefs().model) ? composerPrefs().model : "default"
  )
  const [jobs, setJobs] = useState<Job[]>([])
  const [notify, setNotify] = useState(notifyEveryReply())
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  // Pinned messages: uuids from session meta, resolved to preview text by parsing
  // the transcript. Tapping one navigates back to the thread and jumps to it.
  const [pinned, setPinned] = useState<string[]>([])
  const [pinnedItems, setPinnedItems] = useState<{ uuid: string; text: string }[]>([])

  // Custom LLM providers. `provider` is the session's chosen preset id ("" =
  // Default/Claude), persisted server-side in session-meta (unlike model, which
  // is a device-global preference). `providers` is the list of saved presets.
  const [provider, setProvider] = useState("")
  const [providers, setProviders] = useState<Provider[]>([])
  // Conversation mode for a custom provider: "chat" (plain proxy) or "agent"
  // (the full Claude Code harness pointed at the endpoint). Per-session, saved
  // server-side. Only meaningful when a custom provider is selected.
  const [convMode, setConvMode] = useState<"chat" | "agent">("chat")
  const [effort, setEffort] = useState("")
  // Bottom-sheet provider picker (select-only). Provider CRUD lives in ProvidersScreen.
  const [providerPickerOpen, setProviderPickerOpen] = useState(false)
  // Which collapsible cards are open. Behaviour + Model open by default (the
  // knobs you actually turn); Persona / Automation / Stats collapsed (reference /
  // occasional). Stable order + icons = muscle memory.
  const [open, setOpen] = useState<Record<string, boolean>>({ behaviour: true, model: true })
  // Git status for the session's working dir (repo·branch·remote·ahead/behind).
  // null until loaded; {repo:false} when the cwd isn't a git repo (card hidden).
  const [cwd, setCwd] = useState("")
  const [git, setGit] = useState<GitStatus | null>(null)
  // Read-only capabilities (skills + MCP tools) for THIS session's working dir.
  // Editing lives in the thread's CapabilitiesDrawer — the profile only mirrors,
  // so there is one CRUD surface, not two. null until the cwd is known + loaded.
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [syncing, setSyncing] = useState(false)
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }))

  // Load meta + jobs + stats once. A missing session (fresh chat with no path
  // yet) simply shows empty fields — everything still saves once it exists.
  useEffect(() => {
    if (path) {
      api
        .sessionMeta(host, path)
        .then((m) => {
          setSystemPrompt(m.systemPrompt || "")
          setGoal(m.goal || "")
          if (m.avatar) setAvatar(m.avatar)
          setPinned(Array.isArray(m.pinned) ? m.pinned : [])
          setProvider(m.provider || "")
          setConvMode(m.convMode === "agent" ? "agent" : "chat")
          setEffort(m.effort || "")
          if (m.cwd) { setCwd(m.cwd); loadGit(m.cwd) }
          // Skills + MCP tools resolve from the working dir, so load them once
          // the cwd is known (host-aware, same endpoint the drawer/tab use).
          api.capabilities(host, m.cwd || undefined).then(setCaps).catch(() => setCaps({ skills: [], mcp: [] }))
        })
        .catch(() => {})
      api.sessionSummary(host, path).then(setSummary).catch(() => {})
    }
    if (sessionId) api.loops(sessionId).then((l) => Array.isArray(l) && setJobs(l)).catch(() => {})
    // Saved provider presets are host-independent (they live on the viewer box).
    api.providers().then((r) => setProviders(r.providers || [])).catch(() => {})
  }, [host, path, sessionId])

  // Resolve pinned uuids → preview text by parsing the transcript. Only runs when
  // there are pins, so unpinned sessions never pay for a transcript read.
  useEffect(() => {
    if (!path || !pinned.length) {
      setPinnedItems([])
      return
    }
    let alive = true
    api
      .sessionRead(host, path, 2000)
      .then((lines) => {
        if (!alive) return
        const items = groupThread(parseTranscript(lines))
        const byUuid = new Map<string, ThreadItem>()
        for (const it of items) {
          const u = itemUuid(it)
          if (u) byUuid.set(u, it)
        }
        setPinnedItems(pinned.map((u) => (byUuid.has(u) ? { uuid: u, text: itemPreview(byUuid.get(u)!) } : { uuid: u, text: "(message unavailable)" })))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [host, path, pinned])

  function flashSaved(field: "systemPrompt" | "goal" | "title") {
    setSaved(field)
    setTimeout(() => setSaved((f) => (f === field ? null : f)), 1600)
  }

  function saveMeta(field: "systemPrompt" | "goal", value: string) {
    if (!path) return
    api.sessionMetaSave({ session: path, [field]: value, host }).catch(() => {})
    flashSaved(field)
  }

  function pickAvatar(a: string) {
    // Toggle off if re-tapping the current one, so a session can go back to its
    // auto-assigned default.
    const next = avatar === a ? "" : a
    setAvatar(next)
    if (path) api.sessionMetaSave({ session: path, avatar: next, host }).catch(() => {})
  }

  function saveTitle() {
    const name = title.trim()
    if (!name || !path) return
    api.renameSession({ session: path, title: name, host, agent: "claude" }).catch(() => {})
    flashSaved("title")
  }

  const setMode = (v: string) => {
    setModeState(v)
    setComposerPrefs({ mode: v })
  }
  const setModel = (v: string) => {
    setModelState(v)
    setComposerPrefs({ model: v })
  }

  // Select Default (or a saved preset) for THIS session — persisted server-side.
  function pickProvider(id: string) {
    setProvider(id)
    if (path) api.sessionMetaSave({ session: path, provider: id, host }).catch(() => {})
  }

  // Conversation mode (Chat | Agent), per-session, persisted server-side.
  function pickConvMode(m: "chat" | "agent") {
    setConvMode(m)
    if (path) api.sessionMetaSave({ session: path, convMode: m, host }).catch(() => {})
  }

  function pickEffort(e: string) {
    setEffort(e)
    // "high" is Claude CLI's own default — store "" so we don't explicitly pass
    // --effort high, which breaks non-Claude backends (e.g. Qwen via vLLM).
    if (path) api.sessionMetaSave({ session: path, effort: e === "high" ? "" : e, host }).catch(() => {})
  }


  function addJob(prompt: string, schedule: { cron?: string; interval?: number; provider?: string }) {
    if (!sessionId) return
    api
      .loopsCreate({ session: path || sessionId, prompt, ...schedule })
      .then(() => api.loops(sessionId))
      .then((l) => Array.isArray(l) && setJobs(l))
      .catch(() => {})
  }

  function removeJob(id: string) {
    setJobs((all) => all.filter((j) => j.id !== id)) // optimistic
    if (editingJobId === id) setEditingJobId(null)
    api.loopsDelete(id).catch(() => {})
  }

  // Edit: update the job via API, then refresh the list.
  const [editingJobId, setEditingJobId] = useState<string | null>(null)
  function editJob(id: string, prompt: string, schedule: { cron?: string; interval?: number; provider?: string }) {
    api
      .loopsEdit({ id, prompt, ...schedule })
      .then(() => sessionId ? api.loops(sessionId) : [])
      .then((l) => { if (Array.isArray(l)) setJobs(l) })
      .catch(() => {})
    setEditingJobId(null)
  }

  // Pause/resume: flip the loop's enabled flag. Optimistic, then refresh. A
  // paused loop stops firing (server filters enabled=TRUE); resuming leaves its
  // nextRun untouched, so an overdue loop fires at most once, not a backlog.
  function toggleJob(j: Job) {
    const next = !(j.enabled ?? true)
    setJobs((all) => all.map((x) => (x.id === j.id ? { ...x, enabled: next } : x)))
    api.loopsEdit({ id: j.id, enabled: next })
      .then(() => sessionId ? api.loops(sessionId) : [])
      .then((l) => { if (Array.isArray(l)) setJobs(l) })
      .catch(() => {})
  }

  function toggleNotify(v: boolean) {
    setNotify(v)
    setNotifyEveryReply(v)
  }

  function unpin(uuid: string) {
    const next = pinned.filter((u) => u !== uuid)
    setPinned(next)
    setPinnedItems((items) => items.filter((it) => it.uuid !== uuid))
    if (path) api.sessionMetaSave({ session: path, pinned: next, host }).catch(() => {})
  }

  function openPinned(uuid: string) {
    navigation.navigate("Thread", { host, label: route.params.label || title || "Chat", path, jumpTo: uuid })
  }

  // Git: fetch repo/branch/ahead-behind for the session's cwd. Silent on error
  // (a non-repo cwd returns {repo:false} → card hidden).
  function loadGit(dir: string) {
    if (!dir) return
    api.gitStatus(host, dir).then(setGit).catch(() => setGit({ repo: false }))
  }

  // Sync: hand the commit→push→rebase instruction to the model in this session.
  // Mirrors web GitSection's SYNC_PROMPT; the work runs as a normal turn, so we
  // send + open the thread to watch it.
  async function doSync() {
    if (!path || syncing) return
    setSyncing(true)
    const prompt = `Sync the current git branch with the remote. In this repo, step by step:
1. Run \`git status\`. Commit any uncommitted changes with a clear message (leave obviously unrelated junk files alone).
2. \`git fetch origin\` and determine the default branch (master or main).
3. Push the current branch to origin (use \`-u\` to set the upstream if it has none).
4. If the current branch is NOT the default branch, rebase it onto the latest \`origin/<default>\`, resolving any conflicts carefully — read both sides of each conflict and preserve the intent of both changes; never blindly take one side. If the project has a fast build/test command, run it after resolving to sanity-check.
5. If the rebase rewrote history, push again with \`--force-with-lease\`.
6. Finish with a short summary: commits made, push result, rebase outcome, and any conflicts you resolved.`
    try {
      await api.chat({ message: prompt, path, host, agent: "claude" })
      navigation.navigate("Thread", { host, label: route.params.label || title || "Chat", path })
    } catch { /* surfaced in the thread */ }
    finally { setSyncing(false) }
  }

  // NOTE: these are render FUNCTIONS, not components — called as {renderPill(...)}
  // / {renderCard(...)}, not <PillRow/>. Defining a component inside render and
  // using it as JSX gives it a new identity every keystroke, so React unmounts +
  // remounts its whole subtree — which drops focus from any TextInput inside
  // (the "keyboard dismisses on every letter" bug). Plain calls inline instead.
  const renderPill = (opts: { v: string; label: string }[], value: string, onPick: (v: string) => void, testPrefix: string) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sheetPills}>
      {opts.map((m) => {
        const active = value === m.v
        return (
          <TouchableOpacity
            key={m.v}
            testID={`${testPrefix}-${m.v}`}
            style={[styles.sheetPill, active ? styles.sheetPillActive : null]}
            onPress={() => onPick(m.v)}
          >
            {active ? <Icon name="check" size={14} color="#fff" /> : null}
            <Text style={[styles.sheetPillText, active ? styles.sheetPillTextActive : null]}>{m.label}</Text>
          </TouchableOpacity>
        )
      })}
    </ScrollView>
  )

  const tools = summary ? topTools(summary.tools) : []
  const maxTool = tools.length ? tools[0].count : 1
  const dur = summary ? durationBetween(summary.startTime, summary.endTime) : ""

  // A collapsible settings card: a stable icon + title + one-line summary of the
  // current value (so you can read state WITHOUT opening it — the muscle-memory
  // shortcut), tapping reveals the controls. `k` keys its open/closed state.
  const renderCard = (k: string, icon: string, title: string, sub: string | undefined, children: React.ReactNode) => {
    const isOpen = !!open[k]
    return (
      <View style={styles.spCard}>
        <TouchableOpacity testID={`sp-card-${k}`} activeOpacity={0.7} style={styles.spCardHead} onPress={() => toggle(k)}>
          <View style={styles.spCardIcon}>
            <Icon name={icon as never} size={17} color={t.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.spCardTitle}>{title}</Text>
            {sub ? <Text style={styles.spCardSummary} numberOfLines={1}>{sub}</Text> : null}
          </View>
          <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={18} color={t.textMuted} />
        </TouchableOpacity>
        {isOpen ? <View style={styles.spCardBody}>{children}</View> : null}
      </View>
    )
  }

  // One-line value summaries shown on each card header (read state without opening).
  const modeLabel = MODES.find((m) => m.v === mode)?.label || mode
  const preset = providers.find((p) => p.id === provider)
  const providerName = provider === "" ? "Built-in (Claude)" : preset?.name || "Custom"
  const behaviourSummary = provider === "" ? `${modeLabel} · Built-in` : `${modeLabel} · ${providerName} · ${convMode === "agent" ? "Agent" : "Chat"}`
  // The model a run will ACTUALLY use: the preset's own model when one is set
  // (exactly what the runner injects), else the device-wide composer default.
  // Never the provider's name — that was the old punting label.
  const modelSummary = provider === ""
    ? (MODELS.find((m) => m.v === model)?.label || "Default model")
    : (preset?.model || "Set on the provider")

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{ paddingBottom: 48 }}
      keyboardShouldPersistTaps="handled"
      // Pad the scroll content by the keyboard height and scroll the focused
      // TextInput into view, so an open keyboard never overlaps the System
      // Prompt / Goal / Job / provider inputs near the bottom of the page.
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="interactive"
    >
      {/* Identity: big avatar + editable name. */}
      <View style={styles.spHeader}>
        <Avatar avatar={avatar} seed={seed} size={92} />
        <TextInput
          testID="sp-title"
          style={[styles.spTitleInput, { color: t.text, borderColor: t.border }]}
          value={title}
          onChangeText={setTitle}
          onBlur={saveTitle}
          placeholder="Session name"
          placeholderTextColor={t.textMuted}
          returnKeyType="done"
          onSubmitEditing={saveTitle}
        />
        {saved === "title" ? <Text style={styles.ssSaved}>Saved</Text> : null}
      </View>

      {/* ── BEHAVIOUR: the knobs you actually turn (open by default). ── */}
      {renderCard("behaviour", "settings", "Behaviour", behaviourSummary, <>
        <Text style={styles.sheetSection}>PERMISSION MODE</Text>
        <Text style={styles.sheetHint}>Ask prompts you per tool. Accept edits runs file changes without asking.</Text>
        {renderPill(MODES, mode, setMode, "sp-mode")}

        <Text style={styles.sheetSection}>PROVIDER</Text>
        <Text style={styles.sheetHint}>Built-in uses Claude. A custom provider routes this session to your own endpoint.</Text>
        <TouchableOpacity
          testID="sp-provider-row"
          style={styles.profileInfoRow}
          onPress={() => setProviderPickerOpen(true)}
        >
          <Icon name={provider === "" ? "sparkle" : "server"} size={18} color={t.accent} />
          <Text style={[styles.profileInfoValue, { color: t.text, flex: 1, marginLeft: 10, textAlign: "left" }]} numberOfLines={1}>
            {providerName}
          </Text>
          <Icon name="chevronRight" size={18} color={t.textMuted} />
        </TouchableOpacity>
        <ProviderPicker
          visible={providerPickerOpen}
          providers={providers}
          selected={provider}
          onSelect={pickProvider}
          onClose={() => setProviderPickerOpen(false)}
          onManage={() => navigation.navigate("Providers")}
        />

        {/* Conversation mode — only meaningful for a custom provider. */}
        {provider !== "" ? (
          <>
            <Text style={styles.sheetSection}>CONVERSATION MODE</Text>
            <Text style={styles.sheetHint}>Chat is a plain conversation. Agent runs the full harness (tools, skills, MCP) on your model.</Text>
            <View style={styles.sheetPills}>
              {(["chat", "agent"] as const).map((m) => {
                const active = convMode === m
                return (
                  <TouchableOpacity
                    key={m}
                    testID={`sp-convmode-${m}`}
                    style={[styles.sheetPill, active ? styles.sheetPillActive : null]}
                    onPress={() => pickConvMode(m)}
                  >
                    {active ? <Icon name="check" size={14} color="#fff" /> : null}
                    <Text style={[styles.sheetPillText, active ? styles.sheetPillTextActive : null]}>
                      {m === "chat" ? "Chat" : "Agent"}
                    </Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </>
        ) : null}

        <Text style={styles.sheetSection}>EFFORT LEVEL</Text>
        <Text style={styles.sheetHint}>Controls reasoning depth. Higher = deeper thinking, more tokens.</Text>
        <View style={styles.sheetPills}>
          {(["low", "medium", "high", "xhigh", "max"] as const).map((e) => {
            const active = (effort || "high") === e
            const labels: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" }
            return (
              <TouchableOpacity
                key={e}
                testID={`sp-effort-${e}`}
                style={[styles.sheetPill, active ? styles.sheetPillActive : null]}
                onPress={() => pickEffort(e)}
              >
                {active ? <Icon name="check" size={14} color="#fff" /> : null}
                <Text style={[styles.sheetPillText, active ? styles.sheetPillTextActive : null]}>
                  {labels[e]}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>

      </>)}

      {/* ── GIT: repo · branch · ahead/behind + Sync (only when cwd is a repo). ── */}
      {git?.repo ? renderCard("git", "fork", "Git",
        `${git.name || "repo"} · ${git.branch || "?"}`,
        <>
          <View style={styles.ssRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.ssRowLabel}>{git.name || "repo"}</Text>
              <Text style={styles.ssRowHint} numberOfLines={1}>{git.branch || "?"}{git.remote ? ` · ${git.remote}` : ""}</Text>
            </View>
            <TouchableOpacity testID="sp-git-refresh" onPress={() => loadGit(cwd)} hitSlop={8}>
              <Icon name="repeat" size={16} color={t.textMuted} />
            </TouchableOpacity>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
            {(git.dirty ?? 0) > 0 ? (
              <Text style={{ color: "#d97706", fontSize: 12 }}>{git.dirty} change{git.dirty === 1 ? "" : "s"}</Text>
            ) : null}
            {git.ahead != null && git.ahead > 0 ? <Text style={{ color: t.textMuted, fontSize: 12 }}>↑{git.ahead}</Text> : null}
            {git.behind != null && git.behind > 0 ? <Text style={{ color: t.textMuted, fontSize: 12 }}>↓{git.behind}</Text> : null}
            {(git.dirty ?? 0) === 0 && !git.ahead && !git.behind ? <Text style={{ color: t.textMuted, fontSize: 12 }}>Up to date</Text> : null}
          </View>
          <TouchableOpacity
            testID="sp-git-sync"
            disabled={syncing}
            onPress={doSync}
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 12, backgroundColor: t.accent, borderRadius: 8, paddingVertical: 10, opacity: syncing ? 0.6 : 1 }}
          >
            <Icon name="repeat" size={15} color="#fff" />
            <Text style={{ color: "#fff", fontWeight: "600" }}>{syncing ? "Syncing…" : "Sync branch"}</Text>
          </TouchableOpacity>
          <Text style={[styles.sheetHint, { marginTop: 8 }]}>Asks the agent to commit, push, and safely rebase this branch onto the default branch.</Text>
        </>) : null}

      {/* ── CAPABILITIES: skills + MCP tools for this session's cwd (read-only
          mirror; tap opens the full editor). Answers "what can THIS session
          actually do" without leaving its home page. ── */}
      {renderCard("capabilities", "tool", "Skills & tools",
        caps ? `${caps.skills.length} skill${caps.skills.length === 1 ? "" : "s"} · ${caps.mcp.length} MCP` : "Loading…",
        <>
          {cwd ? (
            <View style={styles.ssRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.ssRowLabel}>Working dir</Text>
                <Text style={styles.ssRowHint} numberOfLines={1}>{cwd}</Text>
              </View>
            </View>
          ) : null}
          {caps && caps.skills.length ? (
            <>
              <Text style={styles.sheetSection}>SKILLS</Text>
              {caps.skills.slice(0, 8).map((s) => (
                <View key={s.path} style={styles.ssLoopRow}>
                  <Icon name="sparkle" size={14} color={t.accent} />
                  <Text style={[styles.ssLoopPrompt, { color: t.text, flex: 1 }]} numberOfLines={1}>/{s.name}</Text>
                  <Text style={[styles.capBadge, { color: t.textMuted, borderColor: t.border }]}>{s.source}</Text>
                </View>
              ))}
              {caps.skills.length > 8 ? (
                <Text style={styles.sheetHint}>+{caps.skills.length - 8} more</Text>
              ) : null}
            </>
          ) : null}
          {caps && caps.mcp.length ? (
            <>
              <Text style={styles.sheetSection}>MCP TOOLS</Text>
              {caps.mcp.slice(0, 8).map((m) => (
                <View key={`${m.scope}:${m.name}`} style={styles.ssLoopRow}>
                  <Icon name="tool" size={14} color={t.textMuted} />
                  <Text style={[styles.ssLoopPrompt, { color: t.text, flex: 1 }]} numberOfLines={1}>{m.name}</Text>
                  <Text style={[styles.capBadge, { color: t.textMuted, borderColor: t.border }]}>{m.scope}</Text>
                </View>
              ))}
              {caps.mcp.length > 8 ? (
                <Text style={styles.sheetHint}>+{caps.mcp.length - 8} more</Text>
              ) : null}
            </>
          ) : null}
          {caps && !caps.skills.length && !caps.mcp.length ? (
            <Text style={styles.sheetHint}>No skills or MCP tools resolved for this working dir.</Text>
          ) : null}
          <TouchableOpacity
            testID="sp-capabilities-manage"
            onPress={() => navigation.navigate("Capabilities", { host, cwd, title })}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12 }}
          >
            <Icon name="settings" size={15} color={t.accent} />
            <Text style={{ color: t.accent, fontWeight: "600" }}>Manage skills & tools</Text>
          </TouchableOpacity>
        </>)}

      {/* ── MODEL & alerts (open by default). ── */}
      {renderCard("model", "sparkle", "Model & alerts", modelSummary, <>
        {provider === "" ? (
          <>
            <Text style={styles.sheetSection}>DEFAULT MODEL</Text>
            <Text style={styles.sheetHint}>No provider on this session — it runs on your Claude login. The pick below is the device-wide default used by all sessions without a provider.</Text>
            {renderPill(MODELS, model, setModel, "sp-model")}
          </>
        ) : (
          <Text style={[styles.sheetHint, { marginTop: 12 }]}>
            {convMode === "agent" ? "Agent" : "Chat"} mode on {providerName}. This session runs model {preset?.model || "(set on the provider)"} — change it by editing the provider.
          </Text>
        )}
        <View style={styles.ssRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.ssRowLabel}>Notify every reply</Text>
            <Text style={styles.ssRowHint}>Get a notification each time the agent finishes a turn.</Text>
          </View>
          <Switch
            testID="sp-notify"
            value={notify}
            onValueChange={toggleNotify}
            trackColor={{ true: t.accent, false: t.border }}
          />
        </View>
      </>)}

      {/* ── PERSONA: system prompt + goal (collapsed — set once, revisited rarely). ── */}
      {renderCard("persona", "user", "Persona & goal", systemPrompt || goal ? "Custom instructions set" : "Default behaviour", <>
        <Text style={styles.sheetSection}>
          SYSTEM PROMPT {saved === "systemPrompt" ? <Text style={styles.ssSaved}>· Saved</Text> : null}
        </Text>
        <TextInput
          testID="sp-system-prompt"
          style={[styles.ssInput, styles.ssMultiline]}
          value={systemPrompt}
          onChangeText={setSystemPrompt}
          onBlur={() => saveMeta("systemPrompt", systemPrompt)}
          placeholder="Add instructions for this session…"
          placeholderTextColor={t.textMuted}
          multiline
        />
        <Text style={styles.sheetSection}>
          GOAL {saved === "goal" ? <Text style={styles.ssSaved}>· Saved</Text> : null}
        </Text>
        <TextInput
          testID="sp-goal"
          style={styles.ssInput}
          value={goal}
          onChangeText={setGoal}
          onBlur={() => saveMeta("goal", goal)}
          placeholder="What is this session for?"
          placeholderTextColor={t.textMuted}
        />
      </>)}

      {/* ── AUTOMATION: scheduled jobs (collapsed). ── */}
      {renderCard("automation", "repeat", "Scheduled jobs", jobs.length ? `${jobs.length} active` : "None", <>
        {jobs.map((j) => {
          const paused = j.enabled === false
          return (
          <View key={j.id}>
            <TouchableOpacity
              style={[styles.ssJobRow, editingJobId === j.id ? { backgroundColor: t.accent + "10", borderRadius: 8 } : null]}
              activeOpacity={0.65}
              onPress={() => setEditingJobId(editingJobId === j.id ? null : j.id)}
            >
              <View style={{ flex: 1, opacity: paused ? 0.5 : 1 }}>
                <Text style={styles.ssJobPrompt} numberOfLines={2}>{j.prompt}</Text>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 2 }}>
                  <Text style={styles.ssJobSchedule}>{describeSchedule(j)}</Text>
                  {j.provider ? (
                    <Text style={styles.ssJobSchedule}>· {providers.find((p) => p.id === j.provider)?.name || "Custom"}</Text>
                  ) : null}
                  {paused ? (
                    <Text style={styles.ssJobNext}>Paused</Text>
                  ) : j.nextRun ? (
                    <Text style={styles.ssJobNext}>Next: {fmtNextRun(j.nextRun)}</Text>
                  ) : null}
                </View>
              </View>
              <TouchableOpacity
                testID={`sp-job-toggle-${j.id}`}
                onPress={() => toggleJob(j)}
                hitSlop={8}
              >
                <Icon name={paused ? "play" : "pause"} size={15} color={paused ? t.accent : t.textMuted} />
              </TouchableOpacity>
              <TouchableOpacity testID={`sp-job-del-${j.id}`} onPress={() => removeJob(j.id)}>
                <Icon name="trash" size={15} color={t.danger} />
              </TouchableOpacity>
            </TouchableOpacity>
            {editingJobId === j.id ? (
              <JobScheduler
                styles={styles}
                providers={providers}
                initialValues={{ prompt: j.prompt, cron: j.cron, interval: j.interval, provider: j.provider }}
                onCancel={() => setEditingJobId(null)}
                onSubmit={(prompt, schedule) => editJob(j.id, prompt, schedule)}
              />
            ) : null}
          </View>
          )
        })}
        <JobScheduler onSubmit={addJob} styles={styles} providers={providers} />
      </>)}

      {/* ── PINNED messages (collapsed; only shown when present). ── */}
      {pinnedItems.length ? (
        renderCard("pinned", "pin", "Pinned messages", `${pinnedItems.length} pinned`, <>
          {pinnedItems.map((p) => (
            <View key={p.uuid} style={styles.ssLoopRow}>
              <Icon name="pin" size={14} color={t.accent} />
              <TouchableOpacity style={{ flex: 1 }} testID={`sp-pinned-${p.uuid}`} onPress={() => openPinned(p.uuid)}>
                <Text style={[styles.ssLoopPrompt, { color: t.text }]} numberOfLines={2}>{p.text || "(no text)"}</Text>
              </TouchableOpacity>
              <TouchableOpacity testID={`sp-pinned-del-${p.uuid}`} onPress={() => unpin(p.uuid)}>
                <Icon name="close" size={15} color={t.textMuted} />
              </TouchableOpacity>
            </View>
          ))}
        </>)
      ) : null}

      {/* ── APPEARANCE: avatar picker (collapsed — cosmetic). ── */}
      {renderCard("appearance", "star", "Appearance", avatar ? "Custom avatar" : "Auto avatar", <>
        <View style={styles.spAvatarGrid}>
          {AVATARS.map((a) => {
            const on = (avatar || avatarGlyph(avatar, seed)) === a && !!avatar
            return (
              <TouchableOpacity
                key={a}
                testID={`sp-avatar-${a}`}
                onPress={() => pickAvatar(a)}
                style={[styles.spAvatarCell, on ? { borderColor: t.accent, backgroundColor: t.accent + "1A" } : { borderColor: t.border }]}
              >
                <Text style={{ fontSize: 24 }}>{a}</Text>
              </TouchableOpacity>
            )
          })}
        </View>
      </>)}

      {/* ── STATS: read-only (collapsed). ── */}
      {summary ? (
        renderCard("stats", "info", "Stats", `${compactNumber(summary.userMessages + summary.assistantMessages)} messages`, <>
          <View style={styles.statGrid}>
            <Stat label="Messages" value={compactNumber(summary.userMessages + summary.assistantMessages)} t={t} />
            <Stat label="You" value={compactNumber(summary.userMessages)} t={t} />
            <Stat label="Agent" value={compactNumber(summary.assistantMessages)} t={t} />
            <Stat label="Tokens in" value={compactNumber(summary.totalInput)} t={t} />
            <Stat label="Tokens out" value={compactNumber(summary.totalOutput)} t={t} />
            {dur ? <Stat label="Duration" value={dur} t={t} /> : null}
          </View>
          {summary.models?.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 16, marginTop: 4 }}>
              {summary.models.map((m) => (
                <View key={m} style={[styles.pill, { backgroundColor: t.chipBg, marginLeft: 0 }]}>
                  <Text style={[styles.pillText, { color: t.text }]}>{shortModel(m)}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {tools.length ? (
            <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
              {tools.map((tool) => (
                <View key={tool.name} style={styles.toolBarRow}>
                  <Text style={[styles.toolBarName, { color: t.text }]} numberOfLines={1}>{tool.name}</Text>
                  <View style={[styles.toolBarTrack, { backgroundColor: t.chipBg }]}>
                    <View style={[styles.toolBarFill, { width: `${Math.max(4, (tool.count / maxTool) * 100)}%` }]} />
                  </View>
                  <Text style={[styles.toolBarCount, { color: t.textMuted }]}>{tool.count}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </>)
      ) : path ? (
        <View style={{ padding: 16 }}>
          <ActivityIndicator size="small" color={t.textMuted} />
        </View>
      ) : null}
    </ScrollView>
  )
}

function Stat({ label, value, t }: { label: string; value: string; t: { text: string; textMuted: string; chipBg: string } }) {
  const styles = useStyles()
  return (
    <View style={[styles.statCard, { backgroundColor: t.chipBg }]}>
      <Text style={[styles.statValue, { color: t.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: t.textMuted }]}>{label}</Text>
    </View>
  )
}
