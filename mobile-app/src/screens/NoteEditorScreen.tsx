import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import { useHeaderHeight } from "@react-navigation/elements"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, isQueued, type Note, type NoteKind } from "../api/client"
import { KIND_LABEL } from "../lib/notes"
import { formatActor } from "../lib/board"
import { setToken, username } from "../state/config"
import HeaderButton from "../components/HeaderButton"
import Markdown, { type NoteLinkHandlers } from "../components/Markdown"
import NoteThread from "../components/NoteThread"
import { completeLink, neighbours, openLinkQuery, resolveLink, suggestTitles, type NoteGraph } from "../lib/noteLinks"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
import { userError } from "../lib/errors"
import { offerUndo } from "../lib/undo"
import { showActions } from "../lib/actionSheet"
import { exportNote } from "../lib/noteExportNative"

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
  const styles = useStyles()
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
  const [exporting, setExporting] = useState("")   // "Preparing PDF…" while the server renders
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
      setFlash(userError(e, "the note", "create"))
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
      setError(e.status === 404 ? "This note was removed." : userError(e, "the note", "open"))
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
      setFlash(userError(e, "the note", "save"))
    }
  }, [id, note])

  // Archiving is a flip, so it happens at once with an Undo (lib/undo.ts).
  const archive = useCallback(() => {
    const to = !note?.archived
    patchNote({ archived: to })
    navigation.goBack()
    offerUndo({
      label: to ? "Note archived" : "Note unarchived",
      undo: () => { api.orgUpdateNote({ note_id: id, archived: !to }).catch(() => {}) },
    })
  }, [id, note?.archived, navigation, patchNote])

  const remove = useCallback(() => {
    Alert.alert("Delete this note?", "This cannot be undone. Archiving keeps it on the shelf instead.", [
      { text: "Cancel", style: "cancel" },
      { text: "Archive instead", onPress: archive },
      { text: "Delete", style: "destructive", onPress: async () => {
        try {
          const r = await api.orgDeleteNote({ note_id: id })
          if (isQueued(r)) { setFlash("Deletion is waiting for the owner's approval. The note stays until then."); return }
          navigation.goBack()
        } catch (e) { setFlash(userError(e, "the note", "delete")) }
      } },
    ])
  }, [id, navigation, archive])

  useEffect(() => {
    navigation.setOptions({
      title: KIND_LABEL[note?.kind || "note"],
      headerRight: () => (
        <View style={styles.headerIcons}>
          {/* Shows the mode you'd switch TO: a pencil while reading, an eye while editing. */}
          <HeaderButton testID="note-preview" label={preview ? "Edit note" : "Preview note"} icon={preview ? "edit" : "eye"} color={t.accent}
            onPress={() => setPreview((v) => !v)} />
          <HeaderButton testID="note-pin" label={note?.pinned ? "Unpin note" : "Pin note"} icon="pin" color={note?.pinned ? t.accent : t.textMuted}
            onPress={() => patchNote({ pinned: !note?.pinned })} />
          <HeaderButton testID="note-more" label="Note actions" icon="more" color={t.accent}
            onPress={() => showActions(note?.title || "This note", [
              { text: "Export…", onPress: () => { if (!exporting) exportNote({ id, title: note?.title || "" }, setFlash, setExporting, flush) } },
              { text: note?.archived ? "Unarchive" : "Archive", onPress: archive },
              { text: "Delete", destructive: true, onPress: remove },
            ])} />
        </View>
      ),
    })
  }, [navigation, id, note, preview, exporting, t.accent, t.textMuted, patchNote, remove, archive, flush])

  if (loading) return <ActivityIndicator style={{ marginTop: 40 }} color={t.accent} />
  if (!note) return <Text style={styles.neMissing}>{error || "This note is unavailable."}</Text>

  const who = formatActor(note.created_by, username())
  const kinds = Object.keys(KIND_LABEL) as NoteKind[]

  return (
    <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
      <ScrollView contentContainerStyle={styles.neContent} keyboardShouldPersistTaps="handled">
        <TextInput
          testID="note-title"
          style={styles.neTitle}
          placeholder="Title"
          placeholderTextColor={t.textMuted}
          value={title}
          onChangeText={(v) => { setTitle(v); queue({ title: v }) }}
          returnKeyType="next"
        />
        <View style={styles.neKinds}>
          {kinds.map((k) => (
            <TouchableOpacity key={k} testID={`note-kind-${k}`} onPress={() => patchNote({ kind: k })}
              style={[styles.nePill, note.kind === k && styles.nePillActive]}>
              <Text style={[styles.neKindText, note.kind === k && styles.neKindTextActive]}>{KIND_LABEL[k]}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.neMeta}>
          {who.kind === "you" ? "You" : who.kind === "agent" ? `Agent ${who.name}` : who.name} · {note.archived ? "archived · " : ""}
          {saving ? "saving…" : error ? error : `edited ${new Date(note.updated_at * 1000).toLocaleString()}`}
        </Text>
        {exporting ? (
          <View testID="note-exporting" style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <ActivityIndicator size="small" color={t.accent} />
            <Text style={[styles.neFlash, { marginBottom: 0 }]}>{exporting}</Text>
          </View>
        ) : flash ? <Text style={styles.neFlash}>{flash}</Text> : null}
        {suggestions.length ? (
          <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false}
            style={styles.neSuggestRow} contentContainerStyle={styles.cdChips}>
            {suggestions.map((s) => (
              <TouchableOpacity key={s} testID={`note-suggest-${s}`} onPress={() => pickSuggestion(s)}
                style={styles.neSuggest}>
                <Text style={styles.neLinkText}>{s}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : null}
        {preview ? (
          <Markdown text={body || "_Nothing here yet._"} color={t.text} selectable notes={links} />
        ) : (
          <TextInput
            testID="note-body"
            style={styles.neBody}
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
          <View testID="note-links" style={styles.neLinks}>
            {near.backlinks.length ? (
              <Text style={styles.neLinksLabel}>
                LINKED FROM {near.backlinks.length} NOTE{near.backlinks.length === 1 ? "" : "S"}
              </Text>
            ) : null}
            {near.backlinks.map((b, i) => (
              <TouchableOpacity key={`b${i}`} onPress={() => navigation.push("NoteEditor", { id: b.source })} style={styles.neBacklink}>
                <Text style={styles.neLinkText}>{b.title || "Untitled"}</Text>
                {b.context ? <Text style={styles.neBacklinkContext} numberOfLines={2}>{b.context}</Text> : null}
              </TouchableOpacity>
            ))}
            {near.links.length || near.ghosts.length ? (
              <View style={styles.neOutLinks}>
                <Text style={styles.neLinksLabel}>LINKS TO</Text>
                {near.links.map((l, i) => (
                  <TouchableOpacity key={`l${i}`} onPress={() => navigation.push("NoteEditor", { id: l.target })}
                    style={styles.nePill}>
                    <Text style={styles.neOutLinkText}>{l.title || "Untitled"}{l.heading ? ` › ${l.heading}` : ""}</Text>
                  </TouchableOpacity>
                ))}
                {near.ghosts.map((g) => (
                  <TouchableOpacity key={`g${g}`} onPress={() => void follow(g)} accessibilityHint="Not written yet — tap to create"
                    style={styles.neGhost}>
                    <Text style={styles.neGhostText}>{g} +</Text>
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
