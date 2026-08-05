import React, { useEffect, useState } from "react"
import { ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from "react-native"
import { api, type Loop } from "../api/client"
import { fmtInterval, parseInterval } from "../lib/interval"
import { notifyEveryReply, setNotifyEveryReply } from "../state/config"
import { useTheme } from "../lib/useTheme"
import Icon, { type IconName } from "./Icon"
import SheetModal from "./SheetModal"
import { useStyles } from "../screens/styles"

/** The transcript-visibility filter — mirrors the web LHS "Filter transcript". */
export type VisibleTypes = { user: boolean; assistant: boolean; tools: boolean; system: boolean }
const FILTERS: { key: keyof VisibleTypes; label: string; icon: IconName }[] = [
  { key: "user", label: "You", icon: "user" },
  { key: "assistant", label: "Assistant", icon: "sparkle" },
  { key: "tools", label: "Tools", icon: "tool" },
  { key: "system", label: "System", icon: "terminal" },
]

export type Opt = { v: string; label: string }

/**
 * The chat-session settings sheet reached from the ⚙ in the thread header.
 * Brings the web UI's LHS Settings tab to mobile: the per-message permission
 * mode + model, transcript filter, per-session system prompt + goal (saved to
 * /api/session-meta), scheduled loops, plus the "notify on every reply" switch.
 * One clean bottom-sheet, themed for both modes.
 */
export default function SessionSettings({
  visible,
  onClose,
  host,
  path,
  sessionId,
  visibleTypes,
  onToggleType,
  mode,
  onMode,
  modes,
  model,
  onModel,
  models,
}: {
  visible: boolean
  onClose: () => void
  host: string
  path: string
  sessionId: string
  visibleTypes: VisibleTypes
  onToggleType: (k: keyof VisibleTypes) => void
  mode: string
  onMode: (v: string) => void
  modes: Opt[]
  model: string
  onModel: (v: string) => void
  models: Opt[]
}) {
  const styles = useStyles()
  const t = useTheme()

  // A render FUNCTION (called as {renderPill(...)}), NOT a component. Defining a
  // component inside render and using it as <PillRow/> gives it a fresh identity
  // every keystroke, remounting its subtree — which drops focus from any TextInput
  // rendered alongside (the "keyboard closes on each letter" bug).
  const renderPill = (opts: Opt[], value: string, onPick: (v: string) => void, testPrefix: string) => (
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

  const [systemPrompt, setSystemPrompt] = useState("")
  const [goal, setGoal] = useState("")
  const [saved, setSaved] = useState<"systemPrompt" | "goal" | null>(null)
  const [loops, setLoops] = useState<Loop[]>([])
  const [loopPrompt, setLoopPrompt] = useState("")
  const [loopInterval, setLoopInterval] = useState("1h")
  const [notify, setNotify] = useState(notifyEveryReply())

  // Load meta + loops each time the sheet opens (state may have changed elsewhere).
  useEffect(() => {
    if (!visible) return
    setNotify(notifyEveryReply())
    api
      .sessionMeta(host, path)
      .then((m) => {
        setSystemPrompt(m.systemPrompt || "")
        setGoal(m.goal || "")
      })
      .catch(() => {})
    if (sessionId) api.loops(sessionId).then((l) => Array.isArray(l) && setLoops(l)).catch(() => {})
  }, [visible, host, path, sessionId])

  function saveMeta(field: "systemPrompt" | "goal", value: string) {
    api.sessionMetaSave({ session: path, [field]: value, host }).catch(() => {})
    setSaved(field)
    setTimeout(() => setSaved((f) => (f === field ? null : f)), 1600)
  }

  function addLoop() {
    const prompt = loopPrompt.trim()
    if (!prompt || !sessionId) return
    const interval = parseInterval(loopInterval)
    api
      .loopsCreate({ session: sessionId, prompt, interval })
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

  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={styles.sheetGrabber} />
      <Text style={styles.sheetTitle}>Chat settings</Text>

      <ScrollView
        style={styles.ssScroll}
        contentContainerStyle={styles.ssScrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        // Keep an open keyboard from covering the System Prompt / Goal / Loop
        // inputs: pad by the keyboard height and scroll the focused field up.
        automaticallyAdjustKeyboardInsets
      >
        {/* Permission mode + model — the per-message controls that used to
            live behind a separate composer gear. */}
        <Text style={styles.sheetSection}>PERMISSION MODE</Text>
        <Text style={styles.sheetHint}>Ask prompts you per tool. Accept edits runs file changes without asking.</Text>
        {renderPill(modes, mode, onMode, "sheet-mode")}

        <Text style={styles.sheetSection}>MODEL</Text>
        {renderPill(models, model, onModel, "sheet-model")}

        {/* Notifications */}
        <View style={styles.ssRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.ssRowLabel}>Notify every reply</Text>
            <Text style={styles.ssRowHint}>Get a notification each time the agent finishes a turn.</Text>
          </View>
          <Switch
            testID="ss-notify"
            value={notify}
            onValueChange={toggleNotify}
            trackColor={{ true: t.accent, false: t.border }}
          />
        </View>

        {/* Transcript filter */}
        <Text style={styles.sheetSection}>FILTER TRANSCRIPT</Text>
        <View style={styles.ssFilterGrid}>
          {FILTERS.map((f) => {
            const on = visibleTypes[f.key]
            return (
              <TouchableOpacity
                key={f.key}
                testID={`ss-filter-${f.key}`}
                style={[styles.ssFilterChip, on ? styles.ssFilterChipOn : null]}
                onPress={() => onToggleType(f.key)}
              >
                <Icon name={f.icon} size={13} color={on ? "#fff" : t.textMuted} />
                <Text style={[styles.ssFilterText, on ? styles.ssFilterTextOn : null]}>{f.label}</Text>
              </TouchableOpacity>
            )
          })}
        </View>

        {/* System prompt */}
        <Text style={styles.sheetSection}>
          SYSTEM PROMPT {saved === "systemPrompt" ? <Text style={styles.ssSaved}>· Saved</Text> : null}
        </Text>
        <TextInput
          testID="ss-system-prompt"
          style={[styles.ssInput, styles.ssMultiline]}
          value={systemPrompt}
          onChangeText={setSystemPrompt}
          onBlur={() => saveMeta("systemPrompt", systemPrompt)}
          placeholder="Add instructions for this session…"
          placeholderTextColor={t.textMuted}
          multiline
        />

        {/* Goal */}
        <Text style={styles.sheetSection}>
          GOAL {saved === "goal" ? <Text style={styles.ssSaved}>· Saved</Text> : null}
        </Text>
        <TextInput
          testID="ss-goal"
          style={styles.ssInput}
          value={goal}
          onChangeText={setGoal}
          onBlur={() => saveMeta("goal", goal)}
          placeholder="What is this session for?"
          placeholderTextColor={t.textMuted}
        />

        {/* Loops */}
        <Text style={styles.sheetSection}>LOOPS</Text>
        {loops.map((l) => (
          <View key={l.id} style={styles.ssLoopRow}>
            <Icon name="repeat" size={14} color={t.textMuted} />
            <Text style={styles.ssLoopPrompt} numberOfLines={1}>
              {l.prompt}
            </Text>
            <Text style={styles.ssLoopInterval}>{fmtInterval(l.interval)}</Text>
            <TouchableOpacity testID={`ss-loop-del-${l.id}`} onPress={() => removeLoop(l.id)}>
              <Icon name="trash" size={15} color={t.danger} />
            </TouchableOpacity>
          </View>
        ))}
        <TextInput
          testID="ss-loop-prompt"
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
            testID="ss-loop-interval"
            style={styles.ssLoopIntervalInput}
            value={loopInterval}
            onChangeText={setLoopInterval}
            placeholder="1h"
            placeholderTextColor={t.textMuted}
            autoCapitalize="none"
          />
          <TouchableOpacity
            testID="ss-loop-add"
            style={[styles.ssAddBtn, { opacity: loopPrompt.trim() ? 1 : 0.5 }]}
            disabled={!loopPrompt.trim()}
            onPress={addLoop}
          >
            <Text style={styles.ssAddBtnText}>Add loop</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <TouchableOpacity testID="ss-done" style={styles.sheetDone} onPress={onClose}>
        <Text style={styles.sheetDoneText}>Done</Text>
      </TouchableOpacity>
    </SheetModal>
  )
}
