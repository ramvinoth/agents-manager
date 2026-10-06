import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import { useHeaderHeight } from "@react-navigation/elements"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, isQueued, type Note, type NoteKind } from "../api/client"
import { KIND_LABEL } from "../lib/notes"
import { formatActor } from "../lib/board"
import { setToken, username } from "../state/config"
import Icon from "../components/Icon"
import Markdown, { type NoteLinkHandlers } from "../components/Markdown"
import NoteThread from "../components/NoteThread"
import { completeLink, neighbours, openLinkQuery, resolveLink, suggestTitles, type NoteGraph } from "../lib/noteLinks"
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
 *
 * Notes link like an Obsidian vault. While reading, a [[link]] opens its note
 * (pushed, so Back retraces the trail) or — dashed, not written yet — creates
 * it; a #tag opens the notes carrying it. While writing, `[[` offers titles.
 * Under the body: the notes that link here, what this one links to, and the
 * note's discussion thread (components/NoteThread).
 */
export default function NoteEditorScreen({ route, navigation }: Props) {
  const t = useTheme()
  const headerHeight = useHeaderHeight()
  const id = route.params.id
  const [note, setNote] = useState<Note | null>(null)
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  // A note with content opens for reading; an empty one opens ready to type.
  const [preview, setPreview] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [graph, setGraph] = useState<NoteGraph | null>(null)
  const [caret, setCaret] = useState(0)
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined)
  const [flash, setFlash] = useState("")
  const draft = useRef<{ title?: string; body?: string }>({})
  const projectId = note?.project_id ?? null
  const hasNote = !!note

  // The project graph: what [[links]] resolve to, and who links here.
  const refreshGraph = useCallback(() => {
    if (!hasNote) return
    api.orgNotesGraph(projectId).then(setGraph).catch(() => { /* links stay plain until the next save */ })
  }, [projectId, hasNote])
  useEffect(refreshGraph, [refreshGraph])
  // flush() reads it through a ref: flush must stay stable (its identity drives the load effect).
  const refreshGraphRef = useRef(refreshGraph)
  refreshGraphRef.current = refreshGraph
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
      // A rename may rewrite this note's own links to itself: adopt the stored
      // body unless newer typing is queued.
      if (n.relinked && draft.current.body === undefined) setBody(n.body)
      if (n.relinked) setFlash(`Renamed — updated the links in ${n.relinked} note${n.relinked === 1 ? "" : "s"}.`)
      setError("")
      refreshGraphRef.current()
    } catch (e) {
      // Put the unsaved text back so the next keystroke retries it.
      draft.current = { ...pending, ...draft.current }
      setError("Not saved yet — will retry as you type.")
    } finally {
      setSaving(false)
    }
  }, [id])
  useEffect(() => {
    if (!flash) return
    const tm = setTimeout(() => setFlash(""), 4000)
    return () => clearTimeout(tm)
  }, [flash])

  /** Follow a [[link]]: open its note, or write the note it promises. */
  const follow = useCallback(async (target: string) => {
    const to = resolveLink(graph, projectId, target)
    if (to === id) return
    if (to != null) { navigation.push("NoteEditor", { id: to }); return }
    try {
      const n = await api.orgCreateNote({ title: target.trim(), project_id: projectId ?? undefined })
      refreshGraph()
      navigation.push("NoteEditor", { id: n.id })
    } catch (e) {
      Alert.alert("Could not create note", (e as Error).message)
    }
  }, [graph, projectId, id, navigation, refreshGraph])

  const links = useMemo<NoteLinkHandlers>(() => ({
    resolves: (target) => resolveLink(graph, projectId, target) != null,
    onLink: (target) => { void follow(target) },
    onTag: (tag) => navigation.navigate("Notes", { project: projectId ?? undefined, tag, title: `#${tag}` }),
  }), [graph, projectId, follow, navigation])

  const near = useMemo(() => neighbours(graph, id), [graph, id])
  const titles = useMemo(() => (graph?.nodes || []).filter((n) => !n.archived).map((n) => n.title), [graph])
  const open = preview ? null : openLinkQuery(body, caret)
  const suggestions = open ? suggestTitles(titles, open.query, 6, title) : []

  function pickSuggestion(tt: string) {
    if (!open) return
    const r = completeLink(body, open.start, caret, tt)
    setBody(r.text)
    queue({ body: r.text })
    setCaret(r.caret)
    setSelection({ start: r.caret, end: r.caret })
  }

  const queue = useCallback((patch: { title?: string; body?: string }) => {
    draft.current = { ...draft.current, ...patch }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }, [flush])

  useEffect(() => {
    let alive = true
    api.orgNote(id).then((r) => {
      if (!alive) return
      setNote(r.note); setTitle(r.note.title); setBody(r.note.body); setPreview(!!r.note.body.trim()); setLoading(false)
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
          {/* Shows the mode you'd switch TO: a pencil while reading, an eye while editing. */}
          <TouchableOpacity testID="note-preview" accessibilityLabel={preview ? "edit-note" : "view-note"}
            onPress={() => setPreview((v) => !v)} hitSlop={8}
            style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}>
            <Icon name={preview ? "edit" : "eye"} size={20} color={t.accent} />
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
              <Text style={{ fontSize: 12, fontWeight: "600", color: note.kind === k ? t.onAccent : t.textMuted }}>{KIND_LABEL[k]}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: 10 }}>
          {who.kind === "you" ? "You" : who.kind === "agent" ? `Agent ${who.name}` : who.name} · {note.archived ? "archived · " : ""}
          {saving ? "saving…" : error ? error : `edited ${new Date(note.updated_at * 1000).toLocaleString()}`}
        </Text>
        {flash ? <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: 8 }}>{flash}</Text> : null}
        {suggestions.length ? (
          <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false}
            style={{ marginBottom: 8 }} contentContainerStyle={{ gap: 6 }}>
            {suggestions.map((s) => (
              <TouchableOpacity key={s} testID={`note-suggest-${s}`} onPress={() => pickSuggestion(s)}
                style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, backgroundColor: t.chipBg }}>
                <Text style={{ color: t.accent, fontWeight: "600" }}>{s}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : null}
        {preview ? (
          <Markdown text={body || "_Nothing here yet._"} color={t.text} selectable notes={links} />
        ) : (
          <TextInput
            testID="note-body"
            style={{ color: t.text, fontSize: 16, lineHeight: 24, minHeight: 300, textAlignVertical: "top" }}
            placeholder="Write in markdown — # headings, - lists, **bold**. Type [[ to link a note, #tag to group notes."
            placeholderTextColor={t.textMuted}
            value={body}
            selection={selection}
            onSelectionChange={(e) => { setCaret(e.nativeEvent.selection.end); setSelection(undefined) }}
            onChangeText={(v) => { setBody(v); queue({ body: v }) }}
            multiline
            scrollEnabled={false}
            autoFocus={!body}
          />
        )}
        {near.backlinks.length || near.links.length || near.ghosts.length ? (
          <View testID="note-links" style={{ marginTop: 24, borderTopWidth: 1, borderTopColor: t.border, paddingTop: 12, gap: 6 }}>
            {near.backlinks.length ? (
              <Text style={{ color: t.textMuted, fontSize: 12, fontWeight: "600" }}>
                LINKED FROM {near.backlinks.length} NOTE{near.backlinks.length === 1 ? "" : "S"}
              </Text>
            ) : null}
            {near.backlinks.map((b, i) => (
              <TouchableOpacity key={`b${i}`} onPress={() => navigation.push("NoteEditor", { id: b.source })} style={{ paddingVertical: 4 }}>
                <Text style={{ color: t.accent, fontWeight: "600" }}>{b.title || "Untitled"}</Text>
                {b.context ? <Text style={{ color: t.textMuted, fontSize: 13 }} numberOfLines={2}>{b.context}</Text> : null}
              </TouchableOpacity>
            ))}
            {near.links.length || near.ghosts.length ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 6 }}>
                <Text style={{ color: t.textMuted, fontSize: 12, fontWeight: "600" }}>LINKS TO</Text>
                {near.links.map((l, i) => (
                  <TouchableOpacity key={`l${i}`} onPress={() => navigation.push("NoteEditor", { id: l.target })}
                    style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: t.chipBg }}>
                    <Text style={{ color: t.accent, fontSize: 13 }}>{l.title || "Untitled"}{l.heading ? ` › ${l.heading}` : ""}</Text>
                  </TouchableOpacity>
                ))}
                {near.ghosts.map((g) => (
                  <TouchableOpacity key={`g${g}`} onPress={() => void follow(g)} accessibilityHint="Not written yet — tap to create"
                    style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderStyle: "dashed", borderColor: t.border }}>
                    <Text style={{ color: t.textMuted, fontSize: 13 }}>{g} +</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
        <NoteThread noteId={note.id} />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
