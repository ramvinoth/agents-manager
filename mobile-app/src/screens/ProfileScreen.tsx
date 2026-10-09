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
import { useStyles } from "../lib/styles"
import { userError } from "../lib/errors"
import { agentScheduleHint, loopModeFor, roleLabel, scheduleFlags, scheduleSummary } from "../lib/schedules"

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList> }

const THEME_OPTS: { v: ThemePref; label: string }[] = [
  { v: "system", label: "System" },
  { v: "light", label: "Light" },
  { v: "dark", label: "Dark" },
]

/**
 * Profile tab, grouped by REACH so nobody has to guess what a control affects:
 * who and where you are; THIS PHONE (theme, notifications — this device only);
 * AGENTS ON THIS SERVER (automation, schedules, AI defaults, the preamble —
 * every agent and chat on the server, owner-only); feedback; sign out last.
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
  // The account's server role (viewer/orglogic.HUMAN_ROLES). Only an owner may
  // change the server-wide settings below; everyone else is told so up front
  // instead of discovering it from a refusal.
  const [role, setRole] = useState<string | undefined>(undefined)
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
      api.me()
        .then((r) => alive && setRole(r.user?.role))
        .catch(() => {})
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
      setAutoErr(userError(e, "automation", "change"))
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
      setLoopErr(userError(e, "schedules", "change"))
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
      setPreMsg(userError(e, "the system preamble", "save"))
      setPreamble(await api.orgSystemPreamble().then((p) => p.preamble).catch(() => null))
    } finally {
      setPreBusy(false)
    }
  }

  // Three states, not two. A server older than the switch omits the key, and
  // rendering that as "off" would tell you the machine is paused when that build
  // has no gate at all and is still firing scheduled jobs. Unknown says so.
  const autoKnown = harman ? typeof harman.automation_enabled === "boolean" : false
  const automation = autoKnown ? harman!.automation_enabled : undefined
  const autoHint = autoErr
    ? autoErr
    : !harman
      ? "Can't reach the server — state unknown."
      : !autoKnown
        ? "This server is too old to have the switch — it still runs jobs on their own. Update it."
        : automation
          ? "Agents may start work without you: their own schedules and the board manager."
          : "Agents start nothing on their own. They work when you message them."
  const flags = loop ? scheduleFlags(loop.mode) : null
  const isOwner = role === "owner"

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
            <Text testID="profile-role" style={styles.spCardSummary}>{roleLabel(role)}</Text>
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

      <Text style={styles.sheetSection}>THIS PHONE</Text>
      <View style={styles.spCard}>
        <View style={styles.ssRow}>
          <Text style={[styles.ssRowLabel, { flex: 1 }]}>Theme</Text>
        </View>
        <View style={styles.segRow} testID="theme-switch">
          {THEME_OPTS.map((o) => {
            const on = pref === o.v
            return (
              <TouchableOpacity key={o.v} testID={`theme-${o.v}`} style={[styles.seg, on ? styles.segActive : null]} onPress={() => setThemePref(o.v)}>
                <Text style={[styles.segText, on ? styles.segTextActive : null]}>{o.label}</Text>
              </TouchableOpacity>
            )
          })}
        </View>
        <SettingRow
          label="Notify on every reply"
          hint={notify ? "A notification each time an agent finishes a turn." : "Only questions and approvals that need you."}
        >
          <Switch testID="profile-notify" value={notify} onValueChange={toggleNotify} trackColor={{ true: t.accent, false: t.border }} />
        </SettingRow>
        <View style={{ height: 12 }} />
      </View>

      <Text style={styles.sheetSection}>AGENTS ON THIS SERVER</Text>
      <Text testID="server-scope-hint" style={styles.sheetHint}>
        {isOwner
          ? "These apply to every agent and chat on this server, from any device."
          : "These apply to every agent and chat on this server. Only the owner can change them; a change you make is sent to them for approval or refused."}
      </Text>
      <Card icon="flash" title="Autonomy" summary={loop ? scheduleSummary(loop.mode, automation) : loopErr || "Loading…"} testID="profile-autonomy">
        <SettingRow label="Let agents work on their own" hint={autoHint} danger={!!autoErr || (!!harman && !autoKnown)}>
          <Switch
            testID="profile-automation"
            value={automation === true}
            disabled={!autoKnown || autoBusy}
            onValueChange={toggleAutomation}
            trackColor={{ true: t.accent, false: t.border }}
          />
        </SettingRow>
        <SettingRow label="Your schedules" hint={flags?.mine ? "Recurring jobs you set on a chat fire on time." : "Recurring jobs you set on a chat stay paused."}>
          <Switch
            testID="schedules-mine"
            value={flags?.mine === true}
            disabled={!flags || loopBusy}
            onValueChange={(v) => { if (flags) void chooseLoopMode(loopModeFor({ ...flags, mine: v })) }}
            trackColor={{ true: t.accent, false: t.border }}
          />
        </SettingRow>
        <SettingRow label="Agents' schedules" hint={loop ? agentScheduleHint(loop.mode, automation) : "Can't reach the server — state unknown."}>
          <Switch
            testID="schedules-agents"
            value={flags?.agents === true}
            disabled={!flags || loopBusy}
            onValueChange={(v) => { if (flags) void chooseLoopMode(loopModeFor({ ...flags, agents: v })) }}
            trackColor={{ true: t.accent, false: t.border }}
          />
        </SettingRow>
        {loopErr ? <Text style={[styles.ssRowHint, { paddingHorizontal: 18, marginTop: 8, maxWidth: undefined, color: t.danger }]}>{loopErr}</Text> : null}
      </Card>

      <Card icon="sparkle" title="AI for new chats">
        <TouchableOpacity testID="profile-ai-defaults" style={styles.profileInfoRow} disabled={!aiConfig?.capabilities.editable} onPress={() => setAIOpen(true)}>
          <View style={{ flex: 1 }}>
            <Text style={styles.ssRowLabel}>{aiConfig ? aiSummary(aiConfig.selection, providers) : aiErr || "Loading…"}</Text>
            <Text style={[styles.ssRowHint, { maxWidth: undefined }, aiConfig?.issue ? { color: t.danger } : null]}>
              {aiConfig?.issue || "What every new chat starts with. Existing chats keep their own."}
            </Text>
          </View>
          <Icon name="chevronRight" size={18} color={t.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity testID="open-providers" style={styles.profileInfoRow} onPress={() => navigation.navigate("Providers")}>
          <View style={{ flex: 1 }}>
            <Text style={styles.ssRowLabel}>Model providers</Text>
            <Text style={[styles.ssRowHint, { maxWidth: undefined }]}>Add or edit the endpoints and keys chats can use.</Text>
          </View>
          <Icon name="chevronRight" size={18} color={t.textMuted} />
        </TouchableOpacity>
      </Card>
      {aiOpen && aiConfig ? <ProviderPicker config={aiConfig} scope={{host}} providers={providers} title="AI for new chats" onSave={setAIConfig} onClose={() => setAIOpen(false)}/> : null}

      <Card
        icon="book"
        title="System preamble"
        summary={preamble === null ? "Loading…" : preamble ? `On — ${preamble.length.toLocaleString()} characters every agent reads first` : "Off — agents get no shared instructions"}
        open={preOpen}
        onToggle={() => setPreOpen((v) => !v)}
        testID="toggle-preamble"
      >
        <Text style={[styles.ssRowHint, { paddingHorizontal: 14, marginTop: 4, maxWidth: undefined }]}>
          Shared instructions put at the top of every agent's prompt: how Harman works and how its
          tools are gated. Empty turns it off. Chats started after you save get the new text.
        </Text>
        <TextInput
          testID="system-preamble"
          style={[styles.input, { marginHorizontal: 14, marginTop: 8, minHeight: 140, maxHeight: 320, textAlignVertical: "top", fontSize: 13 }]}
          value={draft}
          editable={preamble !== null && !preBusy}
          onChangeText={(v) => {
            setDraft(v)
            if (preMsg) setPreMsg("")
          }}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={preamble === null ? "Loading…" : "No preamble — agents get no shared instructions."}
          placeholderTextColor={t.textMuted}
        />
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, marginTop: 8, gap: 12 }}>
          <Text style={[styles.ssRowHint, { flex: 1, maxWidth: undefined }, preMsg && preMsg !== "Saved." ? { color: t.danger } : null]}>
            {preMsg}
          </Text>
          {draft !== preamble && preamble !== null ? (
            <TouchableOpacity testID="revert-preamble" disabled={preBusy} onPress={() => { setDraft(preamble); setPreMsg("") }}>
              <Text style={{ color: t.textMuted, fontSize: 14, fontWeight: "600" }}>Revert</Text>
            </TouchableOpacity>
          ) : null}
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

      <Text style={styles.sheetSection}>FEEDBACK</Text>
      <View style={[styles.spCard, { paddingBottom: 12 }]}>
        <TextInput
          testID="feedback-input"
          style={[styles.input, { marginHorizontal: 14, marginTop: 12, minHeight: 72, textAlignVertical: "top", fontSize: 14 }]}
          value={feedback}
          onChangeText={(v) => { setFeedback(v); if (feedbackSent) setFeedbackSent(false) }}
          multiline
          placeholder="What's confusing, slow, missing or never used?"
          placeholderTextColor={t.textMuted}
        />
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, marginTop: 8, gap: 12 }}>
          <Text style={[styles.ssRowHint, { flex: 1, maxWidth: undefined }]}>
            {feedbackSent ? "Sent — thank you." : "Saved on the server, where the agents improving Harman read it."}
          </Text>
          <TouchableOpacity
            testID="send-feedback"
            style={[styles.button, { marginTop: 0, paddingVertical: 10, paddingHorizontal: 20, opacity: feedback.trim() ? 1 : 0.5 }]}
            disabled={!feedback.trim()}
            onPress={() => { recordFeedback("Profile", feedback.trim()); setFeedback(""); setFeedbackSent(true) }}
          >
            <Text style={styles.buttonText}>Send</Text>
          </TouchableOpacity>
        </View>
      </View>

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
        {summary ? <Text testID={testID ? `${testID}-summary` : undefined} style={styles.spCardSummary}>{summary}</Text> : null}
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

/** One label + hint + control row inside a settings card. */
function SettingRow({ label, hint, danger, children }: { label: string; hint: string; danger?: boolean; children: ReactNode }) {
  const styles = useStyles()
  const t = useTheme()
  return (
    <View style={styles.ssRow}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={styles.ssRowLabel}>{label}</Text>
        <Text style={[styles.ssRowHint, { maxWidth: undefined }, danger ? { color: t.danger } : null]}>{hint}</Text>
      </View>
      {children}
    </View>
  )
}
