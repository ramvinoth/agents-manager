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
import { api, type Loop, type SessionSummary } from "../api/client"
import { AVATARS, avatarGlyph } from "../lib/avatars"
import { fmtInterval, parseInterval } from "../lib/interval"
import { compactNumber, durationBetween, shortModel, topTools } from "../lib/stats"
import { groupThread, itemPreview, itemUuid, parseTranscript, type ThreadItem } from "../lib/thread"
import { composerPrefs, notifyEveryReply, setComposerPrefs, setNotifyEveryReply } from "../state/config"
import { useTheme } from "../lib/useTheme"
import Avatar from "../components/Avatar"
import Icon from "../components/Icon"
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
 * scheduled loops, notify) plus its read-only stats. Mode/model persist via the
 * global composerPrefs; the rest via /api/session-meta and /api/loops.
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
  const [loops, setLoops] = useState<Loop[]>([])
  const [loopPrompt, setLoopPrompt] = useState("")
  const [loopInterval, setLoopInterval] = useState("1h")
  const [notify, setNotify] = useState(notifyEveryReply())
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  // Pinned messages: uuids from session meta, resolved to preview text by parsing
  // the transcript. Tapping one navigates back to the thread and jumps to it.
  const [pinned, setPinned] = useState<string[]>([])
  const [pinnedItems, setPinnedItems] = useState<{ uuid: string; text: string }[]>([])

  // Load meta + loops + stats once. A missing session (fresh chat with no path
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
        })
        .catch(() => {})
      api.sessionSummary(host, path).then(setSummary).catch(() => {})
    }
    if (sessionId) api.loops(sessionId).then((l) => Array.isArray(l) && setLoops(l)).catch(() => {})
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

  function addLoop() {
    const prompt = loopPrompt.trim()
    if (!prompt || !sessionId) return
    api
      .loopsCreate({ session: sessionId, prompt, interval: parseInterval(loopInterval) })
      .then(() => api.loops(sessionId))
      .then((l) => Array.isArray(l) && setLoops(l))
      .catch(() => {})
    setLoopPrompt("")
  }

  function removeLoop(id: string) {
    setLoops((all) => all.filter((l) => l.id !== id)) // optimistic
    api.loopsDelete(id).catch(() => {})
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

  const PillRow = ({ opts, value, onPick, testPrefix }: { opts: { v: string; label: string }[]; value: string; onPick: (v: string) => void; testPrefix: string }) => (
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

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{ paddingBottom: 48 }}
      keyboardShouldPersistTaps="handled"
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

      {/* Avatar picker: 20 emoji in a wrapping grid. */}
      <Text style={styles.sheetSection}>AVATAR</Text>
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

      {/* Pinned messages: tap to jump back into the thread at that message. */}
      {pinnedItems.length ? (
        <>
          <Text style={styles.sheetSection}>PINNED MESSAGES</Text>
          {pinnedItems.map((p) => (
            <View key={p.uuid} style={styles.ssLoopRow}>
              <Icon name="pin" size={14} color={t.accent} />
              <TouchableOpacity style={{ flex: 1 }} testID={`sp-pinned-${p.uuid}`} onPress={() => openPinned(p.uuid)}>
                <Text style={[styles.ssLoopPrompt, { color: t.text }]} numberOfLines={2}>
                  {p.text || "(no text)"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity testID={`sp-pinned-del-${p.uuid}`} onPress={() => unpin(p.uuid)}>
                <Icon name="close" size={15} color={t.textMuted} />
              </TouchableOpacity>
            </View>
          ))}
        </>
      ) : null}

      {/* Per-message controls (moved out of the composer gear). */}
      <Text style={styles.sheetSection}>PERMISSION MODE</Text>
      <Text style={styles.sheetHint}>Ask prompts you per tool. Accept edits runs file changes without asking.</Text>
      <PillRow opts={MODES} value={mode} onPick={setMode} testPrefix="sp-mode" />

      <Text style={styles.sheetSection}>MODEL</Text>
      <PillRow opts={MODELS} value={model} onPick={setModel} testPrefix="sp-model" />

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

      <Text style={styles.sheetSection}>LOOPS</Text>
      {loops.map((l) => (
        <View key={l.id} style={styles.ssLoopRow}>
          <Icon name="repeat" size={14} color={t.textMuted} />
          <Text style={styles.ssLoopPrompt} numberOfLines={1}>
            {l.prompt}
          </Text>
          <Text style={styles.ssLoopInterval}>{fmtInterval(l.interval)}</Text>
          <TouchableOpacity testID={`sp-loop-del-${l.id}`} onPress={() => removeLoop(l.id)}>
            <Icon name="trash" size={15} color={t.danger} />
          </TouchableOpacity>
        </View>
      ))}
      <TextInput
        testID="sp-loop-prompt"
        style={[styles.ssInput, styles.ssMultiline]}
        value={loopPrompt}
        onChangeText={setLoopPrompt}
        placeholder="Prompt to run on a schedule…"
        placeholderTextColor={t.textMuted}
        multiline
      />
      <View style={styles.ssLoopAddRow}>
        <Text style={{ color: t.textMuted, fontSize: 12 }}>Every</Text>
        <TextInput
          testID="sp-loop-interval"
          style={styles.ssLoopIntervalInput}
          value={loopInterval}
          onChangeText={setLoopInterval}
          placeholder="1h"
          placeholderTextColor={t.textMuted}
          autoCapitalize="none"
        />
        <TouchableOpacity
          testID="sp-loop-add"
          style={[styles.ssAddBtn, { opacity: loopPrompt.trim() ? 1 : 0.5 }]}
          disabled={!loopPrompt.trim()}
          onPress={addLoop}
        >
          <Text style={styles.ssAddBtnText}>Add loop</Text>
        </TouchableOpacity>
      </View>

      {/* Read-only stats (formerly the separate Session info screen). */}
      {summary ? (
        <>
          <Text style={styles.sheetSection}>STATS</Text>
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
                  <Text style={[styles.toolBarName, { color: t.text }]} numberOfLines={1}>
                    {tool.name}
                  </Text>
                  <View style={[styles.toolBarTrack, { backgroundColor: t.chipBg }]}>
                    <View style={[styles.toolBarFill, { width: `${Math.max(4, (tool.count / maxTool) * 100)}%` }]} />
                  </View>
                  <Text style={[styles.toolBarCount, { color: t.textMuted }]}>{tool.count}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </>
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
