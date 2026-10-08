import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Text, TextInput, TouchableOpacity, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import { useHeaderHeight } from "@react-navigation/elements"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type InboxMessage, type Session } from "../api/client"
import {
  kindLabel, SNOOZE_OPTIONS,
  conversationPreview, groupConversations, inboxScopeFilter, inboxStateBadge,
  searchConversations, threadTimeline, waitsOnOwner, type Conversation, type ThreadItem,
  confirmSent, pendingMessage, withPending,
} from "../lib/inbox"
import { fmtWaiting } from "../lib/decisions"
import { fmtClock, fmtDate } from "../lib/thread"
import { userError } from "../lib/errors"
import { useMenuButton } from "../components/SideMenu"
import { useScreenHeader } from "../lib/useScreenHeader"
import { currentHost, setToken } from "../state/config"
import Avatar from "../components/Avatar"
import Icon from "../components/Icon"
import SheetModal from "../components/SheetModal"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList>
  /** One chat's mailbox (the conversation view); absent = every conversation. */
  session?: string
  title?: string
  /** When opened from a specific chat its host/path come along, so "Open chat"
      needs no lookup. */
  host?: string
  path?: string
  /** True when rendered as the Home tab: it owns the shared stack header on focus. */
  isTab?: boolean
}

const iso = (sec: number) => new Date(sec * 1000).toISOString()

/**
 * InboxScreen — the org's ONE message ledger, shaped like the messaging apps
 * everyone already knows (WhatsApp / iMessage), so there is nothing new to learn:
 *
 *  - no `session`: the conversation list — one row per chat mailbox with its
 *    avatar, last line, time and unread count. Chats with a decision waiting on
 *    the owner float to the top with a "needs you" pill, like a pinned chat.
 *  - `session`: that conversation — chat bubbles (the owner's on the right),
 *    day separators, and a composer at the bottom. A decision (question / plan /
 *    approval / card) is a bubble with its two actions: open it where it is
 *    decided (the chat, or the card) and "Later" (snooze — it resurfaces, never
 *    dropped). The deciding tap stays in the chat/card: the inbox is a delivery
 *    surface over the existing decision system, not a second one.
 */
export default function InboxScreen({ navigation, session, title, host, path, isTab }: Props) {
  const t = useTheme()
  const styles = useStyles()
  const headerHeight = useHeaderHeight()
  const scope = useMemo(() => inboxScopeFilter(session ? { session } : {}), [session])
  const [messages, setMessages] = useState<InboxMessage[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [needsOnly, setNeedsOnly] = useState(false)
  const [sessions, setSessions] = useState<Session[]>([])
  const [composeOpen, setComposeOpen] = useState(false)
  const [snoozeFor, setSnoozeFor] = useState<number | null>(null)
  const [draft, setDraft] = useState("")
  const reads = useRef({ issued: 0, applied: 0 })
  const marked = useRef(new Set<number>())

  const load = useCallback(async () => {
    if (!scope) { setError("This conversation has no valid id."); setLoading(false); return }
    const request = ++reads.current.issued
    try {
      const r = await api.inboxList(scope)
      if (request < reads.current.applied) return
      reads.current.applied = request
      setMessages((cur) => withPending(r.messages || [], cur))
      setUnread(r.unread || 0)
      setError("")
    } catch (err) {
      if (request < reads.current.applied) return
      reads.current.applied = request
      const e = err as Error & { status?: number }
      if (e.status === 401) { setToken(null); navigation.replace("Login"); return }
      setError(userError(e, "load your inbox"))
    } finally {
      setLoading(false)
    }
  }, [scope, navigation])

  useFocusEffect(useCallback(() => {
    load()
    const id = setInterval(load, 8000)
    return () => clearInterval(id)
  }, [load]))

  // This host's chats: names + avatars for the list, and the compose picker.
  useEffect(() => {
    api.sessions(currentHost()).then(setSessions).catch(() => {})
  }, [])
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  const labels = useMemo(() => Object.fromEntries(sessions.map((s) => [s.id, s.title || s.id.slice(0, 8)])), [sessions])

  // Opening a conversation reads its free messages, as any messenger does.
  // Decisions stay counted until they are decided or snoozed — seeing a
  // question is not answering it.
  useEffect(() => {
    if (!session) return
    const fresh = messages.filter((m) => m.kind === "message" && waitsOnOwner(m) && !marked.current.has(m.id))
    if (!fresh.length) return
    fresh.forEach((m) => marked.current.add(m.id))
    Promise.all(fresh.map((m) => api.inboxRead(m.id))).then(load, () => {})
  }, [session, messages, load])

  const openConversation = useCallback((sid: string, name: string) => {
    navigation.push("Inbox", { session: sid, title: name, host: currentHost(), path: byId.get(sid)?.path })
  }, [navigation, byId])

  // Where a decision is decided: a card on its card page, everything else in
  // the chat. The session resolves id → path on its host; a session no longer
  // listed explains itself instead of failing silently.
  const openChat = useCallback(async (m?: InboxMessage) => {
    if (m?.kind === "card" && m.ref_id) {
      navigation.navigate("CardDetail", { id: Number(m.ref_id) })
      return
    }
    if (!session) return
    const label = title || labels[session] || session.slice(0, 8)
    if (host && path) { navigation.navigate("Thread", { host, label, path }); return }
    const h = currentHost()
    try {
      const match = (await api.sessions(h)).find((s) => s.id === session)
      if (match) navigation.navigate("Thread", { host: h, label, path: match.path })
      else Alert.alert(label, "That chat is not on this server right now. It will keep waiting here.")
    } catch (e) {
      Alert.alert("Could not open the chat", userError(e, "open the chat"))
    }
  }, [navigation, session, title, labels, host, path])

  const menuButton = useMenuButton()
  useScreenHeader(navigation, () => {
    if (session) {
      return {
        title: title || labels[session] || "Conversation",
        headerLeft: undefined,
        headerRight: () => (
          <TouchableOpacity testID="inbox-open-thread" accessibilityLabel="Open chat" hitSlop={10} onPress={() => void openChat()}>
            <Icon name="chat" size={22} color={t.accent} />
          </TouchableOpacity>
        ),
      }
    }
    return {
      title: unread > 0 ? `Inbox (${unread})` : "Inbox",
      headerLeft: isTab ? menuButton : undefined,
      headerRight: () => (
        <TouchableOpacity testID="inbox-compose" accessibilityLabel="New message" hitSlop={10} onPress={() => setComposeOpen(true)}>
          <Icon name="add" size={22} color={t.accent} />
        </TouchableOpacity>
      ),
    }
  }, [session, title, labels, isTab, unread, t.accent, openChat])

  // Optimistic: the box clears and the bubble shows the moment you tap send
  // (a messenger never makes you watch your words sit in the field); a failed
  // send takes the bubble back and returns the words to the box.
  const send = useCallback(async () => {
    const body = draft.trim()
    if (!body || !session) return
    const lastTheirs = [...messages].filter((m) => m.sender_type !== "user").sort((a, b) => b.created_at - a.created_at)[0]
    const pending = pendingMessage(session, body, lastTheirs?.id ?? 0)
    setDraft("")
    setMessages((all) => [...all, pending])
    try {
      const row = await api.inboxSend({ to: `session:${session}`, body, in_reply_to: lastTheirs?.id })
      setMessages((all) => confirmSent(all, pending.id, row))
    } catch (e) {
      setMessages((all) => all.filter((m) => m.id !== pending.id))
      setDraft((d) => (d ? `${body}\n${d}` : body))
      Alert.alert("Not sent", userError(e, "send the message"))
    }
  }, [draft, session, messages])

  const snooze = async (hours: number) => {
    if (snoozeFor == null) return
    const id = snoozeFor
    setSnoozeFor(null)
    try {
      await api.inboxSnooze(id, hours)
      await load()
    } catch (e) {
      Alert.alert("Could not snooze", userError(e, "snooze this"))
    }
  }

  const errorBar = error ? (
    <TouchableOpacity testID="inbox-error" onPress={() => void load()} style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
      <Text style={{ color: t.danger }}>{error} · Tap to try again</Text>
    </TouchableOpacity>
  ) : null

  if (loading && !messages.length) return <ActivityIndicator style={{ marginTop: 32 }} color={t.accent} />

  return session ? (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.thread }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={headerHeight}
    >
      {errorBar}
      <FlatList<ThreadItem>
        testID="inbox-thread"
        inverted
        data={threadTimeline(messages, (ts) => fmtDate(iso(ts))).reverse()}
        keyExtractor={(x) => x.key}
        contentContainerStyle={styles.threadContent}
        ListEmptyComponent={
          <Text style={[styles.systemText, { padding: 32, transform: [{ scaleY: -1 }] }]}>
            No messages yet. Write below — it reaches this chat right away.
          </Text>
        }
        renderItem={({ item }) => {
          if (item.type === "day") {
            return <View style={styles.systemPill}><Text style={styles.systemText}>{item.label}</Text></View>
          }
          const m = item.m
          const decision = m.kind !== "message"
          const badge = decision ? inboxStateBadge(m) : null
          return (
            <View
              testID={`inbox-msg-${m.id}`}
              style={[item.mine ? styles.bubbleUser : styles.bubbleAssistant,
                decision && m.open ? { borderLeftWidth: 3, borderLeftColor: t.accent } : null]}
            >
              {decision ? (
                <Text style={{ color: m.open ? t.accent : t.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 0.4, marginBottom: 4 }}>
                  {kindLabel(m.kind).toUpperCase()}{badge ? ` · ${badge}` : ""}
                </Text>
              ) : null}
              <Text style={styles.bubbleText} selectable>{m.body}</Text>
              {decision && m.open ? (
                <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                  <TouchableOpacity
                    testID={`inbox-decide-${m.id}`}
                    onPress={() => void openChat(m)}
                    style={[styles.filterChip, { backgroundColor: t.accent }]}
                    hitSlop={6}
                  >
                    <Text style={{ color: t.onAccent, fontSize: 13, fontWeight: "700" }}>
                      {m.kind === "card" ? "Open card" : "Answer in chat"}
                    </Text>
                  </TouchableOpacity>
                  {!m.snoozed ? (
                    <TouchableOpacity
                      testID={`inbox-snooze-${m.id}`}
                      onPress={() => setSnoozeFor(m.id)}
                      style={[styles.filterChip, { backgroundColor: t.chipBg }]}
                      hitSlop={6}
                    >
                      <Text style={{ color: t.text, fontSize: 13 }}>Later</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}
              <Text style={styles.msgTime}>{m.pending ? "Sending…" : fmtClock(iso(m.created_at))}</Text>
            </View>
          )
        }}
      />
      <View style={styles.composerWrap}>
        <View style={styles.composerBar}>
          <TextInput
            testID="inbox-composer"
            style={styles.composerInput}
            placeholder="Message"
            placeholderTextColor={t.textMuted}
            value={draft}
            onChangeText={setDraft}
            multiline
          />
          <TouchableOpacity
            testID="inbox-send"
            accessibilityLabel="Send"
            onPress={() => void send()}
            disabled={!draft.trim()}
            style={[styles.circleBtn, !draft.trim() ? styles.sendBtnDisabled : styles.sendBtn]}
          >
            <Icon name="send" size={20} color={t.onAccent} />
          </TouchableOpacity>
        </View>
      </View>
      <SheetModal visible={snoozeFor != null} onClose={() => setSnoozeFor(null)}>
        <Text style={styles.sheetTitle}>Not now — remind me in</Text>
        {SNOOZE_OPTIONS.map((o) => (
          <TouchableOpacity key={o.hours} testID={`snooze-${o.hours}`} onPress={() => void snooze(o.hours)}
            style={{ paddingHorizontal: 18, paddingVertical: 12 }}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }}>{o.label}</Text>
          </TouchableOpacity>
        ))}
        <Text style={{ color: t.textMuted, fontSize: 13, paddingHorizontal: 18, paddingBottom: 8 }}>
          It comes back on its own when the time is up — nothing is dropped.
        </Text>
      </SheetModal>
    </KeyboardAvoidingView>
  ) : (
    <ConversationList
      messages={messages}
      labels={labels}
      byId={byId}
      query={query}
      setQuery={setQuery}
      needsOnly={needsOnly}
      setNeedsOnly={setNeedsOnly}
      errorBar={errorBar}
      onOpen={openConversation}
      composeOpen={composeOpen}
      setComposeOpen={setComposeOpen}
      sessions={sessions}
    />
  )
}

/** The Inbox tab body: search, an "All / Needs you" switch, the conversation
 *  rows, and the "New message" chat picker. */
function ConversationList({
  messages, labels, byId, query, setQuery, needsOnly, setNeedsOnly, errorBar, onOpen, composeOpen, setComposeOpen, sessions,
}: {
  messages: InboxMessage[]
  labels: Record<string, string>
  byId: Map<string, Session>
  query: string
  setQuery: (q: string) => void
  needsOnly: boolean
  setNeedsOnly: (v: boolean) => void
  errorBar: React.ReactNode
  onOpen: (sid: string, name: string) => void
  composeOpen: boolean
  setComposeOpen: (v: boolean) => void
  sessions: Session[]
}) {
  const t = useTheme()
  const styles = useStyles()
  const all = useMemo(() => groupConversations(messages, labels), [messages, labels])
  const needCount = all.filter((c) => c.open > 0).length
  const shown = useMemo(
    () => searchConversations(needsOnly ? all.filter((c) => c.open > 0) : all, messages, query),
    [all, messages, query, needsOnly])
  const pickable = sessions.filter((s) => !s.archived)

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {errorBar}
      <View style={{ paddingHorizontal: 12, paddingTop: 8, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: t.chipBg, borderRadius: 10, paddingHorizontal: 10 }}>
          <Icon name="search" size={16} color={t.textMuted} />
          <TextInput
            testID="inbox-search"
            style={{ flex: 1, paddingVertical: 8, paddingHorizontal: 8, color: t.text, fontSize: 15 }}
            placeholder="Search"
            placeholderTextColor={t.textMuted}
            value={query}
            onChangeText={setQuery}
            clearButtonMode="while-editing"
          />
        </View>
        <View style={{ flexDirection: "row", gap: 6, paddingBottom: 4 }}>
          {([false, true] as const).map((v) => (
            <TouchableOpacity
              key={String(v)}
              testID={v ? "inbox-filter-needs" : "inbox-filter-all"}
              onPress={() => setNeedsOnly(v)}
              hitSlop={6}
              style={[styles.filterChip, needsOnly === v && styles.filterChipActive]}
            >
              <Text style={[styles.filterChipText, needsOnly === v && styles.filterChipTextActive]}>
                {v ? `Needs you${needCount ? ` · ${needCount}` : ""}` : "All"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
      <FlatList<Conversation>
        testID="inbox-list"
        data={shown}
        keyExtractor={(c) => c.session}
        ListEmptyComponent={
          <View style={{ alignItems: "center", paddingTop: 60, paddingHorizontal: 32 }}>
            <Icon name="mail" size={36} color={t.textMuted} />
            <Text style={{ color: t.text, fontWeight: "600", fontSize: 16, marginTop: 12 }}>
              {query ? "No matches" : needsOnly ? "Nothing waits on you" : "No conversations yet"}
            </Text>
            {!query && !needsOnly ? (
              <Text style={{ color: t.textMuted, textAlign: "center", marginTop: 6 }}>
                When an agent asks you something or writes to you, the conversation shows up here. Tap + to message a chat.
              </Text>
            ) : null}
          </View>
        }
        renderItem={({ item: c }) => {
          const s = byId.get(c.session)
          const bold = c.unread > 0
          return (
            <TouchableOpacity
              testID={`inbox-conv-${c.session}`}
              style={[styles.chatRow, { borderBottomColor: t.border }]}
              onPress={() => onOpen(c.session, c.name)}
            >
              <Avatar avatar={s?.avatar} seed={c.session} size={46} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.chatName, bold ? styles.chatNameUnread : null]} numberOfLines={1}>{c.name}</Text>
                <Text style={[styles.chatSub, bold ? { color: t.text, fontWeight: "500" } : null]} numberOfLines={2}>
                  {conversationPreview(c)}
                </Text>
              </View>
              <View style={styles.chatMetaCol}>
                <Text style={[styles.chatTime, bold ? styles.chatTimeUnread : null]}>
                  {fmtWaiting(Math.max(0, Date.now() / 1000 - c.at))}
                </Text>
                {c.open > 0 ? (
                  <View style={{ backgroundColor: t.accent, borderRadius: 9, paddingHorizontal: 7, paddingVertical: 2 }}>
                    <Text style={{ color: t.onAccent, fontSize: 11, fontWeight: "700" }}>needs you</Text>
                  </View>
                ) : bold ? (
                  <View style={{ backgroundColor: t.accent, borderRadius: 9, minWidth: 18, paddingHorizontal: 5, alignItems: "center" }}>
                    <Text style={{ color: t.onAccent, fontSize: 11, fontWeight: "700" }}>{c.unread}</Text>
                  </View>
                ) : null}
              </View>
            </TouchableOpacity>
          )
        }}
      />
      <SheetModal visible={composeOpen} onClose={() => setComposeOpen(false)}>
        <Text style={styles.sheetTitle}>New message to…</Text>
        <FlatList
          style={{ maxHeight: 420 }}
          data={pickable}
          keyExtractor={(s) => s.id}
          ListEmptyComponent={<Text style={[styles.systemText, { padding: 18 }]}>No chats on this server yet.</Text>}
          renderItem={({ item: s }) => (
            <TouchableOpacity
              testID={`inbox-to-${s.id}`}
              onPress={() => { setComposeOpen(false); onOpen(s.id, s.title || s.id.slice(0, 8)) }}
              style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18, paddingVertical: 10 }}
            >
              <Avatar avatar={s.avatar} seed={s.id} size={34} />
              <Text style={{ color: t.text, fontSize: 16, flex: 1 }} numberOfLines={1}>{s.title || s.id.slice(0, 8)}</Text>
            </TouchableOpacity>
          )}
        />
      </SheetModal>
    </View>
  )
}
