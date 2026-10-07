import React, { useCallback, useEffect, useState, type ReactNode } from "react"
import { Alert, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from "react-native"
import Constants from "expo-constants"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, isQueued, type HarmanConfig, type LoopControl, type LoopMode, type Provider } from "../api/client"
import { displayAddress } from "../lib/servers"
import {
  activeServer,
  notifyEveryReply,
  setNotifyEveryReply,
  setThemePref,
  setToken,
  subscribeServer,
  type ThemePref,
  username,
} from "../state/config"
import { useTheme, useThemePref } from "../lib/useTheme"
import { unregisterPush } from "../lib/notify"
import { recordFeedback } from "../lib/usageReporter"
import Icon, { type IconName } from "../components/Icon"
import ProviderPicker from "../components/ProviderPicker"
import { aiError, aiSummary, type AIConfig } from "../lib/aiSelection"
import ServerPicker from "../components/ServerPicker"
import HostPicker from "../components/HostPicker"
import { useHost } from "../lib/useHost"
import { useMenuButton } from "../components/SideMenu"
import { useScreenHeader } from "../lib/useScreenHeader"
import { useStyles } from "./styles"

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList> }

const THEME_OPTS: { v: ThemePref; label: string }[] = [
  { v: "system", label: "System" },
  { v: "light", label: "Light" },
  { v: "dark", label: "Dark" },
]

// Loop-firing modes, in escalating order of what's licensed to run. Labels are
// the plain-language version of loops.LOOP_MODES: "None" pauses every loop,
// "Both" licenses every origin. The value is what the server stores.
const LOOP_OPTS: { v: LoopMode; label: string }[] = [
  { v: "none", label: "None" },
  { v: "user", label: "Yours" },
  { v: "harman", label: "Agent" },
  { v: "both", label: "Both" },
]

/**
 * Profile tab, ordered by how often each thing is touched: who and where you are,
 * everyday preferences, feedback, then the rare power settings (automation, AI,
 * the system preamble, collapsed), and sign out last behind a confirm.
 */
export default function ProfileScreen({ navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const pref = useThemePref()
  const [notify, setNotify] = useState(notifyEveryReply())
  const [feedback, setFeedback] = useState("")
  const [feedbackSent, setFeedbackSent] = useState(false)
  // The automation master switch. Null while unknown (not yet loaded, or the
  // server is unreachable) — the row renders disabled rather than guessing,
  // because a switch showing "off" that never reached the server would be the
  // one lie this control must not tell.
  const [harman, setHarman] = useState<HarmanConfig | null>(null)
  const [autoBusy, setAutoBusy] = useState(false)
  const [autoErr, setAutoErr] = useState("")
  // The loop-firing mode — WHICH loop origins may run, independent of the master
  // switch above. Null while unknown (same reasoning as `harman`): a mode picker
  // that guessed would misstate which of the owner's schedules are live.
  const [loop, setLoop] = useState<LoopControl | null>(null)
  const [loopBusy, setLoopBusy] = useState(false)
  const [loopErr, setLoopErr] = useState("")
  // The global system-awareness preamble prepended to every session's system
  // prompt. `preamble` is the server's value (null while unknown, same reasoning
  // as harman/loop above); `draft` is the local edit buffer so typing doesn't
  // fight the fetched value. preMsg carries the save result ("Saved." or an error).
  const [preamble, setPreamble] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [preBusy, setPreBusy] = useState(false)
  const [preMsg, setPreMsg] = useState("")
  // Collapsed by default: a once-a-month setting must not hold a 140pt editor
  // open on a screen visited for the theme or a server switch.
  const [preOpen, setPreOpen] = useState(false)
  // Server picker sheet + a reactive mirror of the active server so the row
  // repaints (and AI settings refetch) the moment the selection changes. Keyed by
  // entry, not URL: a relay-only server has no URL, and two of them must differ.
  const [serverOpen, setServerOpen] = useState(false)
  const [active, setActive] = useState(activeServer())
  useEffect(() => subscribeServer(() => setActive(activeServer())), [])

  const [aiConfig, setAIConfig] = useState<AIConfig | null>(null)
  const [aiErr, setAIErr] = useState("")
  const [aiOpen, setAIOpen] = useState(false)
  const [providers, setProviders] = useState<Provider[]>([])
  const { host, label: hostLabel } = useHost()
  const [hostOpen, setHostOpen] = useState(false)
  useFocusEffect(useCallback(() => {
    let alive = true
    setAIConfig(null); setAIErr(""); setAIOpen(false)
    Promise.all([api.aiConfig({host}), api.providers()]).then(([config, result]) => {
      if (!config.capabilities || !config.selection) throw new Error("Server update required for AI settings.")
      if (alive) { setAIConfig(config); setProviders(result.providers || []) }
    }).catch(e => { if (alive) setAIErr(aiError(e)) })
    return () => { alive = false }
  }, [active?.id, host]))

  const menuButton = useMenuButton()
  // No header action: the theme lives once, in Appearance below.
  useScreenHeader(navigation, () => ({
    title: "Profile",
    headerLeft: menuButton,
    headerRight: () => null,
  }), [])

  function confirmSignOut() {
    const where = active ? displayAddress(active) : "this server"
    Alert.alert("Sign out?", `This phone stops getting notifications from ${where} until you sign in again.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void signOut() },
    ])
  }

  async function signOut() {
    // Stop background pushes to this device before dropping the token.
    await unregisterPush((tok) => api.pushUnregister(tok)).catch(() => {})
    try {
      await api.signout()
    } catch {
      /* best effort */
    }
    await setToken(null)
    navigation.replace("Login")
  }

  function toggleNotify(v: boolean) {
    setNotify(v)
    setNotifyEveryReply(v)
  }

  // Re-read on every focus: the same flag is also editable from Company & board,
  // and a safety control must show the server's state, not a stale local one.
  useFocusEffect(
    useCallback(() => {
      let alive = true
      api.orgHarman()
        .then((h) => alive && setHarman(h))
        .catch(() => alive && setHarman(null))
      api.orgLoopControl()
        .then((l) => alive && setLoop(l))
        .catch(() => alive && setLoop(null))
      api.orgSystemPreamble()
        .then((p) => alive && setPreamble(p.preamble))
        .catch(() => alive && setPreamble(null))
      return () => {
        alive = false
      }
    }, [])
  )

  // Seed the edit buffer once the server value arrives, and re-seed whenever it
  // changes (e.g. an approval applied someone else's edit). Mirrors the web
  // ProfilePanel: server is the source of truth, the draft tracks it until edited.
  useEffect(() => {
    if (preamble !== null) setDraft(preamble)
  }, [preamble])

  async function toggleAutomation(v: boolean) {
    if (!harman || autoBusy) return
    setAutoBusy(true)
    setAutoErr("")
    try {
      // Deliberately NOT optimistic. Everywhere else a snapped-back switch is a
      // cosmetic annoyance; here it would claim the machine is paused when the
      // request never landed. The switch moves only once the server confirms.
      const res = await api.orgSetHarman({ automation_enabled: v })
      // Resuming is Red (viewer/orglogic), so a non-owner's request is QUEUED as
      // an approval rather than applied — a 200 that changed nothing. Say so, or
      // the switch snapping back looks like a bug instead of the gate working.
      if (isQueued(res)) {
        setAutoErr("Sent for approval — only the owner can turn automation on.")
        setHarman(await api.orgHarman().catch(() => harman))
      } else {
        setHarman(res)
      }
    } catch (e) {
      setAutoErr((e as Error).message || "Couldn't change it.")
      setHarman(await api.orgHarman().catch(() => null))
    } finally {
      setAutoBusy(false)
    }
  }

  async function chooseLoopMode(mode: LoopMode) {
    if (loopBusy || (loop && loop.mode === mode)) return
    setLoopBusy(true)
    setLoopErr("")
    try {
      // Green + manager-scoped, so the server returns the applied config directly;
      // a non-manager session is refused (403) and lands in catch, never queued.
      setLoop(await api.orgSetLoopControl(mode))
    } catch (e) {
      setLoopErr((e as Error).message || "Couldn't change it.")
      setLoop(await api.orgLoopControl().catch(() => null))
    } finally {
      setLoopBusy(false)
    }
  }

  async function savePreamble() {
    if (preBusy || preamble === null || draft === preamble) return
    setPreBusy(true)
    setPreMsg("")
    try {
      // Manager-scoped AND Red (viewer/orglogic): a non-owner's edit is QUEUED as
      // an approval rather than applied, so say so instead of claiming it saved.
      const res = await api.orgSetSystemPreamble(draft)
      if (isQueued(res)) {
        setPreMsg("Sent for approval — only the owner can change the system preamble.")
        setPreamble(await api.orgSystemPreamble().then((p) => p.preamble).catch(() => preamble))
      } else {
        setPreamble(res.preamble)
        setPreMsg("Saved.")
      }
    } catch (e) {
      setPreMsg((e as Error).message || "Couldn't save it.")
      setPreamble(await api.orgSystemPreamble().then((p) => p.preamble).catch(() => null))
    } finally {
      setPreBusy(false)
    }
  }

  // Three states, not two. A server older than the switch omits the key, and
  // rendering that as "off" would tell you the machine is paused when that build
  // has no gate at all and is still firing scheduled jobs. Unknown says so.
  const autoKnown = harman ? typeof harman.automation_enabled === "boolean" : false
  const autoHint = autoErr
    ? autoErr
    : !harman
      ? "Can't reach the server — state unknown."
      : !autoKnown
        ? "This server is too old to have the switch — it still runs jobs on their own. Update it."
        : harman.automation_enabled
          ? "On — scheduled jobs and the autonomous manager can start work on their own."
          : "Off — nothing runs unless you ask. Scheduled jobs and the manager are paused."

  // The loop picker's own hint. Its meaning is independent of the master switch:
  // "Yours" keeps the owner's schedules firing even while automation is paused.
  const loopHint = loopErr
    ? loopErr
    : !loop
      ? "Can't reach the server — loop state unknown."
      : loop.mode === "none"
        ? "Paused — no scheduled loops fire, yours or the agents'."
        : loop.mode === "user"
          ? "Only your own scheduled loops fire. Agent-created loops stay paused."
          : loop.mode === "harman"
            ? "Only agent-created loops fire. Your own scheduled loops stay paused."
            : "Every scheduled loop fires — yours and the agents'."

  const me = username()
  const build = Constants.ios?.buildNumber
  const version = Constants.expoConfig?.version

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      {/* Who and where you are — the one thing a Profile tab must answer first. */}
      <View style={styles.spCard} testID="profile-identity">
        <View style={styles.spCardHead}>
          <View style={[styles.spCardIcon, { width: 44, height: 44, borderRadius: 22, backgroundColor: t.accent }]}>
            <Text style={{ color: t.onAccent, fontSize: 18, fontWeight: "700" }}>{(me[0] || "?").toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.spCardTitle} numberOfLines={1}>{me || "Signed in"}</Text>
            <Text style={styles.spCardSummary}>Owner of this Harman server</Text>
          </View>
        </View>
        <View style={styles.spCardBody}>
          <TouchableOpacity testID="open-server-picker" style={styles.profileInfoRow} onPress={() => setServerOpen(true)}>
            <Text style={styles.profileInfoLabel}>Server</Text>
            <Text style={[styles.profileInfoValue, { color: t.text }]} numberOfLines={1}>
              {active ? displayAddress(active) : "—"}
            </Text>
            <Icon name="chevronRight" size={18} color={t.textMuted} />
          </TouchableOpacity>
          {/* The machine chats/files/terminal work on. A setting you rarely change,
              so it lives here — not as a permanent label eating every tab header. */}
          <TouchableOpacity testID="open-host-picker" style={styles.profileInfoRow} onPress={() => setHostOpen(true)}>
            <Text style={styles.profileInfoLabel}>Machine</Text>
            <Text style={[styles.profileInfoValue, { color: t.text }]} numberOfLines={1}>{hostLabel}</Text>
            <Icon name="chevronRight" size={18} color={t.textMuted} />
          </TouchableOpacity>
        </View>
      </View>
      <ServerPicker visible={serverOpen} onClose={() => setServerOpen(false)} navigation={navigation} />
      <HostPicker visible={hostOpen} onClose={() => setHostOpen(false)} navigation={navigation} />

      <Card icon="sun" title="Appearance">
        <View style={[styles.segRow, { marginTop: 12 }]} testID="theme-switch">
          {THEME_OPTS.map((o) => {
            const on = pref === o.v
            return (
              <TouchableOpacity key={o.v} testID={`theme-${o.v}`} style={[styles.seg, on ? styles.segActive : null]} onPress={() => setThemePref(o.v)}>
                <Text style={[styles.segText, on ? styles.segTextActive : null]}>{o.label}</Text>
              </TouchableOpacity>
            )
          })}
        </View>
      </Card>

      <Card icon="mail" title="Notifications">
        <View style={styles.ssRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.ssRowLabel}>Every reply</Text>
            <Text style={[styles.ssRowHint, { maxWidth: undefined }]}>
              {notify ? "A notification each time an agent finishes a turn." : "Only questions and approvals that need you."}
            </Text>
          </View>
          <Switch testID="profile-notify" value={notify} onValueChange={toggleNotify} trackColor={{ true: t.accent, false: t.border }} />
        </View>
      </Card>

      <Card icon="megaphone" title="Feedback" summary="Agents read every note and turn it into work on the board.">
        <TextInput
          testID="feedback-input"
          style={[styles.input, { marginHorizontal: 14, marginTop: 12, minHeight: 72, textAlignVertical: "top", fontSize: 14 }]}
          value={feedback}
          onChangeText={(v) => { setFeedback(v); if (feedbackSent) setFeedbackSent(false) }}
          multiline
          placeholder="What is confusing, slow, missing or never used?"
          placeholderTextColor={t.textMuted}
        />
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, marginTop: 8 }}>
          <Text style={[styles.ssRowHint, { flex: 1, maxWidth: undefined }]}>{feedbackSent ? "Sent — thank you." : ""}</Text>
          <TouchableOpacity
            testID="send-feedback"
            style={[styles.button, { marginTop: 0, paddingVertical: 10, paddingHorizontal: 20, opacity: feedback.trim() ? 1 : 0.5 }]}
            disabled={!feedback.trim()}
            onPress={() => { recordFeedback("Profile", feedback.trim()); setFeedback(""); setFeedbackSent(true) }}
          >
            <Text style={styles.buttonText}>Send</Text>
          </TouchableOpacity>
        </View>
      </Card>

      <Text style={styles.sheetSection}>ADVANCED</Text>
      <Card icon="flash" title="Automation">
        <View style={styles.ssRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.ssRowLabel}>Run work on its own</Text>
            <Text style={[styles.ssRowHint, { maxWidth: undefined }, autoErr || (harman && !autoKnown) ? { color: t.danger } : null]}>
              {autoHint}
            </Text>
          </View>
          <Switch
            testID="profile-automation"
            value={harman?.automation_enabled === true}
            disabled={!autoKnown || autoBusy}
            onValueChange={toggleAutomation}
            trackColor={{ true: t.accent, false: t.border }}
          />
        </View>
        <Text style={[styles.ssRowLabel, { paddingHorizontal: 18, marginTop: 14 }]}>Scheduled loops that may fire</Text>
        <View style={styles.segRow} testID="loop-mode-switch">
          {LOOP_OPTS.map((o) => {
            const on = loop?.mode === o.v
            return (
              <TouchableOpacity
                key={o.v}
                testID={`loop-mode-${o.v}`}
                style={[styles.seg, on ? styles.segActive : null]}
                disabled={!loop || loopBusy}
                onPress={() => chooseLoopMode(o.v)}
              >
                <Text style={[styles.segText, on ? styles.segTextActive : null]}>{o.label}</Text>
              </TouchableOpacity>
            )
          })}
        </View>
        <Text style={[styles.ssRowHint, { paddingHorizontal: 18, marginTop: 6, maxWidth: undefined }, loopErr ? { color: t.danger } : null]}>
          {loopHint}
        </Text>
      </Card>

      <Card icon="sparkle" title="AI">
        <TouchableOpacity testID="profile-ai-defaults" style={styles.profileInfoRow} disabled={!aiConfig?.capabilities.editable} onPress={() => setAIOpen(true)}>
          <View style={{ flex: 1 }}>
            <Text style={styles.ssRowLabel}>New-chat defaults</Text>
            <Text style={[styles.ssRowHint, { maxWidth: undefined }]}>{aiConfig ? aiSummary(aiConfig.selection, providers) : aiErr || "Loading…"}</Text>
            {aiConfig?.issue ? <Text style={[styles.ssRowHint, { maxWidth: undefined }]}>{aiConfig.issue}</Text> : null}
            <Text style={[styles.ssRowHint, { maxWidth: undefined }]}>Existing chats are unchanged.</Text>
          </View>
          <Icon name="chevronRight" size={18} color={t.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity testID="open-providers" style={styles.profileInfoRow} onPress={() => navigation.navigate("Providers")}>
          <Text style={[styles.ssRowLabel, { flex: 1 }]}>Provider connections</Text>
          <Icon name="chevronRight" size={18} color={t.textMuted} />
        </TouchableOpacity>
      </Card>
      {aiOpen && aiConfig ? <ProviderPicker config={aiConfig} scope={{host}} providers={providers} title="New-chat defaults" onSave={setAIConfig} onClose={() => setAIOpen(false)}/> : null}

      <Card
        icon="book"
        title="System preamble"
        summary={preamble === null ? "Loading…" : preamble ? `${preamble.length} characters, sent to every new session` : "Off — sessions get no system text"}
        open={preOpen}
        onToggle={() => setPreOpen((v) => !v)}
        testID="toggle-preamble"
      >
        <Text style={[styles.ssRowHint, { paddingHorizontal: 14, marginTop: 10, maxWidth: undefined }]}>
          Prepended to every session's system prompt, so each one knows it is a node in the
          system and how its tools are gated. Empty disables it. Applies to sessions started
          after you save.
        </Text>
        <TextInput
          testID="system-preamble"
          style={[styles.input, { marginHorizontal: 14, marginTop: 8, minHeight: 140, textAlignVertical: "top", fontSize: 13 }]}
          value={draft}
          editable={preamble !== null && !preBusy}
          onChangeText={(v) => {
            setDraft(v)
            if (preMsg) setPreMsg("")
          }}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={preamble === null ? "Loading…" : "No preamble — sessions get no system-awareness text."}
          placeholderTextColor={t.textMuted}
        />
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, marginTop: 8 }}>
          <Text style={[styles.ssRowHint, { flex: 1, maxWidth: undefined }, preMsg && preMsg !== "Saved." ? { color: t.danger } : null]}>
            {preMsg}
          </Text>
          <TouchableOpacity
            testID="save-preamble"
            style={[styles.button, { marginTop: 0, paddingVertical: 10, paddingHorizontal: 20, opacity: preamble === null || preBusy || draft === preamble ? 0.5 : 1 }]}
            disabled={preamble === null || preBusy || draft === preamble}
            onPress={savePreamble}
          >
            <Text style={styles.buttonText}>Save</Text>
          </TouchableOpacity>
        </View>
      </Card>

      {/* Outlined, not a filled red slab: the least-used action must not be the
          loudest thing on the screen. The confirm guards the stray tap. */}
      <TouchableOpacity
        testID="sign-out"
        style={[styles.button, { marginHorizontal: 14, marginTop: 28, backgroundColor: "transparent", borderWidth: 1, borderColor: t.danger }]}
        onPress={confirmSignOut}
      >
        <Text style={[styles.buttonText, { color: t.danger }]}>Sign out</Text>
      </TouchableOpacity>
      <Text testID="app-version" style={[styles.sheetHint, { textAlign: "center", marginTop: 14 }]}>
        Harman {version ?? "?"}{build ? ` (${build})` : ""}
      </Text>
    </ScrollView>
  )
}

/** One grouped settings card. With onToggle it collapses to its header. */
function Card({ icon, title, summary, open = true, onToggle, testID, children }: {
  icon: IconName; title: string; summary?: string; open?: boolean; onToggle?: () => void; testID?: string; children: ReactNode
}) {
  const styles = useStyles()
  const t = useTheme()
  const head = (
    <>
      <View style={styles.spCardIcon}><Icon name={icon} size={16} color={t.accent} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.spCardTitle}>{title}</Text>
        {summary ? <Text style={styles.spCardSummary}>{summary}</Text> : null}
      </View>
      {onToggle ? <Icon name={open ? "chevronDown" : "chevronRight"} size={18} color={t.textMuted} /> : null}
    </>
  )
  return (
    <View style={styles.spCard}>
      {onToggle
        ? <TouchableOpacity testID={testID} activeOpacity={0.7} style={styles.spCardHead} onPress={onToggle}>{head}</TouchableOpacity>
        : <View style={[styles.spCardHead, { paddingBottom: 0 }]}>{head}</View>}
      {open ? <View style={{ paddingBottom: 14 }}>{children}</View> : null}
    </View>
  )
}
