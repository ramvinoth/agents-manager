import React, { useEffect, useRef, useState } from "react"
import { offerUndo } from "../lib/undo"
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Capabilities, type GitStatus, type OrgLevel, type Job, type PermissionMode, type Provider, type SessionSummary } from "../api/client"
import { ORG_LEVELS, LEVEL_NAME, isOrgLevel } from "../lib/orgLevel"
import { aiError, aiSummary, type AIConfig } from "../lib/aiSelection"
import { AVATARS, avatarGlyph } from "../lib/avatars"
import { describeSchedule, fmtNextRun } from "../lib/interval"
import { compactNumber, durationBetween, shortModel, topTools } from "../lib/stats"
import { groupThread, itemPreview, itemUuid, parseTranscript, type ThreadItem } from "../lib/thread"
import { notifyEveryReply, setNotifyEveryReply } from "../state/config"
import { useTheme } from "../lib/useTheme"
import Avatar from "../components/Avatar"
import Icon from "../components/Icon"
import JobScheduler, { type JobSchedule } from "../components/JobScheduler"
import ProviderPicker from "../components/ProviderPicker"
import { useStyles } from "../lib/styles"

type Props = NativeStackScreenProps<RootStackParamList, "SessionProfile">

const MODES: { v: PermissionMode; label: string }[] = [
  { v: "acceptEdits", label: "Accept edits" },
  { v: "default", label: "Ask" },
  { v: "plan", label: "Plan" },
  { v: "bypass", label: "Bypass" },
]
// "" = no per-chat override: the level of the agent the chat was started from.
const LEVELS: { v: OrgLevel | ""; label: string }[] = [
  { v: "", label: "Agent default" },
  ...ORG_LEVELS.map((v) => ({ v, label: LEVEL_NAME[v] })),
]
export default function SessionProfileScreen({ route, navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const { host, path, sessionId, agent = "claude" } = route.params
  // A stable, always-defined key for the avatar's default glyph + colour.
  const seed = sessionId || path || "session"

  const [avatar, setAvatar] = useState("")
  const [title, setTitle] = useState(route.params.label || "")
  const [systemPrompt, setSystemPrompt] = useState("")
  const [goal, setGoal] = useState("")
  const [saved, setSaved] = useState<"systemPrompt" | "goal" | "title" | null>(null)
  const [mode, setModeState] = useState("")
  const [modeTarget, setModeTarget] = useState("")
  const [modeLoading, setModeLoading] = useState(true)
  const [modeSaving, setModeSaving] = useState(false)
  const [modeError, setModeError] = useState("")
  const [modeReload, setModeReload] = useState(0)
  // Manager level: the override stored on the session ("" = none) and the level
  // that actually applies (override → the agent it was started from → Own work), both from sessionMeta.
  const [level, setLevel] = useState<OrgLevel | "">("")
  const [effectiveLevel, setEffectiveLevel] = useState<OrgLevel | "">("")
  const [levelSaving, setLevelSaving] = useState(false)
  const [levelNote, setLevelNote] = useState("")
  const modeRequest = useRef({ active: false, saving: false })
  useEffect(() => {
    const request = { active: true, saving: false }
    modeRequest.current = request
    setModeState(""); setModeTarget(""); setModeError(""); setModeSaving(false)
    setLevel(""); setEffectiveLevel(""); setLevelNote("")
    const claude = agent === "claude"
    setModeLoading(claude && !!path)
    if (path) {
      // ONE cheap read feeds the profile fields and Trust. session-meta, not
      // session-detail: the detail also summarises the whole transcript
      // (seconds on a big chat). A Trust retry re-reads it, which is harmless.
      api.sessionMeta(host, path).then(meta => {
        if (!request.active) return
        setSystemPrompt(meta.systemPrompt || "")
        setGoal(meta.goal || "")
        if (meta.avatar) setAvatar(meta.avatar)
        setPinned(Array.isArray(meta.pinned) ? meta.pinned : [])
        if (meta.cwd) { setCwd(meta.cwd); loadGit(meta.cwd) }
        // Skills + MCP tools resolve from the working dir (host-aware).
        api.capabilities(host, meta.cwd || undefined, path).then(setCaps).catch(() => setCaps({ skills: [], mcp: [] }))
        if (!claude) return
        if (!meta.session || typeof meta.permission_mode !== "string") {
          throw new Error("Server did not return the session permission policy.")
        }
        const stored = meta.permission_mode
        if (stored && !MODES.some(m => m.v === stored)) {
          throw new Error("Unrecognized server permission policy. Update the app before changing it.")
        }
        setModeTarget(meta.session)
        setModeState(stored)
        setLevel(isOrgLevel(meta.level) ? meta.level : "")
        setEffectiveLevel(isOrgLevel(meta.effective_level) ? meta.effective_level : "")
      }).catch(e => {
        if (request.active && claude) setModeError(e?.message || "Could not load permission policy. Please retry.")
      }).finally(() => { if (request.active) setModeLoading(false) })
    }
    return () => { request.active = false }
  }, [host, path, sessionId, agent, modeReload])
  const [jobs, setJobs] = useState<Job[]>([])
  const [notify, setNotify] = useState(notifyEveryReply())
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  // Pinned messages: uuids from session meta, resolved to preview text by parsing
  // the transcript. Tapping one navigates back to the thread and jumps to it.
  const [pinned, setPinned] = useState<string[]>([])
  const [pinnedItems, setPinnedItems] = useState<{ uuid: string; text: string }[]>([])

  const [providers, setProviders] = useState<Provider[]>([])
  const [aiConfig, setAIConfig] = useState<AIConfig | null>(null)
  const [aiErrorText, setAIErrorText] = useState("")
  const [providerPickerOpen, setProviderPickerOpen] = useState(false)
  const aiScope = { id: sessionId || path, host, agent }
  useEffect(() => {
    let alive = true
    setAIConfig(null)
    if (!aiScope.id) { setAIErrorText("Session must exist before editing AI settings."); return }
    api.aiConfig(aiScope).then(config => {
      if (!config.capabilities || !config.selection) throw new Error("Server update required for AI settings.")
      if (alive) { setAIConfig(config); setAIErrorText("") }
    }).catch(e => { if (alive) setAIErrorText(aiError(e)) })
    return () => { alive = false }
  }, [sessionId, path, host, agent])
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

  // Load jobs + stats once (meta loads with Trust above). A missing session
  // (fresh chat with no path yet) simply shows empty fields — everything still
  // saves once it exists.
  useEffect(() => {
    if (path) {
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

  const setMode = async (v: PermissionMode) => {
    const request = modeRequest.current
    if (!request.active || request.saving || !modeTarget || modeLoading || v === mode) return
    request.saving = true
    setModeSaving(true); setModeError("")
    try {
      const result = await api.sessionModeSet(modeTarget, v)
      if (!request.active) return
      if (result.error || result.denied || result.queued) {
        throw new Error(result.error || result.reason || (result.queued
          ? "Change queued for owner approval; the saved policy has not changed."
          : "Permission policy change was denied."))
      }
      if (result.session !== modeTarget || result.permission_mode !== v) {
        throw new Error("Server did not confirm the permission policy. Reload before retrying.")
      }
      setModeState(v)
    } catch (e) {
      if (request.active) setModeError(e instanceof Error ? e.message : "Could not save permission policy. Please retry.")
    } finally {
      request.saving = false
      if (request.active) setModeSaving(false)
    }
  }
  const pickLevel = async (v: OrgLevel | "") => {
    const request = modeRequest.current
    if (!request.active || levelSaving || !modeTarget || modeLoading || v === level) return
    setLevelSaving(true); setLevelNote("")
    try {
      const result = await api.sessionLevelSet(modeTarget, v)
      if (!request.active) return
      if (result.queued) { setLevelNote("Sent to the owner for approval; the level has not changed yet."); return }
      if (result.error || result.denied || result.session !== modeTarget) {
        throw new Error(result.error || result.reason || "Server did not confirm the level. Reload before retrying.")
      }
      setModeReload(n => n + 1) // re-read the effective level the server now resolves
    } catch (e) {
      if (request.active) setLevelNote(e instanceof Error ? e.message : "Could not save the level. Please retry.")
    } finally {
      if (request.active) setLevelSaving(false)
    }
  }
  function addJob(prompt: string, schedule: JobSchedule) {
    if (!sessionId) return
    api
      .loopsCreate({ session: path || sessionId, prompt, ...schedule })
      .then(() => api.loops(sessionId))
      .then((l) => Array.isArray(l) && setJobs(l))
      .catch(() => {})
    setJobSheet(null)
  }

  function removeJob(id: string) {
    Alert.alert(
      "Delete this scheduled job?",
      "It stops at its next scheduled run and won't come back. This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            setJobs((all) => all.filter((j) => j.id !== id)) // optimistic
            api.loopsDelete(id).catch(() => {})
          },
        },
      ],
    )
  }

  // The job sheet: null = closed, "new" = add, else the id of the job being edited.
  const [jobSheet, setJobSheet] = useState<string | null>(null)
  const editingJob = jobs.find((j) => j.id === jobSheet)
  // Edit: update the job via API, then refresh the list.
  function editJob(id: string, prompt: string, schedule: JobSchedule) {
    api
      .loopsEdit({ id, prompt, ...schedule })
      .then(() => sessionId ? api.loops(sessionId) : [])
      .then((l) => { if (Array.isArray(l)) setJobs(l) })
      .catch(() => {})
    setJobSheet(null)
  }

  // Pause/resume: flip the loop's enabled flag at once (optimistic + refresh),
  // with an Undo toast instead of a confirm — it's a flip either way. A
  // paused loop stops firing (server filters enabled=TRUE); resuming leaves its
  // nextRun untouched, so an overdue loop fires at most once, not a backlog.
  function toggleJob(j: Job) {
    const set = (enabled: boolean) => {
      setJobs((all) => all.map((x) => (x.id === j.id ? { ...x, enabled } : x)))
      api.loopsEdit({ id: j.id, enabled })
        .then(() => sessionId ? api.loops(sessionId) : [])
        .then((l) => { if (Array.isArray(l)) setJobs(l) })
        .catch(() => {})
    }
    const next = j.enabled === false
    set(next)
    offerUndo({ label: next ? "Job resumed" : "Job paused", undo: () => set(!next) })
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
  const renderPill = <V extends string>(opts: { v: V; label: string }[], value: string, onPick: (v: V) => void, testPrefix: string, what: string, busy: boolean) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sheetPills}>
      {opts.map((m) => {
        const active = value === m.v
        return (
          <TouchableOpacity
            key={m.v || "default"}
            testID={`${testPrefix}-${m.v || "default"}`}
            disabled={modeLoading || busy || !modeTarget}
            accessibilityRole="button"
            accessibilityLabel={`${m.label} ${what} for future runs`}
            accessibilityState={{ selected: active, disabled: modeLoading || busy || !modeTarget }}
            style={[styles.sheetPill, { minHeight: 44 }, active ? styles.sheetPillActive : null]}
            onPress={() => onPick(m.v)}
          >
            {active ? <Icon name="check" size={14} color={t.onAccent} /> : null}
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
          <View style={styles.flex1}>
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
  const modeLabel = modeLoading ? "Loading…" : MODES.find((m) => m.v === mode)?.label || (modeTarget ? "No saved policy" : "Unavailable")
  const trustLabel = effectiveLevel && !modeLoading ? `${modeLabel} · ${LEVEL_NAME[effectiveLevel]}` : modeLabel

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.spContent}
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
          style={styles.spTitleInput}
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

      <TouchableOpacity testID="sp-ai-row" style={styles.spCard} onPress={() => setProviderPickerOpen(true)} disabled={!aiConfig?.capabilities.editable}>
        <View style={styles.spAiBody}>
          <Text style={styles.spCardTitle}>AI for this chat</Text>
          <Text style={[styles.sheetHint, styles.spHintGap]}>{aiConfig ? aiSummary(aiConfig.selection, providers) : aiErrorText || "Loading AI settings…"}</Text>
          <Text style={styles.sheetHint}>Changes apply to future runs, not a response already in progress.</Text>
          {aiConfig?.issue ? <Text style={styles.sheetHint}>{aiConfig.issue}</Text> : null}
        </View>
      </TouchableOpacity>
      {providerPickerOpen && aiConfig ? <ProviderPicker config={aiConfig} scope={aiScope} providers={providers} title="AI for this chat" onSave={setAIConfig} onClose={() => setProviderPickerOpen(false)}/> : null}
      {agent === "claude" ? renderCard("behaviour", "settings", "Trust", trustLabel, <>
        <Text style={styles.sheetSection}>PERMISSION POLICY · CLAUDE CODE TOOLS</Text>
        <Text style={styles.sheetHint}>Saved on the server for future chat and scheduled runs, across devices. Does not change a run already in progress.</Text>
        <Text style={styles.sheetHint}>Ask follows configured tool rules. Accept edits allows file edits. Plan restricts changes. Bypass skips ordinary tool prompts; explicit restrictions and human decisions still apply. This governs the harness's own tools (shell, file edits) only; the Manager level below is separate.</Text>
        {!mode && modeTarget ? <Text style={styles.sheetHint}>No saved policy. Each launch uses its requested mode; scheduled runs request Accept edits.</Text> : null}
        {!sessionId && !path ? <Text style={styles.sheetHint}>Start the chat before setting its permission policy.</Text> : null}
        {renderPill(MODES, mode, setMode, "sp-mode", "permission policy", modeSaving)}
        {modeLoading || modeSaving ? <Text style={styles.sheetHint}>{modeSaving ? "Saving…" : "Loading policy…"}</Text> : null}
        {modeError ? <>
          <Text testID="sp-mode-error" accessibilityRole="alert" style={styles.sheetHint}>{modeError}</Text>
          <TouchableOpacity testID="sp-mode-retry" accessibilityRole="button" disabled={modeLoading || modeSaving} onPress={() => setModeReload(n => n + 1)} style={styles.spRetry}>
            <Text style={styles.spLink}>Reload policy</Text>
          </TouchableOpacity>
        </> : null}
        <Text style={[styles.sheetSection, styles.spSectionGap]}>BOARD AUTHORITY · HOW FAR IT ACTS ALONE</Text>
        <Text style={styles.sheetHint}>How far this chat may reach with no approval from you, enforced by the Manager server for any harness. Own work — its own cards, notes and messages. Workspace — also projects, columns and scheduled loops. Organization — also org-wide settings. Asks above its level wait for your approval instead of failing, and anything destructive or paid always asks you, whatever the level.</Text>
        {renderPill(LEVELS, level, pickLevel, "sp-level", "Board authority", levelSaving)}
        {effectiveLevel ? <Text testID="sp-level-effective" style={styles.sheetHint}>Acting at {LEVEL_NAME[effectiveLevel]}{level ? " (set for this chat)" : " (from the agent it was started from)"}. Applies from the next run.</Text> : null}
        {levelSaving ? <Text style={styles.sheetHint}>Saving…</Text> : null}
        {levelNote ? <Text testID="sp-level-note" accessibilityRole="alert" style={styles.sheetHint}>{levelNote}</Text> : null}
      </>) : null}

      {/* ── GIT: repo · branch · ahead/behind + Sync (only when cwd is a repo). ── */}
      {git?.repo ? renderCard("git", "fork", "Git",
        `${git.name || "repo"} · ${git.branch || "?"}`,
        <>
          <View style={styles.ssRow}>
            <View style={styles.flex1}>
              <Text style={styles.ssRowLabel}>{git.name || "repo"}</Text>
              <Text style={styles.ssRowHint} numberOfLines={1}>{git.branch || "?"}{git.remote ? ` · ${git.remote}` : ""}</Text>
            </View>
            <TouchableOpacity testID="sp-git-refresh" onPress={() => loadGit(cwd)} hitSlop={8}>
              <Icon name="repeat" size={16} color={t.textMuted} />
            </TouchableOpacity>
          </View>
          <View style={styles.spGitStats}>
            {(git.dirty ?? 0) > 0 ? (
              <Text style={styles.spGitDirty}>{git.dirty} change{git.dirty === 1 ? "" : "s"}</Text>
            ) : null}
            {git.ahead != null && git.ahead > 0 ? <Text style={styles.spGitStat}>↑{git.ahead}</Text> : null}
            {git.behind != null && git.behind > 0 ? <Text style={styles.spGitStat}>↓{git.behind}</Text> : null}
            {(git.dirty ?? 0) === 0 && !git.ahead && !git.behind ? <Text style={styles.spGitStat}>Up to date</Text> : null}
          </View>
          <TouchableOpacity
            testID="sp-git-sync"
            disabled={syncing}
            onPress={doSync}
            style={[styles.spSyncBtn, syncing ? styles.dimmed : null]}
          >
            <Icon name="repeat" size={15} color={t.onAccent} />
            <Text style={styles.spSyncText}>{syncing ? "Syncing…" : "Sync branch"}</Text>
          </TouchableOpacity>
          <Text style={[styles.sheetHint, styles.spHintGap]}>Asks the agent to commit, push, and safely rebase this branch onto the default branch.</Text>
        </>) : null}

      {/* ── CAPABILITIES: skills + MCP tools for this session's cwd (read-only
          mirror; tap opens the full editor). Answers "what can THIS session
          actually do" without leaving its home page. ── */}
      {renderCard("capabilities", "tool", "Skills & tools",
        caps ? `${caps.skills.length} skill${caps.skills.length === 1 ? "" : "s"} · ${caps.mcp.length} MCP` : "Loading…",
        <>
          {cwd ? (
            <View style={styles.ssRow}>
              <View style={styles.flex1}>
                <Text style={styles.ssRowLabel}>Working dir</Text>
                <Text style={styles.ssRowHint} numberOfLines={1}>{cwd}</Text>
              </View>
            </View>
          ) : null}
          {caps && caps.skills.length ? (
            <>
              <Text style={styles.sheetSection}>SKILLS</Text>
              {caps.skills.slice(0, 8).map((s) => (
                <View key={s.path} style={styles.ssListRow}>
                  <Icon name="sparkle" size={14} color={t.accent} />
                  <Text style={styles.ssListText} numberOfLines={1}>/{s.name}</Text>
                  <Text style={styles.capBadge}>{s.source}</Text>
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
                <View key={`${m.scope}:${m.name}`} style={styles.ssListRow}>
                  <Icon name="tool" size={14} color={t.textMuted} />
                  <Text style={styles.ssListText} numberOfLines={1}>{m.name}</Text>
                  <Text style={styles.capBadge}>{m.scope}</Text>
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
            onPress={() => navigation.navigate("Capabilities", { host, cwd, session: path, title })}
            style={styles.spManage}
          >
            <Icon name="settings" size={15} color={t.accent} />
            <Text style={styles.spManageText}>Manage skills & tools</Text>
          </TouchableOpacity>
        </>)}

      {renderCard("notifications", "info", "Notifications", "This device", <>
        <View style={styles.ssRow}>
          <View style={styles.flex1}>
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
              testID={`sp-job-${j.id}`}
              style={styles.ssJobRow}
              activeOpacity={0.65}
              onPress={() => setJobSheet(j.id)}
            >
              <View style={[styles.flex1, paused ? styles.faded : null]}>
                <Text style={styles.ssJobPrompt} numberOfLines={2}>{j.prompt}</Text>
                <View style={styles.spJobMeta}>
                  <Text style={styles.ssJobSchedule}>{describeSchedule(j)}</Text>
                  {j.provider ? (
                    <Text style={styles.ssJobSchedule}>· {providers.find((p) => p.id === j.provider)?.name || "Custom"}</Text>
                  ) : null}
                  {paused ? (
                    <Text style={styles.ssJobNext}>Paused</Text>
                  ) : j.nextRun && j.kind !== "once" ? (
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
          </View>
          )
        })}
        <TouchableOpacity testID="sp-job-new" style={[styles.ssAddBtn, styles.spAddJob]} onPress={() => setJobSheet("new")}>
          <Text style={styles.ssAddBtnText}>Add job</Text>
        </TouchableOpacity>
        <JobScheduler
          visible={jobSheet !== null}
          styles={styles}
          providers={providers}
          initialValues={editingJob ? { prompt: editingJob.prompt, cron: editingJob.cron, interval: editingJob.interval, kind: editingJob.kind, nextRun: editingJob.nextRun, provider: editingJob.provider } : undefined}
          onClose={() => setJobSheet(null)}
          // A job deleted while its sheet was open is dropped, never re-created.
          onSubmit={(prompt, schedule) => jobSheet === "new" ? addJob(prompt, schedule) : editingJob ? editJob(editingJob.id, prompt, schedule) : setJobSheet(null)}
        />
      </>)}

      {/* ── PINNED messages (collapsed; only shown when present). ── */}
      {pinnedItems.length ? (
        renderCard("pinned", "pin", "Pinned messages", `${pinnedItems.length} pinned`, <>
          {pinnedItems.map((p) => (
            <View key={p.uuid} style={styles.ssListRow}>
              <Icon name="pin" size={14} color={t.accent} />
              <TouchableOpacity style={styles.flex1} testID={`sp-pinned-${p.uuid}`} onPress={() => openPinned(p.uuid)}>
                <Text style={styles.ssListText} numberOfLines={2}>{p.text || "(no text)"}</Text>
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
                style={[styles.spAvatarCell, on ? styles.spAvatarCellOn : null]}
              >
                <Text style={styles.spAvatarGlyph}>{a}</Text>
              </TouchableOpacity>
            )
          })}
        </View>
      </>)}

      {/* ── STATS: read-only (collapsed). ── */}
      {summary ? (
        renderCard("stats", "info", "Stats", `${compactNumber(summary.userMessages + summary.assistantMessages)} messages`, <>
          <View style={styles.statGrid}>
            <Stat label="Messages" value={compactNumber(summary.userMessages + summary.assistantMessages)} />
            <Stat label="You" value={compactNumber(summary.userMessages)} />
            <Stat label="Agent" value={compactNumber(summary.assistantMessages)} />
            <Stat label="Tokens in" value={compactNumber(summary.totalInput)} />
            <Stat label="Tokens out" value={compactNumber(summary.totalOutput)} />
            {dur ? <Stat label="Duration" value={dur} /> : null}
          </View>
          {summary.models?.length ? (
            <View style={styles.spModels}>
              <Text style={styles.sheetHint}>Models observed in transcript (historical)</Text>
              {summary.models.map((m) => (
                <View key={m} style={[styles.pill, styles.spModelPill]}>
                  <Text style={styles.pillText}>{shortModel(m)}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {tools.length ? (
            <View style={styles.spTools}>
              {tools.map((tool) => (
                <View key={tool.name} style={styles.toolBarRow}>
                  <Text style={styles.toolBarName} numberOfLines={1}>{tool.name}</Text>
                  <View style={styles.toolBarTrack}>
                    <View style={[styles.toolBarFill, { width: `${Math.max(4, (tool.count / maxTool) * 100)}%` }]} />
                  </View>
                  <Text style={styles.toolBarCount}>{tool.count}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </>)
      ) : path ? (
        <View style={styles.spAiBody}>
          <ActivityIndicator size="small" color={t.textMuted} />
        </View>
      ) : null}
    </ScrollView>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  const styles = useStyles()
  return (
    <View style={styles.statCard}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}
