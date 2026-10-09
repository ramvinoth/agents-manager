import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, RefreshControl, Text, TextInput, TouchableOpacity, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import { useHeaderHeight } from "@react-navigation/elements"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type InboxMessage, type OpenDecision, type Session } from "../api/client"
import {
  kindLabel, SNOOZE_OPTIONS,
  conversationPreview, groupConversations, inboxScopeFilter, inboxStateBadge,
  searchConversations, threadTimeline, waitsOnOwner, type Conversation, type ThreadItem,
  confirmSent, pendingMessage, withPending,
} from "../lib/inbox"
import { fmtWaiting, queueFrom } from "../lib/decisions"
import { fmtClock, fmtDate } from "../lib/thread"
import { userError } from "../lib/errors"
import { useMenuButton } from "../components/SideMenu"
import { useScreenHeader } from "../lib/useScreenHeader"
import { currentHost, setToken } from "../state/config"
import Avatar from "../components/Avatar"
import Icon from "../components/Icon"
import SheetModal from "../components/SheetModal"
import { useDecisionCockpit } from "../components/useDecisionCockpit"
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
 *    approval / card / red) is a bubble with two actions: "Decide" and "Later"
 *    (snooze — it resurfaces, never dropped).
 *
 * Deciding happens in ONE place — the DecisionCockpit, the same one the board's
 * band opens — never here: "Decide" (and the list's "waiting on you" banner)
 * opens the cockpit at that item over the live queue. An item the queue does
 * not list right now (snoozed, or already decided elsewhere) falls back to
 * where it lives: its card, or its chat.
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
  // A failed action (send/snooze/open); kept apart from `error`, which the 8 s poll clears.
  const [actionError, setActionError] = useState("")
  const [query, setQuery] = useState("")
  const [needsOnly, setNeedsOnly] = useState(false)
  const [sessions, setSessions] = useState<Session[]>([])
  const [composeOpen, setComposeOpen] = useState(false)
  const [snoozeFor, setSnoozeFor] = useState<number | null>(null)
  const [draft, setDraft] = useState("")
  // The visible decision queue (the board band's source) — what "Decide"
  // opens the cockpit over. A failed read degrades to "fall back to the chat".
  const [queue, setQueue] = useState<OpenDecision[]>([])
  const reads = useRef({ issued: 0, applied: 0 })
  const marked = useRef(new Set<number>())

  const load = useCallback(async () => {
    if (!scope) { setError("This conversation has no valid id."); setLoading(false); return }
    const request = ++reads.current.issued
    try {
      const [r, q] = await Promise.all([
        api.inboxList(scope),
        api.openDecisions().catch(() => null),
      ])
      if (request < reads.current.applied) return
      reads.current.applied = request
      setMessages((cur) => withPending(r.messages || [], cur))
      if (q) setQueue(q.decisions || [])
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

  const cockpit = useDecisionCockpit(navigation, { onResolved: load })

  // The chat this conversation belongs to. The session resolves id → path on
  // its host; a session no longer listed explains itself instead of failing
  // silently.
  const openChat = useCallback(async () => {
    if (!session) return
    const label = title || labels[session] || session.slice(0, 8)
    if (host && path) { navigation.navigate("Thread", { host, label, path }); return }
    const h = currentHost()
    try {
      const match = (await api.sessions(h)).find((s) => s.id === session)
      if (match) navigation.navigate("Thread", { host: h, label, path: match.path })
      else setActionError(`${label} isn't on this server right now. Its messages keep waiting here.`)
    } catch (e) {
      setActionError(userError(e, "the chat", "open"))
    }
  }, [navigation, session, title, labels, host, path])

  // Decide in the cockpit, this chat's items first (lib/decisions.queueFrom).
  const decide = useCallback((m: InboxMessage) => {
    const { ordered, at } = queueFrom(queue, m.id, m.session_id)
    if (at >= 0) { cockpit.open(ordered, at); return }
    // Not in the visible queue (snoozed, or decided elsewhere): open where it lives.
    if (m.kind === "card" && m.ref_id) cockpit.openCard(Number(m.ref_id))
    else void openChat()
  }, [queue, cockpit.open, cockpit.openCard, openChat])

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
    setActionError("")
    setMessages((all) => [...all, pending])
    try {
      const row = await api.inboxSend({ to: `session:${session}`, body, in_reply_to: lastTheirs?.id })
      setMessages((all) => confirmSent(all, pending.id, row))
    } catch (e) {
      setMessages((all) => all.filter((m) => m.id !== pending.id))
      setDraft((d) => (d ? `${body}\n${d}` : body))
      setActionError(`Not sent: ${userError(e, "your message", "send")}`)
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
      setActionError(userError(e, "this message", "snooze"))
    }
  }

  const errorBar = error ? (
    <TouchableOpacity testID="inbox-error" onPress={() => void load()} style={styles.ibRetry}>
      <Text style={styles.ibRetryText}>{error} · Tap to try again</Text>
    </TouchableOpacity>
  ) : actionError ? (
    <TouchableOpacity testID="inbox-action-error" accessibilityLiveRegion="polite" onPress={() => setActionError("")} style={styles.ibRetry}>
      <Text style={styles.ibRetryText}>{actionError} · Tap to dismiss</Text>
    </TouchableOpacity>
  ) : null

  if (loading && !messages.length) return <ActivityIndicator style={{ marginTop: 32 }} color={t.accent} />

  return session ? (
    <KeyboardAvoidingView
      style={styles.ibThread}
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
                decision && m.open ? styles.ibOpenDecision : null]}
            >
              {decision ? (
                <Text style={[styles.ibKind, { color: m.open ? t.accent : t.textMuted }]}>
                  {kindLabel(m.kind).toUpperCase()}{badge ? ` · ${badge}` : ""}
                </Text>
              ) : null}
              <Text style={styles.bubbleText} selectable>{m.body}</Text>
              {decision && m.open ? (
                <View style={styles.ibActions}>
                  <TouchableOpacity
                    testID={`inbox-decide-${m.id}`}
                    onPress={() => decide(m)}
                    style={[styles.filterChip, styles.ibDecideChip]}
                    hitSlop={6}
                  >
                    <Text style={styles.ibDecideText}>
                      Decide
                    </Text>
                  </TouchableOpacity>
                  {!m.snoozed ? (
                    <TouchableOpacity
                      testID={`inbox-snooze-${m.id}`}
                      onPress={() => setSnoozeFor(m.id)}
                      style={[styles.filterChip, styles.ibLaterChip]}
                      hitSlop={6}
                    >
                      <Text style={styles.ibLaterText}>Later</Text>
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
            style={styles.ibSheetRow}>
            <Text style={styles.ibSheetRowText}>{o.label}</Text>
          </TouchableOpacity>
        ))}
        <Text style={styles.ibSheetNote}>
          It comes back on its own when the time is up — nothing is dropped.
        </Text>
      </SheetModal>
      {cockpit.element}
    </KeyboardAvoidingView>
  ) : (
    <>
    <ConversationList
      queueCount={queue.length}
      onDecideAll={() => cockpit.open(queue, 0)}
      messages={messages}
      labels={labels}
      byId={byId}
      query={query}
      setQuery={setQuery}
      needsOnly={needsOnly}
      setNeedsOnly={setNeedsOnly}
      errorBar={errorBar}
      onOpen={openConversation}
      onRefresh={load}
      composeOpen={composeOpen}
      setComposeOpen={setComposeOpen}
      sessions={sessions}
    />
    {cockpit.element}
    </>
  )
}

/** The Inbox tab body: search, an "All / Needs you" switch, the conversation
 *  rows, and the "New message" chat picker. */
function ConversationList({
  queueCount, onDecideAll, messages, labels, byId, query, setQuery, needsOnly, setNeedsOnly, errorBar, onOpen, onRefresh, composeOpen, setComposeOpen, sessions,
}: {
  queueCount: number
  onDecideAll: () => void
  messages: InboxMessage[]
  labels: Record<string, string>
  byId: Map<string, Session>
  query: string
  setQuery: (q: string) => void
  needsOnly: boolean
  setNeedsOnly: (v: boolean) => void
  errorBar: React.ReactNode
  onOpen: (sid: string, name: string) => void
  onRefresh: () => void
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
    <View style={styles.page}>
      {errorBar}
      <View style={styles.ibHead}>
        <View style={styles.ibSearch}>
          <Icon name="search" size={16} color={t.textMuted} />
          <TextInput
            testID="inbox-search"
            style={styles.ibSearchInput}
            placeholder="Search"
            placeholderTextColor={t.textMuted}
            value={query}
            onChangeText={setQuery}
            clearButtonMode="while-editing"
          />
        </View>
        <View style={styles.ibFilters}>
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
        {queueCount > 0 ? (
          <TouchableOpacity
            testID="inbox-decide-all"
            onPress={onDecideAll}
            style={styles.ibDecideAll}
          >
            <Icon name="check" size={18} color={t.onAccent} />
            <Text style={[styles.ibDecideAllText, { flex: 1 }]}>
              {queueCount === 1 ? "1 decision waits on you" : `${queueCount} decisions wait on you`}
            </Text>
            <Text style={styles.ibDecideAllText}>Decide ›</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <FlatList<Conversation>
        testID="inbox-list"
        data={shown}
        keyExtractor={(c) => c.session}
        refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <View style={styles.ibEmpty}>
            <Icon name="mail" size={36} color={t.textMuted} />
            <Text style={styles.ibEmptyTitle}>
              {query ? "No matches" : needsOnly ? "Nothing waits on you" : "No conversations yet"}
            </Text>
            {!query && !needsOnly ? (
              <Text style={styles.ibEmptyBody}>
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
                <Text style={[styles.chatSub, bold ? styles.ibSubUnread : null]} numberOfLines={2}>
                  {conversationPreview(c)}
                </Text>
              </View>
              <View style={styles.chatMetaCol}>
                <Text style={[styles.chatTime, bold ? styles.chatTimeUnread : null]}>
                  {fmtWaiting(Math.max(0, Date.now() / 1000 - c.at))}
                </Text>
                {c.open > 0 ? (
                  <View style={styles.ibPill}>
                    <Text style={styles.ibPillText}>needs you</Text>
                  </View>
                ) : bold ? (
                  <View style={styles.ibCountPill}>
                    <Text style={styles.ibPillText}>{c.unread}</Text>
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
          style={styles.ibPicker}
          data={pickable}
          keyExtractor={(s) => s.id}
          ListEmptyComponent={<Text style={[styles.systemText, { padding: 18 }]}>No chats on this server yet.</Text>}
          renderItem={({ item: s }) => (
            <TouchableOpacity
              testID={`inbox-to-${s.id}`}
              onPress={() => { setComposeOpen(false); onOpen(s.id, s.title || s.id.slice(0, 8)) }}
              style={styles.ibPickRow}
            >
              <Avatar avatar={s.avatar} seed={s.id} size={34} />
              <Text style={styles.ibPickName} numberOfLines={1}>{s.title || s.id.slice(0, 8)}</Text>
            </TouchableOpacity>
          )}
        />
      </SheetModal>
    </View>
  )
}
