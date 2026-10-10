import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Alert, FlatList, RefreshControl, Text, TextInput, TouchableOpacity, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import { useScreenHeader } from "../lib/useScreenHeader"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, isQueued, type Note, type NoteFilter } from "../api/client"
import { KIND_LABEL, displayTitle, groupNotesByProject, noteTemplates, notesScopeFilter, orderNotes, previewLine, searchNotes } from "../lib/notes"
import { formatActor } from "../lib/board"
import { fmtWaiting } from "../lib/decisions"
import { setToken, username } from "../state/config"
import * as FileSystem from "expo-file-system"
import * as Sharing from "expo-sharing"
import { filterByTags, type NoteGraph } from "../lib/noteLinks"
import Icon from "../components/Icon"
import HeaderButton from "../components/HeaderButton"
import SheetModal from "../components/SheetModal"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
import { userError } from "../lib/errors"
import { offerUndo } from "../lib/undo"
import { showActions } from "../lib/actionSheet"
import { exportNote } from "../lib/noteExportNative"

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList>
  /** Scope of this view: a chat's notes, a project's, or (from the side menu) everything. */
  filter?: NoteFilter
  title?: string
  /** Open already filtered to this #tag (a tag tapped inside a note). */
  tag?: string
}

/**
 * NotesScreen — the org's ONE notes ledger rendered as a filtered VIEW, like
 * the board: the side menu's Notes shows every note, a chat's header menu opens that
 * chat's notes, a project row opens the project's. Agents write into the same
 * table through the note_* MCP tools, so what a session researched or decided
 * shows up here beside what the owner typed.
 *
 * List rows carry the kind, a preview and who wrote it; the "+" opens the
 * template picker (blank / journal / meeting / idea / checklist) and pushes
 * the editor. Archived notes (a chat's archive shelves its notes) are one
 * toggle away, never gone. Polls like the board so agent-written notes appear
 * without a manual refresh.
 *
 * Tags written in note bodies (#idea) are chips above the list; tapping some
 * shows only notes carrying all of them. Export saves the notes as an
 * Obsidian vault (.zip of markdown) through the share sheet.
 */
export default function NotesScreen({ navigation, filter, title, tag }: Props) {
  const t = useTheme()
  const styles = useStyles()
  const scope = useMemo(() => notesScopeFilter(filter), [filter])
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  // A failed export/create; kept apart from `error`, which the 8 s poll clears.
  const [actionError, setActionError] = useState("")
  const [query, setQuery] = useState("")
  const [showArchived, setShowArchived] = useState(false)
  const [picking, setPicking] = useState(false)
  const [graph, setGraph] = useState<NoteGraph | null>(null)
  const [tags, setTags] = useState<string[]>(tag ? [tag] : [])
  const [exporting, setExporting] = useState(false)
  const [exportingNote, setExportingNote] = useState("")   // "Preparing PDF…" for a long-press export
  // The unscoped view (side menu) spans projects: grouped like the chat list's Projects view.
  const [projectNames, setProjectNames] = useState<Map<number, string>>(new Map())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const creating = useRef(false)
  const reads = useRef({ issued: 0, applied: 0 })

  const spansProjects = !!scope && scope.project === undefined && scope.session === undefined

  const load = useCallback(async () => {
    if (!scope) { setError("This notes view isn't linked to a chat or project. Go back and open Notes again."); setLoading(false); return }
    const request = ++reads.current.issued
    try {
      const [r, g] = await Promise.all([
        api.orgNotes({ ...scope, archived: showArchived }),
        api.orgNotesGraph(scope.project).catch(() => null),   // tags are extra; the list still shows
      ])
      if (request < reads.current.applied) return
      reads.current.applied = request
      setNotes(r.notes || [])
      if (g) setGraph(g)
      setError("")
    } catch (err) {
      if (request < reads.current.applied) return
      reads.current.applied = request
      const e = err as Error & { status?: number }
      if (e.status === 401) { setToken(null); navigation.replace("Login"); return }
      setError(userError(e, "your notes"))
    } finally {
      setLoading(false)
    }
  }, [scope, showArchived, navigation])

  // Group headers need project names; they change rarely, so read them once (an id stands in on failure).
  useEffect(() => {
    if (!spansProjects) return
    api.orgProjects().then((p) => setProjectNames(new Map(p.projects.map((x) => [x.id, x.name])))).catch(() => {})
  }, [spansProjects])

  useFocusEffect(useCallback(() => {
    load()
    const id = setInterval(load, 8000)
    return () => clearInterval(id)
  }, [load]))

  useScreenHeader(navigation, () => ({
    title: title || "Notes",
    headerLeft: undefined,
    headerRight: () => (
      <HeaderButton testID="notes-add" label="New note" icon="add" size={22} color={t.accent} onPress={() => setPicking(true)} />
    ),
  }), [title, t.accent])

  const shown = useMemo(() => orderNotes(filterByTags(searchNotes(notes, query), graph, tags)), [notes, query, graph, tags])
  // Rows for the list: flat inside one project or chat; grouped by project when the view spans them.
  type Row = { kind: "note"; n: Note } | { kind: "header"; key: string; name: string; count: number; pinned: boolean }
  const rows = useMemo<Row[]>(() => {
    if (!spansProjects) return shown.map((n) => ({ kind: "note", n }))
    const out: Row[] = []
    for (const g of groupNotesByProject(shown, projectNames)) {
      out.push({ kind: "header", key: g.key, name: g.name, count: g.notes.length, pinned: g.pinned })
      if (!collapsed.has(g.key)) for (const n of g.notes) out.push({ kind: "note", n })
    }
    return out
  }, [shown, spansProjects, projectNames, collapsed])
  // Only the tags on notes this view can show (a chat's view, not the whole org's).
  const tagChips = useMemo(() => {
    const here = new Set(notes.map((n) => n.id))
    const counts = new Map<string, number>()
    for (const n of graph?.nodes || []) if (here.has(n.id)) for (const tg of n.tags) counts.set(tg, (counts.get(tg) || 0) + 1)
    for (const tg of tags) if (!counts.has(tg)) counts.set(tg, 0)
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30)
  }, [graph, notes, tags])

  async function exportVault() {
    if (exporting) return
    setExporting(true)
    setActionError("")
    const dest = FileSystem.cacheDirectory + "Harman notes.zip"
    try {
      const status = await api.orgNotesExport(scope?.project, dest)
      if (status >= 400) throw Object.assign(new Error(`HTTP ${status}`), { status })
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(dest, { mimeType: "application/zip", UTI: "public.zip-archive" })
    } catch (e) {
      setActionError(userError(e, "your notes", "export"))
    } finally {
      FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {})
      setExporting(false)
    }
  }

  // Long press on a row: the same Export / Archive / Delete the note's ⋯ menu offers.
  function noteActions(n: Note) {
    setActionError("")
    showActions(displayTitle(n), [
      { text: "Export…", onPress: () => { if (!exportingNote) exportNote({ id: n.id, title: n.title || displayTitle(n) }, setActionError, setExportingNote) } },
      { text: n.archived ? "Unarchive" : "Archive", onPress: () => archiveNote(n) },
      { text: "Delete", destructive: true, onPress: () => deleteNote(n) },
    ])
  }

  // Archive flips this view's shelf, so the row leaves the list at once with an Undo.
  async function archiveNote(n: Note) {
    const to = !n.archived
    setNotes((ns) => ns.filter((x) => x.id !== n.id))
    try {
      await api.orgUpdateNote({ note_id: n.id, archived: to })
      offerUndo({ label: to ? "Note archived" : "Note unarchived", undo: () => { api.orgUpdateNote({ note_id: n.id, archived: !to }).then(load, load) } })
    } catch (e) {
      setActionError(userError(e, "the note", to ? "archive" : "unarchive"))
      load()
    }
  }

  // A delete may queue for the owner's approval, so it confirms instead of offering Undo (lib/undo.ts).
  function deleteNote(n: Note) {
    Alert.alert(`Delete "${displayTitle(n)}"?`, "This cannot be undone. Archiving keeps it on the shelf instead.", [
      { text: "Cancel", style: "cancel" },
      ...(n.archived ? [] : [{ text: "Archive instead", onPress: () => { archiveNote(n) } }]),
      { text: "Delete", style: "destructive", onPress: async () => {
        try {
          const r = await api.orgDeleteNote({ note_id: n.id })
          if (isQueued(r)) { setActionError("Deletion is waiting for the owner's approval. The note stays until then."); return }
          setNotes((ns) => ns.filter((x) => x.id !== n.id))
        } catch (e) { setActionError(userError(e, "the note", "delete")) }
      } },
    ])
  }

  async function create(kind: Note["kind"], body: string) {
    if (creating.current) return
    creating.current = true
    setPicking(false)
    setActionError("")
    try {
      const n = await api.orgCreateNote({ title: "", body, kind, session: scope?.session, project_id: scope?.project })
      navigation.navigate("NoteEditor", { id: n.id })
    } catch (e) {
      setActionError(userError(e, "the note", "create"))
    } finally {
      creating.current = false
    }
  }

  const templates = noteTemplates()

  return (
    <View style={styles.page}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", backgroundColor: t.chipBg, borderRadius: 10, paddingHorizontal: 10 }}>
          <Icon name="search" size={16} color={t.textMuted} />
          <TextInput
            testID="notes-search"
            style={{ flex: 1, paddingVertical: 8, paddingHorizontal: 8, color: t.text, fontSize: 15 }}
            placeholder="Search notes"
            placeholderTextColor={t.textMuted}
            value={query}
            onChangeText={setQuery}
            clearButtonMode="while-editing"
          />
        </View>
        <TouchableOpacity
          testID="notes-archived"
          onPress={() => { setShowArchived((v) => !v); setLoading(true) }}
          hitSlop={8}
          style={[styles.filterChip, showArchived && styles.filterChipActive]}
        >
          <Text style={[styles.filterChipText, showArchived && styles.filterChipTextActive]}>Archived</Text>
        </TouchableOpacity>
        <HeaderButton testID="notes-export" label="Export notes" onPress={exportVault} disabled={exporting}>
          {exporting ? <ActivityIndicator size="small" color={t.accent} /> : <Icon name="upload" size={20} color={t.accent} />}
        </HeaderButton>
      </View>

      {tagChips.length ? (
        <FlatList
          horizontal
          data={tagChips}
          keyExtractor={([tg]) => tg}
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingBottom: 8 }}
          renderItem={({ item: [tg, n] }) => {
            const on = tags.includes(tg)
            return (
              <TouchableOpacity testID={`notes-tag-${tg}`} onPress={() => setTags((cur) => (on ? cur.filter((x) => x !== tg) : [...cur, tg]))}
                style={[styles.filterChip, on && styles.filterChipActive]}>
                <Text style={[styles.filterChipText, on && styles.filterChipTextActive]}>#{tg}{n ? ` ${n}` : ""}</Text>
              </TouchableOpacity>
            )
          }}
        />
      ) : null}

      {exportingNote ? (
        <View testID="notes-exporting" style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingBottom: 8 }}>
          <ActivityIndicator size="small" color={t.accent} />
          <Text style={{ color: t.textMuted, fontSize: 13 }}>{exportingNote}</Text>
        </View>
      ) : null}
      {error || actionError ? <Text testID="notes-error" accessibilityLiveRegion="polite" style={styles.errorBanner}>{error || actionError}</Text> : null}

      {loading && !notes.length ? (
        <ActivityIndicator style={{ marginTop: 32 }} color={t.accent} />
      ) : (
        <FlatList
          testID="notes-list"
          data={rows}
          keyExtractor={(r) => (r.kind === "note" ? String(r.n.id) : `group-${r.key}`)}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}
          contentContainerStyle={{ paddingBottom: 24 }}
          ListEmptyComponent={
            <View style={{ alignItems: "center", paddingTop: 60, paddingHorizontal: 32 }}>
              <Icon name="book" size={36} color={t.textMuted} />
              <Text style={{ color: t.text, fontWeight: "600", fontSize: 16, marginTop: 12 }}>
                {showArchived ? "Nothing archived" : query || tags.length ? "No matches" : "No notes yet"}
              </Text>
              {!showArchived && !query && !tags.length ? (
                <Text style={{ color: t.textMuted, textAlign: "center", marginTop: 6 }}>
                  Tap + for a blank note, a journal entry, meeting notes or a checklist. Link notes with [[Title]] and group them with #tags. Agents in your chats can write here too.
                </Text>
              ) : null}
            </View>
          }
          renderItem={({ item: row }) => {
            if (row.kind === "header") {
              const open = !collapsed.has(row.key)
              return (
                <TouchableOpacity
                  testID={`notes-group-${row.key}`}
                  style={styles.projectHeader}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                  onPress={() => setCollapsed((prev) => {
                    const next = new Set(prev)
                    next.has(row.key) ? next.delete(row.key) : next.add(row.key)
                    return next
                  })}
                >
                  <Icon name={open ? "chevronDown" : "chevronRight"} size={16} color={t.textMuted} />
                  {row.pinned ? <Icon name="pin" size={12} color={t.accent} /> : null}
                  <Text style={styles.projectHeaderText} numberOfLines={1}>{row.name}</Text>
                  <Text style={styles.projectHeaderCount}>{row.count}</Text>
                </TouchableOpacity>
              )
            }
            const n = row.n
            const who = formatActor(n.created_by, username())
            return (
              <TouchableOpacity
                testID={`note-${n.id}`}
                onPress={() => navigation.navigate("NoteEditor", { id: n.id })}
                onLongPress={() => noteActions(n)}
                accessibilityHint="Long press for export, archive and delete"
                style={{ paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.border }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  {n.pinned ? <Icon name="pin" size={13} color={t.accent} /> : null}
                  <Text style={{ flex: 1, color: t.text, fontWeight: "600", fontSize: 16 }} numberOfLines={1}>{displayTitle(n)}</Text>
                  <Text style={{ color: t.textMuted, fontSize: 12 }}>{fmtWaiting(Math.max(0, Date.now() / 1000 - n.updated_at))}</Text>
                </View>
                {previewLine(n) ? (
                  <Text style={{ color: t.textMuted, fontSize: 14, marginTop: 2 }} numberOfLines={2}>{previewLine(n)}</Text>
                ) : null}
                <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 4 }}>
                  {KIND_LABEL[n.kind] || "Note"} · {who.kind === "you" ? "you" : who.kind === "agent" ? `agent ${who.name}` : who.name}
                  {n.replies ? ` · ${n.replies} repl${n.replies === 1 ? "y" : "ies"}` : ""}
                </Text>
              </TouchableOpacity>
            )
          }}
        />
      )}

      <SheetModal visible={picking} onClose={() => setPicking(false)}>
        <Text style={styles.sheetTitle}>New note</Text>
        {templates.map((tp) => (
          <TouchableOpacity key={tp.kind} testID={`note-template-${tp.kind}`} onPress={() => create(tp.kind, tp.body)}
            style={{ paddingHorizontal: 18, paddingVertical: 12 }}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }}>{tp.label}</Text>
            <Text style={{ color: t.textMuted, fontSize: 13 }}>{tp.hint}</Text>
          </TouchableOpacity>
        ))}
      </SheetModal>
    </View>
  )
}
