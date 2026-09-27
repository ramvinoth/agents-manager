import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import { useHeaderHeight } from "@react-navigation/elements"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, isQueued, type Note, type NoteKind } from "../api/client"
import { KIND_LABEL } from "../lib/notes"
import { formatActor } from "../lib/board"
import { setToken, username } from "../state/config"
import Icon from "../components/Icon"
import Markdown from "../components/Markdown"
import { useTheme } from "../lib/useTheme"

type Props = NativeStackScreenProps<RootStackParamList, "NoteEditor">

const SAVE_DEBOUNCE_MS = 700

/**
 * NoteEditorScreen — one note, open. Title + markdown body with autosave
 * (debounced, last-write-wins on the server's updated_at), a Preview toggle
 * that renders the body through the app's ONE markdown renderer, a kind
 * chip row (the note's template), pin, archive and delete in the header menu.
 *
 * Autosave, not a Save button: a note is a thought in progress; the owner
 * leaves the screen the moment the thought is down, and losing it would be
 * the one unforgivable bug. A pending draft is flushed on unmount.
 */
export default function NoteEditorScreen({ route, navigation }: Props) {
  const t = useTheme()
  const headerHeight = useHeaderHeight()
  const id = route.params.id
  const [note, setNote] = useState<Note | null>(null)
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [preview, setPreview] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const draft = useRef<{ title?: string; body?: string }>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(async () => {
    const pending = draft.current
    draft.current = {}
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (pending.title === undefined && pending.body === undefined) return
    setSaving(true)
    try {
      const n = await api.orgUpdateNote({ note_id: id, ...pending })
      setNote(n)
      setError("")
    } catch (e) {
      // Put the unsaved text back so the next keystroke retries it.
      draft.current = { ...pending, ...draft.current }
      setError("Not saved yet — will retry as you type.")
    } finally {
      setSaving(false)
    }
  }, [id])

  const queue = useCallback((patch: { title?: string; body?: string }) => {
    draft.current = { ...draft.current, ...patch }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }, [flush])

  useEffect(() => {
    let alive = true
    api.orgNote(id).then((r) => {
      if (!alive) return
      setNote(r.note); setTitle(r.note.title); setBody(r.note.body); setLoading(false)
    }).catch((err) => {
      if (!alive) return
      const e = err as Error & { status?: number }
      if (e.status === 401) { setToken(null); navigation.replace("Login"); return }
      setError(e.status === 404 ? "This note was removed." : e.message || "Could not open this note")
      setLoading(false)
    })
    return () => { alive = false; flush() }
  }, [id, navigation, flush])

  const patchNote = useCallback(async (fields: { kind?: NoteKind; pinned?: boolean; archived?: boolean }) => {
    if (!note) return
    const prev = note
    setNote({ ...note, ...fields })
    try {
      setNote(await api.orgUpdateNote({ note_id: id, ...fields }))
    } catch (e) {
      setNote(prev)
      Alert.alert("Could not update note", (e as Error).message)
    }
  }, [id, note])

  const remove = useCallback(() => {
    Alert.alert("Delete this note?", "This cannot be undone. Archiving keeps it on the shelf instead.", [
      { text: "Cancel", style: "cancel" },
      { text: "Archive instead", onPress: () => { patchNote({ archived: true }); navigation.goBack() } },
      { text: "Delete", style: "destructive", onPress: async () => {
        try {
          const r = await api.orgDeleteNote({ note_id: id })
          if (isQueued(r)) { Alert.alert("Queued for approval", "Deleting is irreversible, so the owner has to approve it."); return }
          navigation.goBack()
        } catch (e) { Alert.alert("Could not delete", (e as Error).message) }
      } },
    ])
  }, [id, navigation, patchNote])

  useEffect(() => {
    navigation.setOptions({
      title: KIND_LABEL[note?.kind || "note"],
      headerRight: () => (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
          <TouchableOpacity testID="note-preview" onPress={() => setPreview((v) => !v)} hitSlop={8}
            style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}>
            <Icon name="eye" size={20} color={preview ? t.accent : t.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity testID="note-pin" onPress={() => patchNote({ pinned: !note?.pinned })} hitSlop={8}
            style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}>
            <Icon name="pin" size={20} color={note?.pinned ? t.accent : t.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity testID="note-more" onPress={() => Alert.alert("", "", [
            { text: note?.archived ? "Unarchive" : "Archive", onPress: () => { patchNote({ archived: !note?.archived }); navigation.goBack() } },
            { text: "Delete", style: "destructive", onPress: remove },
            { text: "Cancel", style: "cancel" },
          ])} hitSlop={8} style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}>
            <Icon name="more" size={20} color={t.accent} />
          </TouchableOpacity>
        </View>
      ),
    })
  }, [navigation, note, preview, t.accent, t.textMuted, patchNote, remove])

  if (loading) return <ActivityIndicator style={{ marginTop: 40 }} color={t.accent} />
  if (!note) return <Text style={{ color: t.danger, padding: 20 }}>{error || "This note is unavailable."}</Text>

  const who = formatActor(note.created_by, username())
  const kinds = Object.keys(KIND_LABEL) as NoteKind[]

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <TextInput
          testID="note-title"
          style={{ color: t.text, fontSize: 24, fontWeight: "700", paddingVertical: 4 }}
          placeholder="Title"
          placeholderTextColor={t.textMuted}
          value={title}
          onChangeText={(v) => { setTitle(v); queue({ title: v }) }}
          returnKeyType="next"
        />
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginVertical: 8 }}>
          {kinds.map((k) => (
            <TouchableOpacity key={k} testID={`note-kind-${k}`} onPress={() => patchNote({ kind: k })}
              style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: note.kind === k ? t.accent : t.chipBg }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: note.kind === k ? "#fff" : t.textMuted }}>{KIND_LABEL[k]}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: 10 }}>
          {who.kind === "you" ? "You" : who.kind === "agent" ? `Agent ${who.name}` : who.name} · {note.archived ? "archived · " : ""}
          {saving ? "saving…" : error ? error : `edited ${new Date(note.updated_at * 1000).toLocaleString()}`}
        </Text>
        {preview ? (
          <Markdown text={body || "_Nothing here yet._"} color={t.text} selectable />
        ) : (
          <TextInput
            testID="note-body"
            style={{ color: t.text, fontSize: 16, lineHeight: 24, minHeight: 300, textAlignVertical: "top" }}
            placeholder="Write in markdown — # headings, - lists, - [ ] checkboxes, **bold**"
            placeholderTextColor={t.textMuted}
            value={body}
            onChangeText={(v) => { setBody(v); queue({ body: v }) }}
            multiline
            scrollEnabled={false}
            autoFocus={!body}
          />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
