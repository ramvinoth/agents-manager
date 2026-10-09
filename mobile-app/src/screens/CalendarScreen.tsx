import React, { useCallback, useMemo, useState } from "react"
import { ActivityIndicator, Linking, Platform, RefreshControl, SectionList, Switch, Text, TextInput, TouchableOpacity, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import DateTimePicker from "@react-native-community/datetimepicker"
import type { RootStackParamList } from "../../App"
import { api, type CalendarEvent } from "../api/client"
import { agenda, calendarAccounts, draftOf, draftProblem, fieldsOf, isoLocal, newDraft, timeLabel, type CalendarAccount, type EventDraft } from "../lib/calendar"
import { useScreenHeader } from "../lib/useScreenHeader"
import { userError } from "../lib/errors"
import { offerUndo } from "../lib/undo"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"
import SheetModal from "../components/SheetModal"
import { useStyles } from "../lib/styles"

const DAYS = 14

/**
 * Calendar — the owner's Google Calendar, the same events agents read to plan
 * around. An agenda of the next two weeks; tap an event to edit or delete it,
 * "+" to add one. Edits never email guests (the server sends sendUpdates=none).
 * Accounts and permissions come from Integrations: with no calendar switched on
 * the screen says so and links there; an account granted read-only offers
 * "Allow editing", which is a grant made on the Integrations screen.
 */
export default function CalendarScreen({ navigation }: { navigation: NativeStackNavigationProp<RootStackParamList, "Calendar"> }) {
  const styles = useStyles()
  const t = useTheme()
  const [accounts, setAccounts] = useState<CalendarAccount[] | null>(null)
  const [picked, setPicked] = useState<string>("")
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [draft, setDraft] = useState<EventDraft | null>(null)
  const account = accounts?.find((a) => a.id === picked) || accounts?.[0]

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const acc = calendarAccounts(await api.integrations())
      setAccounts(acc)
      const use = acc.find((a) => a.id === picked) || acc[0]
      if (!use) { setEvents([]); return }
      const now = new Date()
      const from = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + DAYS)
      setEvents((await api.calendarEvents({ start: isoLocal(from), end: isoLocal(to), connection: use.id })).events)
    } catch (e) {
      setError(userError(e, "your calendar"))
    } finally {
      setLoading(false)
    }
  }, [picked])

  useFocusEffect(useCallback(() => { load() }, [load]))

  useScreenHeader(navigation, () => ({
    title: "Calendar",
    headerLeft: undefined,
    headerRight: account?.edit
      ? () => (
        <TouchableOpacity testID="calendar-add" accessibilityLabel="New event" onPress={() => setDraft(newDraft(new Date()))} hitSlop={8} style={{ padding: 4 }}>
          <Icon name="plus" size={24} color={t.accent} />
        </TouchableOpacity>
      )
      : () => null,
  }), [account?.edit, t.accent])

  const sections = useMemo(() => agenda(events, new Date()).map((d) => ({ title: d.label, key: d.day, data: d.events })), [events])

  async function save(d: EventDraft) {
    if (!account) return
    const fields = fieldsOf(d)
    if (d.id) await api.calendarUpdate(d.id, fields, account.id)
    else await api.calendarCreate(fields, account.id)
    setDraft(null)
    await load()
  }

  // Instant with Undo (lib/undo.ts): the event leaves the agenda now and the
  // Google delete runs when the window closes. Guests are not emailed.
  function remove(d: EventDraft) {
    if (!account || !d.id) return
    const id = d.id, conn = account.id
    setDraft(null)
    setEvents((all) => all.filter((e) => e.id !== id))
    offerUndo({
      label: `"${d.title || "(no title)"}" deleted`,
      undo: () => { load() },
      commit: async () => {
        try { await api.calendarDelete(id, conn) }
        catch (e) { await load(); setError(userError(e, "this event", "delete")) } // after the reload, which clears errors
      },
    })
  }

  const toIntegrations = () => navigation.navigate("Integrations")
  const link = { color: t.accent, fontSize: 14, fontWeight: "600" as const }

  if (accounts === null) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, padding: 18 }}>
        {error ? (
          <>
            <Text testID="calendar-error" style={styles.error}>{error}</Text>
            <TouchableOpacity onPress={load} style={{ marginTop: 12 }}><Text style={link}>Try again</Text></TouchableOpacity>
          </>
        ) : <ActivityIndicator />}
      </View>
    )
  }

  if (!account) {
    return (
      <View testID="calendar-empty" style={{ flex: 1, backgroundColor: t.bg, padding: 24, alignItems: "center", justifyContent: "center", gap: 12 }}>
        <Icon name="clock" size={40} color={t.textMuted} />
        <Text style={[styles.sheetTitle, { textAlign: "center" }]}>No calendar connected</Text>
        <Text style={[styles.ssRowHint, { textAlign: "center", maxWidth: 300 }]}>
          Connect Google Calendar so you and your agents can see your day and plan around it.
        </Text>
        <TouchableOpacity testID="calendar-connect" onPress={toIntegrations} style={styles.ssAddBtn}>
          <Text style={styles.ssAddBtnText}>Open Integrations</Text>
        </TouchableOpacity>
      </View>
    )
  }

  return (
    <View style={styles.page}>
      {accounts.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 18, paddingTop: 10 }}>
          {accounts.map((a) => (
            <TouchableOpacity key={a.id} testID={`calendar-account-${a.id}`} onPress={() => setPicked(a.id)}
              style={[styles.filterChip, a.id === account.id && styles.filterChipActive]}>
              <Text style={[styles.filterChipText, a.id === account.id && styles.filterChipTextActive]}>{a.account || a.id}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      {!account.edit ? (
        <TouchableOpacity testID="calendar-allow-edit" onPress={toIntegrations} style={{ paddingHorizontal: 18, paddingTop: 10 }}>
          <Text style={styles.ssRowHint}>Read-only. <Text style={{ color: t.accent, fontWeight: "600" }}>Allow editing in Integrations</Text></Text>
        </TouchableOpacity>
      ) : null}
      {error ? <Text testID="calendar-error" style={[styles.error, { paddingHorizontal: 18, marginTop: 10 }]}>{error}</Text> : null}
      <SectionList
        testID="calendar-list"
        sections={sections}
        keyExtractor={(e) => e.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        contentContainerStyle={{ paddingBottom: 40 }}
        stickySectionHeadersEnabled
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sheetSection, { backgroundColor: t.bg, marginTop: 0, paddingTop: 14, paddingBottom: 6 }]}>{section.title.toUpperCase()}</Text>
        )}
        renderItem={({ item }) => (
          <TouchableOpacity testID={`event-${item.id}`} onPress={() => setDraft(draftOf(item))} style={{ flexDirection: "row", paddingHorizontal: 18, paddingVertical: 10, gap: 12 }}>
            <View style={{ width: 4, borderRadius: 2, backgroundColor: item.all_day ? t.textMuted : t.accent }} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.ssRowLabel, { fontSize: 15 }]} numberOfLines={2}>{item.title}</Text>
              <Text style={styles.ssRowHint}>{timeLabel(item)}{item.location ? ` · ${item.location}` : ""}</Text>
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={loading ? null : (
          <Text testID="calendar-none" style={[styles.ssRowHint, { textAlign: "center", marginTop: 40, maxWidth: undefined }]}>
            Nothing in the next {DAYS} days.
          </Text>
        )}
      />
      <EventSheet
        draft={draft}
        editable={account.edit}
        event={events.find((e) => e.id === draft?.id)}
        onClose={() => setDraft(null)}
        onSave={save}
        onDelete={remove}
      />
    </View>
  )
}

/** Edit (or, read-only, view) one event. Attendees are shown, never edited:
 *  agents and this screen never email guests. */
function EventSheet({ draft, editable, event, onClose, onSave, onDelete }: {
  draft: EventDraft | null
  editable: boolean
  event?: CalendarEvent
  onClose: () => void
  onSave: (d: EventDraft) => Promise<void>
  onDelete: (d: EventDraft) => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const [d, setD] = useState<EventDraft | null>(draft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [shown, setShown] = useState<EventDraft | null>(null)
  if (draft !== shown) { setShown(draft); setD(draft); setError("") } // a new event opened: reset the form
  if (!d) return <SheetModal visible={false} onClose={onClose}>{null}</SheetModal>

  const problem = draftProblem(d)
  const pick = (key: "start" | "end") => (_: unknown, v?: Date) => {
    if (!v) return
    const next = { ...d, [key]: v }
    // Moving the start keeps the length, as every calendar app does.
    if (key === "start") next.end = new Date(d.end.getTime() + (v.getTime() - d.start.getTime()))
    setD(next)
  }
  async function submit() {
    setSaving(true)
    setError("")
    try { await onSave(d!) } catch (e) { setError(userError(e, "this event")) } finally { setSaving(false) }
  }
  const field = { color: t.textMuted, fontSize: 12, marginTop: 8 }
  return (
    <SheetModal visible={!!draft} onClose={onClose}>
      <View testID="event-sheet" style={{ paddingHorizontal: 18, paddingBottom: 24, gap: 6 }}>
        <Text style={styles.sheetTitle}>{d.id ? (editable ? "Edit event" : "Event") : "New event"}</Text>
        <TextInput testID="event-title" style={styles.ssInput} value={d.title} editable={editable} placeholder="Title"
          placeholderTextColor={t.textMuted} onChangeText={(title) => setD({ ...d, title })} />
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 6 }}>
          <Text style={[styles.ssRowLabel, { flex: 1 }]}>All day</Text>
          <Switch testID="event-all-day" value={d.all_day} disabled={!editable} onValueChange={(all_day) => setD({ ...d, all_day })}
            trackColor={{ true: t.accent, false: t.border }} />
        </View>
        {(["start", "end"] as const).map((k) => (
          <View key={k} style={{ flexDirection: "row", alignItems: "center" }}>
            <Text style={[styles.ssRowLabel, { flex: 1 }]}>{k === "start" ? "Starts" : "Ends"}</Text>
            <DateTimePicker testID={`event-${k}`} value={d[k]} mode={d.all_day ? "date" : "datetime"} disabled={!editable}
              display={Platform.OS === "ios" ? "compact" : "default"} minuteInterval={5} onChange={pick(k)} textColor={t.text} />
          </View>
        ))}
        <Text style={field}>LOCATION</Text>
        <TextInput testID="event-location" style={styles.ssInput} value={d.location} editable={editable} placeholder="Optional"
          placeholderTextColor={t.textMuted} onChangeText={(location) => setD({ ...d, location })} />
        <Text style={field}>NOTES</Text>
        <TextInput testID="event-description" style={[styles.ssInput, { minHeight: 60 }]} value={d.description} editable={editable}
          multiline placeholder="Optional" placeholderTextColor={t.textMuted} onChangeText={(description) => setD({ ...d, description })} />
        {event?.attendees.length ? <Text style={styles.ssRowHint}>Guests: {event.attendees.join(", ")}</Text> : null}
        {event?.link ? (
          <TouchableOpacity onPress={() => Linking.openURL(event.link)}><Text style={{ color: t.accent, fontSize: 13, fontWeight: "600" }}>Open in Google Calendar</Text></TouchableOpacity>
        ) : null}
        {problem || error ? <Text testID="event-error" style={styles.error}>{problem || error}</Text> : null}
        {editable ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 8 }}>
            <TouchableOpacity testID="event-save" style={[styles.ssAddBtn, { opacity: problem || saving ? 0.5 : 1 }]} disabled={!!problem || saving} onPress={submit}>
              <Text style={styles.ssAddBtnText}>{saving ? "Saving…" : "Save"}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose}><Text style={{ color: t.textMuted, fontSize: 13, fontWeight: "600" }}>Cancel</Text></TouchableOpacity>
            <View style={{ flex: 1 }} />
            {d.id ? (
              <TouchableOpacity testID="event-delete" onPress={() => onDelete(d)} hitSlop={8}><Icon name="trash" size={20} color={t.danger} /></TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
    </SheetModal>
  )
}
