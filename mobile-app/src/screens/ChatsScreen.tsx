import React, { useCallback, useEffect, useMemo, useState } from "react"
import { ActivityIndicator, Alert, FlatList, RefreshControl, Text, TextInput, TouchableOpacity, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Session } from "../api/client"
import {
  currentHost,
  setToken,
} from "../state/config"
import ChatActions from "../components/ChatActions"
import Avatar from "../components/Avatar"
import { createHarman, HARMAN_TITLE } from "../lib/harman"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"
import { HostHeaderButton } from "../components/HostPicker"
import { useStyles } from "./styles"

// Chats lives inside the bottom-tab navigator, which itself is nested in the
// root stack — so navigation can still push Thread/NewChat on the parent stack.
type Props = { navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList> }

function relTime(sec?: number): string {
  if (!sec) return ""
  const d = Date.now() / 1000 - sec
  if (d < 60) return "now"
  if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h`
  if (d < 604800) return `${Math.floor(d / 86400)}d`
  return `${Math.floor(d / 604800)}w`
}

function shortProject(p: string): string {
  const parts = p.split("/").filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

// Home screen — a WhatsApp-style list where each "chat" is an agent session.
// Tapping one opens the thread (ThreadScreen). The ☰ drawer holds the agent
// picker, host picker, project filters, and tools — the mobile "left column".
export default function ChatsScreen({ navigation }: Props) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [host, setHostState] = useState(currentHost())
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<"all" | "unread" | "favorites" | "projects">("all")
  const [showArchived, setShowArchived] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [actionFor, setActionFor] = useState<Session | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // The master switch decides whether the orchestrator exists for this app at
  // all: OFF → no pinned Harman entry, the plain chat-session list it is.
  const [automationOn, setAutomationOn] = useState(false)
  const [harmanBusy, setHarmanBusy] = useState(false)
  const t = useTheme()
  const styles = useStyles()
  const hostLabel = host === "local" ? "This machine" : host

  const archivedCount = useMemo(() => sessions.filter((s) => s.archived).length, [sessions])

  // The list is a flat array of rows: either a chat, or (in Projects view) a
  // collapsible project header. Chips are authoritative — they are NOT gated by
  // the Projects-tab `project` filter, so "All" always means all chats.
  type Row = { kind: "chat"; s: Session } | { kind: "header"; project: string; count: number }
  const rows = useMemo<Row[]>(() => {
    // Base pool: archived view shows only archived; otherwise hide archived.
    let pool = sessions.filter((s) => (showArchived ? s.archived : !s.archived))
    const q = query.trim().toLowerCase()
    const matchQ = (s: Session) =>
      !q || (s.title || s.id).toLowerCase().includes(q) || (s.project || "").toLowerCase().includes(q)
    pool = pool.filter(matchQ)

    if (showArchived) return pool.map((s) => ({ kind: "chat", s }))

    if (filter === "unread") return pool.filter((s) => s.unread).map((s) => ({ kind: "chat", s }))
    if (filter === "favorites") return pool.filter((s) => s.favorite).map((s) => ({ kind: "chat", s }))
    if (filter === "projects") {
      // Group by project (chats without one fall under "No project"), each group a
      // collapsible header. Groups + chats keep the modified-desc order from `load`.
      const groups = new Map<string, Session[]>()
      for (const s of pool) {
        const key = s.project || "No project"
        ;(groups.get(key) || groups.set(key, []).get(key)!).push(s)
      }
      const out: Row[] = []
      for (const [proj, list] of Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        out.push({ kind: "header", project: proj, count: list.length })
        if (!collapsed.has(proj)) for (const s of list) out.push({ kind: "chat", s })
      }
      return out
    }
    // "all"
    return pool.map((s) => ({ kind: "chat", s }))
  }, [sessions, query, filter, showArchived, collapsed])

  async function rename(s: Session, title: string) {
    setSessions((all) => all.map((x) => (x.path === s.path ? { ...x, title } : x))) // optimistic; path is unique, id is not
    try {
      await api.renameSession({ session: s.path, title, host, agent: "claude" })
    } catch (e) {
      setError((e as Error).message)
      load()
    }
  }

  async function remove(s: Session) {
    setSessions((all) => all.filter((x) => x.path !== s.path)) // optimistic; path is unique, id is not
    try {
      await api.deleteSession({ session: s.path, host, agent: "claude" })
    } catch (e) {
      setError((e as Error).message)
      load()
    }
  }

  function enterSelection(s: Session) {
    setSelecting(true)
    setSelected(new Set([s.path]))
  }

  function toggleSelected(path: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }

  function exitSelection() {
    setSelecting(false)
    setSelected(new Set())
  }

  function bulkDelete() {
    const count = selected.size
    if (!count) return
    Alert.alert(`Delete ${count} chat${count > 1 ? "s" : ""}?`, "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const paths = Array.from(selected)
          setSessions((all) => all.filter((x) => !selected.has(x.path)))
          exitSelection()
          for (const p of paths) {
            try {
              await api.deleteSession({ session: p, host, agent: "claude" })
            } catch {
              // best-effort; already removed optimistically
            }
          }
        },
      },
    ])
  }

  // Mark a session read: clear its dot locally (optimistic) and advance the
  // server-side per-reader cursor so it stays read on the next list refresh and
  // on every other device this same principal uses. No-op if already read.
  function markSeen(path: string) {
    setSessions((all) => all.map((x) => (x.path === path && x.unread ? { ...x, unread: false } : x)))
    api.sessionSeen(path).catch(() => {})
  }

  // Toggle a server-side session-meta flag (archived / favorite), optimistically.
  async function setFlag(s: Session, key: "archived" | "favorite", value: boolean) {
    setSessions((all) => all.map((x) => (x.path === s.path ? { ...x, [key]: value } : x)))
    try {
      await api.sessionMetaSave({ session: s.path, [key]: value, host })
    } catch (e) {
      setError((e as Error).message)
      load()
    }
  }

  // Open the orchestrator: jump to the existing Harman session if one is already
  // running on this host, otherwise bootstrap one and then open it. Guarded so a
  // double-tap during the ~seconds-long create doesn't spawn a second Harman.
  async function openHarman() {
    if (harmanBusy) return
    const existing = sessions.find((s) => s.title === HARMAN_TITLE)
    if (existing) {
      markSeen(existing.path)
      navigation.navigate("Thread", { host, label: HARMAN_TITLE, path: existing.path })
      return
    }
    setHarmanBusy(true)
    try {
      const path = await createHarman(host)
      if (path) {
        markSeen(path)
        navigation.navigate("Thread", { host, label: HARMAN_TITLE, path })
        load(true)
      } else {
        setError("Harman started but its transcript wasn't found. Check back shortly.")
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setHarmanBusy(false)
    }
  }

  // These are swipeable tabs that all share ONE parent-stack header and stay
  // mounted together, so the header must be re-asserted on FOCUS (not just on
  // mount) — otherwise it keeps whatever the previously-focused tab last set.
  // Chats shows a "+" that starts a new session.
  useFocusEffect(
    useCallback(() => {
      if (selecting) {
        navigation.setOptions({
          title: `${selected.size} selected`,
          headerLeft: () => (
            <TouchableOpacity
              onPress={exitSelection}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={{ flexDirection: "row", alignItems: "center", marginLeft: 4 }}
            >
              <Icon name="close" size={22} color={t.accent} />
            </TouchableOpacity>
          ),
          headerRight: () => (
            <TouchableOpacity
              testID="bulk-delete"
              onPress={bulkDelete}
              disabled={selected.size === 0}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", marginRight: 4, opacity: selected.size === 0 ? 0.3 : 1 }}
            >
              <Icon name="trash" size={21} color={t.danger} />
            </TouchableOpacity>
          ),
        })
        return
      }
      navigation.setOptions({
        title: "Chats",
        headerLeft: () => <HostHeaderButton navigation={navigation} />,
        headerRight: () => (
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <TouchableOpacity
              testID="chats-terminal"
              onPress={() =>
                navigation.navigate("Terminal", { host, label: host === "local" ? "This machine" : host })
              }
              accessibilityLabel="open-terminal"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}
            >
              <Icon name="terminal" size={21} color={t.accent} />
            </TouchableOpacity>
            <TouchableOpacity
              testID="new-chat-button"
              onPress={() => navigation.navigate("NewChat")}
              accessibilityLabel="new-chat"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              // Fixed, centered 32pt box so the glyph sits dead-center inside iOS's
              // header (and the iOS-26 "glass" tap enclosure) instead of being
              // baseline-aligned hard against the trailing edge.
              style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", marginRight: 4 }}
            >
              <Icon name="add" size={24} color={t.accent} />
            </TouchableOpacity>
          </View>
        ),
      })
    }, [navigation, t, selecting, selected])
  )

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setError("")
      try {
        const s = await api.sessions(host)
        s.sort((a, b) => (b.modified || 0) - (a.modified || 0))
        setSessions(s)
      } catch (e) {
        const err = e as Error & { status?: number }
        if (err.status === 401) {
          await setToken(null)
          navigation.replace("Login")
          return
        }
        // Silent background polls must never surface a transient error banner or
        // wipe the list — only a user-initiated load reports failures.
        if (!silent) setError(err.message)
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [host, navigation]
  )

  // Keep the list LIVE while it's the focused screen: poll quietly in the
  // background so new/updated chats settle into place continuously, instead of
  // the whole list re-sorting in one jarring jump the instant you navigate back
  // (which made muscle-memory "tap the top row" hit the wrong chat). On focus we
  // do ONE silent refresh (no spinner, no list wipe) and start the poll; on blur
  // we stop it. FlatList reconciles by `path` key, so reordered rows move
  // smoothly rather than the list rebuilding.
  useFocusEffect(
    useCallback(() => {
      load(true) // silent refresh on return — no spinner, no visible reload
      const id = setInterval(() => load(true), 4000)
      // The master switch is editable from Profile / Company; re-read it on focus
      // so the pinned Harman row appears/disappears in step with the server.
      let alive = true
      api.orgHarman()
        .then((h) => alive && setAutomationOn(h.automation_enabled === true))
        .catch(() => alive && setAutomationOn(false))
      return () => {
        alive = false
        clearInterval(id)
      }
    }, [load])
  )
  useEffect(() => {
    setLoading(true)
    load()
  }, [host]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          testID="chats-list"
          data={rows}
          keyExtractor={(r) => (r.kind === "header" ? `hdr:${r.project}` : r.s.path)}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={false} onRefresh={() => load(false)} />}
          ListHeaderComponent={
            <>
              <View style={[styles.searchWrap, { backgroundColor: t.bg }]}>
                <TextInput
                  testID="chats-search"
                  style={[styles.searchInput, { backgroundColor: t.chipBg, color: t.text }]}
                  placeholder="Search chats"
                  placeholderTextColor={t.textMuted}
                  value={query}
                  onChangeText={setQuery}
                  autoCapitalize="none"
                  autoCorrect={false}
                  clearButtonMode="while-editing"
                />
              </View>
              {/* Filter chips (WhatsApp-style). Hidden while viewing the archive. */}
              {!showArchived ? (
                <View style={styles.filterRow}>
                  {(["all", "unread", "favorites", "projects"] as const).map((f) => (
                    <TouchableOpacity
                      key={f}
                      testID={`chip-${f}`}
                      style={[styles.filterChip, filter === f ? styles.filterChipActive : null]}
                      onPress={() => setFilter(f)}
                    >
                      <Text style={[styles.filterChipText, filter === f ? styles.filterChipTextActive : null]}>
                        {f === "all" ? "All" : f === "unread" ? "Unread" : f === "favorites" ? "Favorites" : "Projects"}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
              {/* Archived reveal row (main view) / back row (archive view). */}
              {showArchived ? (
                <TouchableOpacity testID="archived-back" style={styles.archivedRow} onPress={() => setShowArchived(false)}>
                  <Icon name="chevronLeft" size={18} color={t.accent} />
                  <Text style={[styles.archivedRowText, { color: t.accent }]}>Back to chats</Text>
                </TouchableOpacity>
              ) : archivedCount > 0 ? (
                <TouchableOpacity testID="archived-reveal" style={styles.archivedRow} onPress={() => setShowArchived(true)}>
                  <Icon name="archive" size={18} color={t.textMuted} />
                  <Text style={styles.archivedRowText}>Archived</Text>
                  <Text style={[styles.archivedRowText, { marginLeft: "auto", color: t.textMuted }]}>{archivedCount}</Text>
                </TouchableOpacity>
              ) : null}
              {/* Pinned Harman — the orchestrator's home, above the project groups.
                  Only when the master switch is on, in the main (non-archived) view,
                  and matching the search. Off → it doesn't exist in this app. */}
              {automationOn && !showArchived && (!query.trim() || "harman".includes(query.trim().toLowerCase())) ? (
                <TouchableOpacity
                  testID="pinned-harman"
                  style={[styles.chatRow, { borderBottomColor: t.border }]}
                  onPress={openHarman}
                  disabled={harmanBusy}
                >
                  <View style={[styles.avatar, { backgroundColor: t.chipBg }]}>
                    {harmanBusy ? <ActivityIndicator color={t.accent} /> : <Icon name="sparkle" size={24} color={t.accent} />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.chatName, { color: t.text }]} numberOfLines={1}>
                      {HARMAN_TITLE}
                    </Text>
                    <Text style={styles.chatSub} numberOfLines={1}>
                      {harmanBusy ? "Starting…" : "Orchestrator · every project"}
                    </Text>
                  </View>
                  <Icon name="chevronRight" size={18} color={t.textMuted} />
                </TouchableOpacity>
              ) : null}
              {error ? <Text style={[styles.error, { paddingHorizontal: 16 }]}>{error}</Text> : null}
            </>
          }
          ListEmptyComponent={
            error ? null : (
              <Text style={[styles.hint, { padding: 16 }]}>
                No chats yet on {hostLabel}.
              </Text>
            )
          }
          renderItem={({ item: row }) => {
            if (row.kind === "header") {
              const open = !collapsed.has(row.project)
              return (
                <TouchableOpacity
                  testID={`project-header-${row.project}`}
                  style={styles.projectHeader}
                  onPress={() =>
                    setCollapsed((prev) => {
                      const n = new Set(prev)
                      n.has(row.project) ? n.delete(row.project) : n.add(row.project)
                      return n
                    })
                  }
                >
                  <Icon name={open ? "chevronDown" : "chevronRight"} size={16} color={t.textMuted} />
                  <Text style={styles.projectHeaderText} numberOfLines={1}>
                    {row.project === "No project" ? row.project : shortProject(row.project)}
                  </Text>
                  <Text style={styles.projectHeaderCount}>{row.count}</Text>
                </TouchableOpacity>
              )
            }
            const item = row.s
            const name = item.title || item.id.slice(0, 8)
            const unread = !!item.unread
            const isSelected = selecting && selected.has(item.path)
            return (
              <TouchableOpacity
                testID={`chat-${item.id}`}
                // An accessible row would swallow the board button below into one
                // element; the content column and the button are exposed separately.
                accessible={false}
                style={[styles.chatRow, { borderBottomColor: t.border }]}
                onPress={() => {
                  if (selecting) {
                    toggleSelected(item.path)
                    return
                  }
                  markSeen(item.path)
                  navigation.navigate("Thread", { host, label: name, path: item.path })
                }}
                onLongPress={selecting ? undefined : () => setActionFor(item)}
                delayLongPress={350}
              >
                {selecting ? (
                  <View
                    style={{
                      width: 24, height: 24, borderRadius: 12, marginRight: 10,
                      alignItems: "center", justifyContent: "center",
                      backgroundColor: isSelected ? t.accent : "transparent",
                      borderWidth: isSelected ? 0 : 2,
                      borderColor: t.textMuted,
                    }}
                  >
                    {isSelected ? <Icon name="check" size={16} color={t.onAccent} /> : null}
                  </View>
                ) : null}
                <Avatar avatar={item.avatar} seed={item.id} size={46} />
                <View style={{ flex: 1 }} accessible accessibilityRole="button">
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    {item.running ? <View style={styles.runningDot} /> : null}
                    <Text
                      style={[styles.chatName, { color: t.text, flex: 1 }, unread ? styles.chatNameUnread : null]}
                      numberOfLines={1}
                    >
                      {name}
                    </Text>
                  </View>
                  {/* The WhatsApp signature line: what was last said, not metadata.
                      When a persona drives the session, name it here — the org↔fleet
                      answer to "who is this" — else fall back to host/harness. */}
                  <Text
                    style={[styles.chatSub, unread ? { color: t.text, fontWeight: "500" } : null]}
                    numberOfLines={1}
                  >
                    {item.preview || (item.persona ? `${item.persona.name} · ${hostLabel}` : `Claude · ${hostLabel}`)}
                  </Text>
                </View>
                <View style={styles.chatMetaCol}>
                  <Text style={[styles.chatTime, unread ? styles.chatTimeUnread : null]}>{relTime(item.modified)}</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    {item.favorite ? <Icon name="star" size={13} color={t.accent} /> : null}
                    {unread ? <View style={styles.unreadDot} /> : null}
                    {/* Open this session's Kanban board (its filtered view). A tap
                        target rather than a swipe — the chat list lives inside the
                        bottom-tab pager, which would swallow a horizontal swipe. */}
                    <TouchableOpacity
                      testID={`chat-board-${item.id}`}
                      accessibilityLabel="Open board"
                      accessibilityRole="button"
                      onPress={() => navigation.navigate("Kanban", { session: item.id, title: name })}
                      hitSlop={8}
                    >
                      <Icon name="folder" size={15} color={t.textMuted} />
                    </TouchableOpacity>
                    {/* Open this session's inbox (its mailbox) — the same
                        per-session filtered view as the board's. */}
                    <TouchableOpacity
                      testID={`chat-inbox-${item.id}`}
                      accessibilityLabel="Open inbox"
                      accessibilityRole="button"
                      onPress={() => navigation.navigate("Inbox", { session: item.id, host, path: item.path, title: name })}
                      hitSlop={8}
                    >
                      <Icon name="mail" size={15} color={t.textMuted} />
                    </TouchableOpacity>
                  </View>
                </View>
              </TouchableOpacity>
            )
          }}
        />
      )}

      <ChatActions
        visible={!!actionFor}
        name={actionFor ? actionFor.title || actionFor.id.slice(0, 8) : ""}
        archived={!!actionFor?.archived}
        favorite={!!actionFor?.favorite}
        onClose={() => setActionFor(null)}
        onRename={(title) => actionFor && rename(actionFor, title)}
        onArchive={() => actionFor && setFlag(actionFor, "archived", !actionFor.archived)}
        onFavorite={() => actionFor && setFlag(actionFor, "favorite", !actionFor.favorite)}
        onDelete={() => actionFor && remove(actionFor)}
        onSelect={() => actionFor && enterSelection(actionFor)}
      />
    </View>
  )
}
