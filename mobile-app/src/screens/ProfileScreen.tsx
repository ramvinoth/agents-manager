import React, { useCallback, useEffect, useState } from "react"
import { ScrollView, Switch, Text, TextInput, TouchableOpacity, useColorScheme, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, isQueued, type HarmanConfig, type LoopControl, type LoopMode, type Provider } from "../api/client"
import {
  currentHost,
  notifyEveryReply,
  serverUrl,
  setNotifyEveryReply,
  setThemePref,
  setToken,
  subscribeServer,
  themePref,
  type ThemePref,
} from "../state/config"
import { effectiveScheme } from "../lib/theme"
import { useTheme, useThemePref } from "../lib/useTheme"
import { unregisterPush } from "../lib/notify"
import Icon from "../components/Icon"
import ProviderPicker from "../components/ProviderPicker"
import { aiError, aiSummary, type AIConfig } from "../lib/aiSelection"
import ServerPicker from "../components/ServerPicker"
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
 * Profile tab: appearance (theme), notifications, account info, and sign out.
 * Consolidates settings that used to live at the top and bottom of the drawer.
 */
export default function ProfileScreen({ navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const pref = useThemePref()
  const os = useColorScheme()
  const [notify, setNotify] = useState(notifyEveryReply())
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
  // Server picker sheet + a reactive mirror of the active server URL so the row
  // repaints the moment the selection changes (subscribeServer pub-sub).
  const [serverOpen, setServerOpen] = useState(false)
  const [activeUrl, setActiveUrl] = useState(serverUrl())
  useEffect(() => subscribeServer(() => setActiveUrl(serverUrl())), [])

  const [aiConfig, setAIConfig] = useState<AIConfig | null>(null)
  const [aiErr, setAIErr] = useState("")
  const [aiOpen, setAIOpen] = useState(false)
  const [providers, setProviders] = useState<Provider[]>([])
  const host = currentHost()
  useFocusEffect(useCallback(() => {
    let alive = true
    setAIConfig(null); setAIErr(""); setAIOpen(false)
    Promise.all([api.aiConfig({host}), api.providers()]).then(([config, result]) => {
      if (!config.capabilities || !config.selection) throw new Error("Server update required for AI settings.")
      if (alive) { setAIConfig(config); setProviders(result.providers || []) }
    }).catch(e => { if (alive) setAIErr(aiError(e)) })
    return () => { alive = false }
  }, [activeUrl, host]))

  // Header theme toggle: cycles the preference light → dark → system → light,
  // mirroring the segmented control below. The glyph shows the CURRENT effective
  // scheme (moon when dark, sun when light) so it reads as the active state.
  const dark = effectiveScheme(pref, os) === "dark"
  const cycleTheme = useCallback(() => {
    const order: ThemePref[] = ["light", "dark", "system"]
    const next = order[(order.indexOf(themePref()) + 1) % order.length]
    setThemePref(next)
  }, [])

  // Own the shared parent-stack header on focus: Profile has no host picker on
  // the left, and a theme toggle on the right. Explicitly clearing headerLeft
  // stops the host button from a sibling tab lingering here.
  useFocusEffect(
    useCallback(() => {
      navigation.setOptions({
        title: "Profile",
        headerLeft: () => null,
        headerRight: () => (
          <TouchableOpacity
            testID="theme-toggle"
            accessibilityLabel="toggle-theme"
            onPress={cycleTheme}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", marginRight: 4 }}
          >
            <Icon name={dark ? "moon" : "sun"} size={22} color={t.accent} />
          </TouchableOpacity>
        ),
      })
    }, [navigation, cycleTheme, dark, t])
  )

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

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      <Text style={styles.sheetSection}>AUTOMATION</Text>
      <View style={styles.ssRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.ssRowLabel}>Run work on its own</Text>
          <Text style={[styles.ssRowHint, autoErr || (harman && !autoKnown) ? { color: t.danger } : null]}>
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

      <Text style={styles.sheetSection}>SCHEDULED LOOPS</Text>
      <View style={styles.segRow} testID="loop-mode-switch">
        {LOOP_OPTS.map((o) => {
          const active = loop?.mode === o.v
          return (
            <TouchableOpacity
              key={o.v}
              testID={`loop-mode-${o.v}`}
              style={[styles.seg, active ? styles.segActive : null]}
              disabled={!loop || loopBusy}
              onPress={() => chooseLoopMode(o.v)}
            >
              <Text style={[styles.segText, active ? styles.segTextActive : null]}>{o.label}</Text>
            </TouchableOpacity>
          )
        })}
      </View>
      <Text style={[styles.ssRowHint, { paddingHorizontal: 18, marginTop: 6, maxWidth: undefined }, loopErr ? { color: t.danger } : null]}>
        {loopHint}
      </Text>

      <Text style={styles.sheetSection}>AI</Text>
      <TouchableOpacity testID="profile-ai-defaults" style={styles.profileInfoRow} disabled={!aiConfig?.capabilities.editable} onPress={() => setAIOpen(true)}>
        <View style={{flex: 1}}>
          <Text style={styles.ssRowLabel}>New-chat defaults</Text>
          <Text style={styles.ssRowHint}>{aiConfig ? aiSummary(aiConfig.selection, providers) : aiErr || "Loading…"}</Text>
          {aiConfig?.issue ? <Text style={styles.ssRowHint}>{aiConfig.issue}</Text> : null}
        </View>
        <Icon name="chevronRight" size={18} color={t.textMuted}/>
      </TouchableOpacity>
      <Text style={styles.sheetHint}>For new chats on this Harman server. Existing chats are unchanged.</Text>
      <TouchableOpacity
        testID="open-providers"
        style={styles.profileInfoRow}
        onPress={() => navigation.navigate("Providers")}
      >
        <Icon name="server" size={18} color={t.accent} />
        <Text style={[styles.profileInfoValue, { color: t.text, flex: 1, marginLeft: 10, textAlign: "left" }]}>Provider connections</Text>
        <Icon name="chevronRight" size={18} color={t.textMuted} />
      </TouchableOpacity>
      {aiOpen && aiConfig ? <ProviderPicker config={aiConfig} scope={{host}} providers={providers} title="New-chat defaults" onSave={setAIConfig} onClose={() => setAIOpen(false)}/> : null}

      <Text style={styles.sheetSection}>SYSTEM PREAMBLE</Text>
      <Text style={[styles.ssRowHint, { paddingHorizontal: 18, maxWidth: undefined }]}>
        Prepended to every session's system prompt, so each one knows it is a node in the
        system and how its tools are gated. Empty disables it. Applies to sessions started
        after you save.
      </Text>
      <TextInput
        testID="system-preamble"
        style={[styles.input, { marginHorizontal: 18, marginTop: 8, minHeight: 140, textAlignVertical: "top", fontSize: 13 }]}
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
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, marginTop: 8 }}>
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

      <Text style={styles.sheetSection}>APPEARANCE</Text>
      <View style={styles.segRow} testID="theme-switch">
        {THEME_OPTS.map((o) => {
          const active = pref === o.v
          return (
            <TouchableOpacity
              key={o.v}
              testID={`theme-${o.v}`}
              style={[styles.seg, active ? styles.segActive : null]}
              onPress={() => setThemePref(o.v)}
            >
              <Text style={[styles.segText, active ? styles.segTextActive : null]}>{o.label}</Text>
            </TouchableOpacity>
          )
        })}
      </View>

      <Text style={styles.sheetSection}>NOTIFICATIONS</Text>
      <View style={styles.ssRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.ssRowLabel}>Notify every reply</Text>
          <Text style={styles.ssRowHint}>Get a notification each time the agent finishes a turn.</Text>
        </View>
        <Switch
          testID="profile-notify"
          value={notify}
          onValueChange={toggleNotify}
          trackColor={{ true: t.accent, false: t.border }}
        />
      </View>

      <Text style={styles.sheetSection}>ACCOUNT</Text>
      <TouchableOpacity
        testID="open-capabilities"
        style={styles.profileInfoRow}
        onPress={() => navigation.navigate("Capabilities")}
      >
        <Icon name="sparkle" size={18} color={t.accent} />
        <Text style={[styles.profileInfoValue, { color: t.text, flex: 1, marginLeft: 10, textAlign: "left" }]}>Skills & MCP tools</Text>
        <Icon name="chevronRight" size={18} color={t.textMuted} />
      </TouchableOpacity>
      <TouchableOpacity
        testID="open-org"
        style={styles.profileInfoRow}
        onPress={() => navigation.navigate("Org")}
      >
        <Icon name="folder" size={18} color={t.accent} />
        <Text style={[styles.profileInfoValue, { color: t.text, flex: 1, marginLeft: 10, textAlign: "left" }]}>Company & board</Text>
        <Icon name="chevronRight" size={18} color={t.textMuted} />
      </TouchableOpacity>
      <TouchableOpacity
        testID="open-server-picker"
        style={styles.profileInfoRow}
        onPress={() => setServerOpen(true)}
      >
        <Text style={styles.profileInfoLabel}>Server</Text>
        <Text style={[styles.profileInfoValue, { color: t.text, flex: 1 }]} numberOfLines={1}>
          {activeUrl || "—"}
        </Text>
        <Icon name="chevronRight" size={18} color={t.textMuted} />
      </TouchableOpacity>
      <ServerPicker visible={serverOpen} onClose={() => setServerOpen(false)} navigation={navigation} />

      <TouchableOpacity
        testID="sign-out"
        style={[styles.button, { marginHorizontal: 18, marginTop: 24, backgroundColor: t.danger }]}
        onPress={signOut}
      >
        <Text style={styles.buttonText}>Sign out</Text>
      </TouchableOpacity>
    </ScrollView>
  )
}
