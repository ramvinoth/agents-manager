import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Alert, FlatList, Text, TextInput, TouchableOpacity, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Note, type NoteFilter } from "../api/client"
import { KIND_LABEL, displayTitle, noteTemplates, notesScopeFilter, orderNotes, previewLine, searchNotes } from "../lib/notes"
import { formatActor } from "../lib/board"
import { fmtWaiting } from "../lib/decisions"
import { setToken, username } from "../state/config"
import Icon from "../components/Icon"
import SheetModal from "../components/SheetModal"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "./styles"

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList>
  /** Scope of this view: a chat's notes, a project's, or (the Notes tab) everything. */
  filter?: NoteFilter
  title?: string
  /** True when rendered as the Home tab: it owns the shared stack header on focus. */
  isTab?: boolean
}

/**
 * NotesScreen — the org's ONE notes ledger rendered as a filtered VIEW, like
 * the board: the Notes tab shows every note, a chat's header menu opens that
 * chat's notes, a project row opens the project's. Agents write into the same
 * table through the note_* MCP tools, so what a session researched or decided
 * shows up here beside what the owner typed.
 *
 * List rows carry the kind, a preview and who wrote it; the "+" opens the
 * template picker (blank / journal / meeting / idea / checklist) and pushes
 * the editor. Archived notes (a chat's archive shelves its notes) are one
 * toggle away, never gone. Polls like the board so agent-written notes appear
 * without a manual refresh.
 */
export default function NotesScreen({ navigation, filter, title, isTab }: Props) {
  const t = useTheme()
  const styles = useStyles()
  const scope = useMemo(() => notesScopeFilter(filter), [filter])
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [showArchived, setShowArchived] = useState(false)
  const [picking, setPicking] = useState(false)
  const creating = useRef(false)
  const reads = useRef({ issued: 0, applied: 0 })

  const load = useCallback(async () => {
    if (!scope) { setError("This notes view has no valid scope."); setLoading(false); return }
    const request = ++reads.current.issued
    try {
      const r = await api.orgNotes({ ...scope, archived: showArchived })
      if (request < reads.current.applied) return
      reads.current.applied = request
      setNotes(r.notes || [])
      setError("")
    } catch (err) {
      if (request < reads.current.applied) return
      reads.current.applied = request
      const e = err as Error & { status?: number }
      if (e.status === 401) { setToken(null); navigation.replace("Login"); return }
      setError(e.message || "Could not load notes")
    } finally {
      setLoading(false)
    }
  }, [scope, showArchived, navigation])

  useFocusEffect(useCallback(() => {
    load()
    const id = setInterval(load, 8000)
    return () => clearInterval(id)
  }, [load]))

  // The shared stack header: a pushed (scoped) view gets its title; the tab
  // re-asserts its own header on focus (sibling tabs share the header).
  useFocusEffect(useCallback(() => {
    navigation.setOptions({
      title: title || "Notes",
      headerLeft: isTab ? () => null : undefined,
      headerRight: () => (
        <TouchableOpacity testID="notes-add" accessibilityLabel="new-note" onPress={() => setPicking(true)} hitSlop={8}
          style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}>
          <Icon name="add" size={22} color={t.accent} />
        </TouchableOpacity>
      ),
    })
  }, [navigation, title, isTab, t.accent]))

  const shown = useMemo(() => orderNotes(searchNotes(notes, query)), [notes, query])

  async function create(kind: Note["kind"], body: string) {
    if (creating.current) return
    creating.current = true
    setPicking(false)
    try {
      const n = await api.orgCreateNote({ title: "", body, kind, session: scope?.session, project_id: scope?.project })
      navigation.navigate("NoteEditor", { id: n.id })
    } catch (e) {
      Alert.alert("Could not create note", (e as Error).message)
    } finally {
      creating.current = false
    }
  }

  const templates = noteTemplates()

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
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
      </View>

      {error ? <Text style={{ color: t.danger, paddingHorizontal: 16, paddingBottom: 6 }}>{error}</Text> : null}

      {loading && !notes.length ? (
        <ActivityIndicator style={{ marginTop: 32 }} color={t.accent} />
      ) : (
        <FlatList
          testID="notes-list"
          data={shown}
          keyExtractor={(n) => String(n.id)}
          contentContainerStyle={{ paddingBottom: 24 }}
          ListEmptyComponent={
            <View style={{ alignItems: "center", paddingTop: 60, paddingHorizontal: 32 }}>
              <Icon name="book" size={36} color={t.textMuted} />
              <Text style={{ color: t.text, fontWeight: "600", fontSize: 16, marginTop: 12 }}>
                {showArchived ? "Nothing archived" : query ? "No matches" : "No notes yet"}
              </Text>
              {!showArchived && !query ? (
                <Text style={{ color: t.textMuted, textAlign: "center", marginTop: 6 }}>
                  Tap + for a blank note, a journal entry, meeting notes or a checklist. Agents in your chats can write here too.
                </Text>
              ) : null}
            </View>
          }
          renderItem={({ item: n }) => {
            const who = formatActor(n.created_by, username())
            return (
              <TouchableOpacity
                testID={`note-${n.id}`}
                onPress={() => navigation.navigate("NoteEditor", { id: n.id })}
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
