import React, { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, Alert, Switch, Text, TextInput, View } from "react-native"
import * as Clipboard from "expo-clipboard"
import { TouchableOpacity } from "./Tracked"
import Icon from "./Icon"
import { api, isQueued, type IntakeChannel, type OrgProject, type Session } from "../api/client"
import { activeServer, currentHost } from "../state/config"
import { directUrl } from "../lib/servers"
import { showActions } from "../lib/actionSheet"
import { userError } from "../lib/errors"
import { useStyles } from "../lib/styles"
import { useTheme } from "../lib/useTheme"

type Draft = { name: string; project: OrgProject | null; session: Session | null; feedback: boolean }

/**
 * Intake channels — doors from the outside world onto a board
 * (orchestrator/intake.py). Each is a URL + token bound to one project board and
 * optionally one chat; a POST becomes a card there and wakes that chat. One
 * channel may also receive the owner's in-app feedback. Twin of the web
 * IntakeSection; the server owns every rule.
 *
 * The token is shown ONCE (on create / New token): only its hash is stored.
 * Closing a channel confirms first.
 */
export default function IntakeSection() {
  const styles = useStyles()
  const t = useTheme()
  const [channels, setChannels] = useState<IntakeChannel[] | null>(null)
  const [projects, setProjects] = useState<OrgProject[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [shown, setShown] = useState<{ id: string; token: string } | null>(null)
  const [copied, setCopied] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    const [c, p] = await Promise.all([api.intakeList(), api.orgProjects()])
    setChannels(c.channels || [])
    setProjects(p.projects || [])
  }, [])
  useEffect(() => {
    load().catch((e) => setError(userError(e, "intake channels")))
    api.sessions(currentHost()).then(setSessions).catch(() => {})
  }, [load])

  const title = (sid: string) => sessions.find((s) => s.id === sid)?.title || sid.slice(0, 8)
  const projectName = (pid: number) => projects.find((x) => x.id === pid)?.name || `project ${pid}`
  // A relay-only server has no address the outside world can post to; say so instead of a dead URL.
  const base = directUrl(activeServer()).replace(/\/+$/, "")
  const url = (c: IntakeChannel) => (base ? base + c.path : c.path)

  async function run(key: string, fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(key); setError("")
    try {
      const r = await fn()
      if (r && typeof r === "object" && "error" in r) { setError(String((r as { error: string }).error)); return false }
      if (isQueued(r)) setError("Queued for the owner's approval.")
      else if (r && typeof r === "object" && "token" in r && (r as IntakeChannel).token) {
        const c = r as IntakeChannel
        setShown({ id: c.id, token: c.token! })
      }
      await load()
      return true
    } catch (e) {
      setError(userError(e, "the intake channel", "update"))
      return false
    } finally {
      setBusy("")
    }
  }

  const copy = (key: string, text: string) => {
    Clipboard.setStringAsync(text).then(() => { setCopied(key); setTimeout(() => setCopied(""), 1500) })
  }
  const curl = (c: IntakeChannel, token: string) =>
    `curl -X POST ${url(c)} -H 'X-Intake-Token: ${token}' -H 'Content-Type: application/json' -d '{"title":"Hello","text":"Details…"}'`

  const pickSession = (title_: string, onPick: (s: Session | null) => void) =>
    showActions(title_, [
      { text: "Wake nobody (you get a push)", onPress: () => onPick(null) },
      ...sessions.filter((s) => s.id).map((s) => ({ text: s.title || s.id.slice(0, 8), onPress: () => onPick(s) })),
    ])

  const close = (c: IntakeChannel) =>
    Alert.alert(`Close "${c.name}"?`, "Posts to it will be refused. This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Close channel", style: "destructive", onPress: () => run(`del:${c.id}`, () => api.intakeDelete(c.id)) },
    ])
  const rotate = (c: IntakeChannel) =>
    Alert.alert(`New token for "${c.name}"?`, "The old token stops working at once; anything using it must be updated.", [
      { text: "Cancel", style: "cancel" },
      { text: "New token", onPress: () => run(`rot:${c.id}`, () => api.intakeRotate(c.id)) },
    ])

  const create = async () => {
    if (!draft?.project || !draft.name.trim()) return
    const ok = await run("new", () => api.intakeCreate({
      name: draft.name.trim(), project_id: draft.project!.id,
      for_session: draft.session?.id, app_feedback: draft.feedback,
    }))
    if (ok) setDraft(null)
  }

  return (
    <View testID="integration-intake">
      <Text style={styles.sheetSection}>INTAKE CHANNELS</Text>
      <Text style={styles.sheetHint}>
        A link anything outside can post to — a website form, a failing build, an alert, your own app feedback.
        Each post becomes a card on the board you pick and wakes the chat you pick.
      </Text>
      <View style={styles.spCard}>
        {channels === null && !error ? <View style={styles.igSection}><ActivityIndicator /></View> : null}
        {channels?.map((c, i) => (
          <View key={c.id} testID={`intake-${c.id}`} style={[styles.igSection, i > 0 && styles.igHairTop]}>
            <View style={styles.rowCenter}>
              <View style={styles.flex1}>
                <Text style={styles.ssRowLabel} numberOfLines={1}>{c.name}</Text>
                <Text style={styles.igHint}>
                  {c.received} received{c.last_used ? ` · last ${new Date(c.last_used * 1000).toLocaleString()}` : ""}
                </Text>
              </View>
              {busy.endsWith(`:${c.id}`) ? <ActivityIndicator /> : null}
              <TouchableOpacity testID={`intake-rotate-${c.id}`} disabled={!!busy} hitSlop={8} style={styles.igIconBtn}
                onPress={() => rotate(c)} accessibilityLabel={`New token for ${c.name}`}>
                <Icon name="repeat" size={16} color={t.textMuted} />
              </TouchableOpacity>
              <TouchableOpacity testID={`intake-delete-${c.id}`} disabled={!!busy} hitSlop={8} style={styles.igIconBtn}
                onPress={() => close(c)} accessibilityLabel={`Close ${c.name}`}>
                <Icon name="trash" size={16} color={t.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={styles.igHint}>Board: {projectName(c.project_id)}</Text>
            <TouchableOpacity testID={`intake-wakes-${c.id}`} disabled={!!busy}
              onPress={() => pickSession("Which chat should each post wake?", (s) =>
                run(`ses:${c.id}`, () => api.intakeUpdate({ id: c.id, for_session: s?.id || "" })))}>
              <Text style={styles.igHint}>
                Wakes: {c.session_id ? title(c.session_id) : "nobody (you get a push)"} <Text style={styles.igLink}>Change</Text>
              </Text>
            </TouchableOpacity>
            <View style={[styles.rowCenter, { marginTop: 6 }]}>
              <Text selectable numberOfLines={1} style={[styles.igHint, styles.flex1]}>{url(c)}</Text>
              <TouchableOpacity testID={`intake-copy-${c.id}`} hitSlop={8} style={styles.igIconBtn} onPress={() => copy(`u:${c.id}`, url(c))}
                accessibilityLabel="Copy URL">
                <Icon name={copied === `u:${c.id}` ? "check" : "copy"} size={16} color={t.accent} />
              </TouchableOpacity>
            </View>
            {!base ? <Text style={styles.igHint}>This server is reached through the relay, so put its own address in front of this path.</Text> : null}
            {shown?.id === c.id ? (
              <View testID="intake-token" style={[styles.spCard, { marginHorizontal: 0, marginTop: 8, padding: 10, borderColor: t.warning ?? t.accent, borderWidth: 1 }]}>
                <Text style={styles.ssRowLabel}>Token — copy it now, it is not shown again</Text>
                <View style={styles.rowCenter}>
                  <Text selectable style={[styles.igHint, styles.flex1]}>{shown.token}</Text>
                  <TouchableOpacity testID="intake-copy-token" hitSlop={8} style={styles.igIconBtn} onPress={() => copy("tok", shown.token)}
                    accessibilityLabel="Copy token">
                    <Icon name={copied === "tok" ? "check" : "copy"} size={16} color={t.accent} />
                  </TouchableOpacity>
                </View>
                <TouchableOpacity testID="intake-copy-curl" onPress={() => copy("curl", curl(c, shown.token))}>
                  <Text style={styles.igLink}>{copied === "curl" ? "Copied" : "Copy a test command (curl)"}</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            <View style={[styles.rowCenter, { marginTop: 6 }]}>
              <Text style={[styles.igHint, styles.flex1]}>
                Also receives my in-app feedback{c.app_feedback ? " · cards land in its board's Feedback column" : ""}
              </Text>
              <Switch testID={`intake-feedback-${c.id}`} value={c.app_feedback} disabled={!!busy}
                trackColor={{ true: t.accent, false: t.border }}
                onValueChange={() => { run(`fb:${c.id}`, () => api.intakeUpdate({ id: c.id, app_feedback: !c.app_feedback })) }} />
            </View>
          </View>
        ))}
        {draft ? (
          <View testID="intake-new" style={[styles.igSection, !!channels?.length && styles.igHairTop]}>
            <TextInput testID="intake-new-name" autoFocus style={styles.ssInput} value={draft.name}
              onChangeText={(name) => setDraft({ ...draft, name })}
              placeholder="What feeds it, e.g. Website contact form" placeholderTextColor={t.textMuted} />
            <TouchableOpacity testID="intake-new-project" style={[styles.rowCenter, { paddingVertical: 8 }]}
              onPress={() => showActions("Which board do its cards land on?",
                projects.map((p) => ({ text: p.name, onPress: () => setDraft((d) => d && { ...d, project: p }) })))}>
              <Text style={[styles.ssRowLabel, styles.flex1]}>{draft.project ? `Board: ${draft.project.name}` : "Pick a board…"}</Text>
              <Icon name="chevronRight" size={14} color={t.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity testID="intake-new-session" style={[styles.rowCenter, { paddingVertical: 8 }]}
              onPress={() => pickSession("Which chat should each post wake?", (s) => setDraft((d) => d && { ...d, session: s }))}>
              <Text style={[styles.ssRowLabel, styles.flex1]}>
                {draft.session ? `Wakes: ${draft.session.title || draft.session.id.slice(0, 8)}` : "Wakes nobody (you get a push)"}
              </Text>
              <Icon name="chevronRight" size={14} color={t.textMuted} />
            </TouchableOpacity>
            <View style={[styles.rowCenter, { paddingVertical: 4 }]}>
              <Text style={[styles.igHint, styles.flex1]}>Also send my in-app feedback here</Text>
              <Switch testID="intake-new-feedback" value={draft.feedback} trackColor={{ true: t.accent, false: t.border }}
                onValueChange={(feedback) => setDraft({ ...draft, feedback })} />
            </View>
            <View style={[styles.rowCenter, { gap: 16, marginTop: 8 }]}>
              <TouchableOpacity testID="intake-new-create" disabled={!!busy || !draft.name.trim() || !draft.project}
                style={[styles.ssAddBtn, (!!busy || !draft.name.trim() || !draft.project) && styles.faded]} onPress={create}>
                {busy === "new" ? <ActivityIndicator /> : <Text style={styles.ssAddBtnText}>Create</Text>}
              </TouchableOpacity>
              <TouchableOpacity testID="intake-new-cancel" onPress={() => setDraft(null)}>
                <Text style={styles.igLink}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity testID="intake-new-open" disabled={!!busy || channels === null}
            onPress={() => setDraft({ name: "", project: null, session: null, feedback: false })}
            style={[styles.igFolderRow, styles.igFolderAdd, !!channels?.length && styles.igHairTop]}>
            <Icon name="plus" size={16} color={t.accent} />
            <Text style={[styles.igLink, styles.igLinkLarge]}>New channel</Text>
          </TouchableOpacity>
        )}
      </View>
      {error ? <Text testID="intake-error" style={[styles.sheetHint, { color: t.danger }]}>{error}</Text> : null}
    </View>
  )
}
