import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import { useHeaderHeight } from "@react-navigation/elements"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type InboxKind, type InboxMessage } from "../api/client"
import {
  INBOX_FILTERS, INBOX_KIND_LABEL, SNOOZE_OPTIONS,
  inboxScopeFilter, inboxStateBadge, messagePreview, messageTitle,
  orderInbox, replyTo, rowActor, searchInbox,
} from "../lib/inbox"
import { fmtWaiting } from "../lib/decisions"
import { currentHost, setToken } from "../state/config"
import Icon from "../components/Icon"
import SheetModal from "../components/SheetModal"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "./styles"

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList>
  /** Scope of this view: one chat's mailbox, a project's, or (the Inbox tab) everything. */
  filter?: { session?: string; project?: number }
  title?: string
  /** When this view was opened from a specific chat, its host/path come along —
      "Open chat" then needs no lookup. */
  host?: string
  path?: string
  /** True when rendered as the Home tab: it owns the shared stack header on focus. */
  isTab?: boolean
}

/**
 * InboxScreen — the org's ONE message ledger rendered as a filtered VIEW,
 * like the board and the notes: the Inbox tab shows every message, a chat's
 * header/row opens that chat's mailbox, a project row opens the project's.
 * The ledger is a delivery SURFACE over the existing decision system, not a
 * second one: a row can carry a decision (question / plan / approval / card)
 * whose open state the server derives at read time — the deciding tap stays
 * in the chat (or the card), never here. Snoozed (skipped) rows resurface
 * when the snooze lapses, so nothing is ever dropped.
 *
 * ADHD-friendly shape: one glance point on top — the "Needs you · N" band —
 * then a timeline of rows (bold = unread, dot = waiting on you). Tapping a
 * row expands it in place: full body, then Open chat / Snooze / Reply. No
 * modal maze, no navigation away to decide anything.
 */
export default function InboxScreen({ navigation, filter, title, host, path, isTab }: Props) {
  const t = useTheme()
  const styles = useStyles()
  const headerHeight = useHeaderHeight()
  const scope = useMemo(() => inboxScopeFilter(filter), [filter])
  const [messages, setMessages] = useState<InboxMessage[]>([])
  const [queue, setQueue] = useState<{ count: number; items: InboxMessage[] } | null>(null)
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [kind, setKind] = useState<"all" | InboxKind>("all")
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<number | null>(null)
  const [snoozeFor, setSnoozeFor] = useState<number | null>(null)
  // The composer's target in the (unscoped) tab: pick a session to message.
  const [target, setTarget] = useState<string | null>(null)
  const [targets, setTargets] = useState<{ id: string; name: string }[]>([])
  const [draft, setDraft] = useState("")
  const [replyText, setReplyText] = useState("")
  const [sending, setSending] = useState(false)
  const reads = useRef({ issued: 0, applied: 0 })

  const load = useCallback(async () => {
    if (!scope) { setError("This inbox view has no valid scope."); setLoading(false); return }
    const request = ++reads.current.issued
    try {
      const r = await api.inboxList({ ...scope, kind: kind === "all" ? undefined : kind })
      if (request < reads.current.applied) return
      reads.current.applied = request
      setMessages(r.messages || [])
      setQueue(r.queue || null)
      setUnread(r.unread || 0)
      setError("")
    } catch (err) {
      if (request < reads.current.applied) return
      reads.current.applied = request
      const e = err as Error & { status?: number }
      if (e.status === 401) { setToken(null); navigation.replace("Login"); return }
      setError(e.message || "Could not load inbox")
    } finally {
      setLoading(false)
    }
  }, [scope, kind, navigation])

  useFocusEffect(useCallback(() => {
    load()
    const id = setInterval(load, 8000)
    return () => clearInterval(id)
  }, [load]))

  // The shared stack header: a pushed (scoped) view gets its title; the tab
  // re-asserts its own on focus (sibling tabs share the header). The unread
  // count rides in the title so Ram sees "how many wait on me" at a glance —
  // the same number the tab badge shows.
  useFocusEffect(useCallback(() => {
    const base = title || (filter?.session ? "Chat inbox" : "Inbox")
    navigation.setOptions({
      title: unread > 0 ? `${base} (${unread})` : base,
      headerLeft: isTab ? () => null : undefined,
    })
  }, [navigation, title, filter?.session, isTab, unread]))

  // The tab's composer needs a target to message: this host's chats, chips.
  useEffect(() => {
    if (!isTab || targets.length) return
    api.sessions(currentHost())
      .then((ss) => setTargets(ss.filter((s) => !s.archived).map((s) => ({ id: s.id, name: s.title || s.id.slice(0, 8) }))))
      .catch(() => {})
  }, [isTab, targets.length])

  const shown = useMemo(() => orderInbox(searchInbox(messages, query)), [messages, query])
  // The action queue: open, NOT snoozed decisions, oldest first (the waiting
  // order, not the timeline's). Only on an unfiltered view — filtering the
  // list would silently shrink the band and hide what is waiting.
  const showBand = !!queue && queue.count > 0 && kind === "all" && !query.trim()

  // "Open chat": the deciding tap lives in the thread (or the card). The
  // session is resolved id → path on the host the row came from when we know
  // it, else on the current host; a session that is no longer listed no-ops
  // with a hint, like the board's decision band.
  const openChat = useCallback(async (m: InboxMessage) => {
    if (m.kind === "card" && m.ref_id) {
      navigation.navigate("CardDetail", { id: Number(m.ref_id) })
      return
    }
    const sid = m.session_id
    if (!sid) return
    if (host && path) {
      navigation.navigate("Thread", { host, label: title || sid.slice(0, 8), path })
      return
    }
    const h = currentHost()
    try {
      const sessions = await api.sessions(h)
      const match = sessions.find((s) => s.id === sid)
      if (match) navigation.navigate("Thread", { host: h, label: match.title || sid.slice(0, 8), path: match.path })
      else Alert.alert(sid.slice(0, 8), "That session is not listed here right now — open it from the Chats tab, or it will wait in your inbox.")
    } catch {
      /* offline host: leave the item where it is */
    }
  }, [navigation, host, path, title])

  const send = useCallback(async (to: string, in_reply_to: number, text: string) => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    try {
      await api.inboxSend({ to, body, in_reply_to: in_reply_to || undefined })
      if (in_reply_to) { setReplyText(""); setExpanded(null) }
      else { setDraft(""); setTarget(null) }
      await load()
    } catch (e) {
      Alert.alert("Could not send", (e as Error).message)
    } finally {
      setSending(false)
    }
  }, [sending, load])

  const snooze = async (hours: number) => {
    if (snoozeFor == null) return
    setSnoozeFor(null)
    try {
      await api.inboxSnooze(snoozeFor, hours)
      await load()
    } catch (e) {
      Alert.alert("Could not snooze", (e as Error).message)
    }
  }

  const markRead = async (m: InboxMessage) => {
    try { await api.inboxRead(m.id); await load() } catch { /* read is best-effort */ }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.bg }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={headerHeight}
    >
      {error ? <Text style={{ color: t.danger, paddingHorizontal: 16, paddingTop: 8 }}>{error}</Text> : null}

      {showBand ? (
        <View style={{ backgroundColor: t.surface, borderBottomWidth: 1, borderBottomColor: t.border }}>
          <Text style={{ color: t.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 0.5, paddingHorizontal: 16, paddingTop: 10 }}>
            NEEDS YOU · {queue!.count}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 74 }} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8 }}>
            {queue!.items.slice(0, 6).map((m) => (
              <TouchableOpacity
                key={m.id}
                testID={`needs-${m.id}`}
                accessibilityLabel={`Open ${messageTitle(m, 40)}`}
                onPress={() => { setKind("all"); setQuery(""); setExpanded(m.id) }}
                style={{ backgroundColor: t.chipBg, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, maxWidth: 260 }}
              >
                <Text style={{ color: t.text, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
                  {messageTitle(m, 48) || INBOX_KIND_LABEL[m.kind]}
                </Text>
                <Text style={{ color: t.textMuted, fontSize: 11, marginTop: 2 }}>{rowActor(m)} · {fmtWaiting(Math.max(0, Date.now() / 1000 - m.created_at))}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* Kind chips + search */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", backgroundColor: t.chipBg, borderRadius: 10, paddingHorizontal: 10 }}>
          <Icon name="search" size={16} color={t.textMuted} />
          <TextInput
            testID="inbox-search"
            style={{ flex: 1, paddingVertical: 8, paddingHorizontal: 8, color: t.text, fontSize: 15 }}
            placeholder="Search messages"
            placeholderTextColor={t.textMuted}
            value={query}
            onChangeText={setQuery}
            clearButtonMode="while-editing"
          />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {INBOX_FILTERS.map((k) => (
              <TouchableOpacity
                key={k}
                testID={`inbox-kind-${k}`}
                onPress={() => setKind(k)}
                hitSlop={8}
                style={[styles.filterChip, kind === k && styles.filterChipActive]}
              >
                <Text style={[styles.filterChipText, kind === k && styles.filterChipTextActive]}>
                  {k === "all" ? "All" : INBOX_KIND_LABEL[k]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </View>

      {loading && !messages.length ? (
        <ActivityIndicator style={{ marginTop: 32 }} color={t.accent} />
      ) : (
        <FlatList
          testID="inbox-list"
          data={shown}
          keyExtractor={(m) => String(m.id)}
          contentContainerStyle={{ paddingBottom: 24 }}
          ListEmptyComponent={
            <View style={{ alignItems: "center", paddingTop: 60, paddingHorizontal: 32 }}>
              <Icon name="mail" size={36} color={t.textMuted} />
              <Text style={{ color: t.text, fontWeight: "600", fontSize: 16, marginTop: 12 }}>
                {query ? "No matches" : "No messages yet"}
              </Text>
              {!query ? (
                <Text style={{ color: t.textMuted, textAlign: "center", marginTop: 6 }}>
                  Questions, plans and approvals that wait on you land here with full context. Messages you send to a chat arrive in its mailbox.
                </Text>
              ) : null}
            </View>
          }
          renderItem={({ item: m }) => {
            const badge = inboxStateBadge(m)
            const unread = (m.effective_status ?? m.status) === "sent"
            const to = replyTo(m)
            return (
              <View
                style={{
                  borderBottomWidth: 1,
                  borderBottomColor: t.border,
                  backgroundColor: expanded === m.id ? t.surface : "transparent",
                }}
              >
                <TouchableOpacity
                  testID={`inbox-row-${m.id}`}
                  onPress={() => setExpanded(expanded === m.id ? null : m.id)}
                  style={{ paddingHorizontal: 16, paddingVertical: 12 }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    {m.open ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.accent }} /> : null}
                    <Text
                      style={{ flex: 1, color: t.text, fontSize: 15, fontWeight: unread ? "700" : "400" }}
                      numberOfLines={2}
                    >
                      {messageTitle(m) || INBOX_KIND_LABEL[m.kind]}
                    </Text>
                    <Text style={{ color: t.textMuted, fontSize: 12 }}>
                      {fmtWaiting(Math.max(0, Date.now() / 1000 - m.created_at))}
                    </Text>
                  </View>
                  {messagePreview(m) ? (
                    <Text style={{ color: t.textMuted, fontSize: 14, marginTop: 2, marginLeft: 13 }} numberOfLines={1}>
                      {messagePreview(m)}
                    </Text>
                  ) : null}
                  <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 4, marginLeft: 13 }}>
                    {rowActor(m)} · {INBOX_KIND_LABEL[m.kind]}
                    {badge ? ` · ${badge}` : ""}
                  </Text>
                </TouchableOpacity>

                {expanded === m.id ? (
                  <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                    <Text style={{ color: t.text, fontSize: 14, lineHeight: 20 }}>{m.body}</Text>
                    {(m.kind !== "message" || to) ? (
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                        {m.open && m.kind !== "message" ? (
                          <TouchableOpacity
                            testID={`inbox-open-chat-${m.id}`}
                            onPress={() => void openChat(m)}
                            style={[styles.filterChip, { backgroundColor: t.accent }]}
                            hitSlop={8}
                          >
                            <Text style={{ color: "#fff", fontSize: 13, fontWeight: "700" }}>Open chat</Text>
                          </TouchableOpacity>
                        ) : null}
                        {m.open && m.kind !== "message" ? (
                          <TouchableOpacity
                            testID={`inbox-snooze-${m.id}`}
                            onPress={() => setSnoozeFor(m.id)}
                            style={[styles.filterChip, { backgroundColor: t.chipBg }]}
                            hitSlop={8}
                          >
                            <Text style={{ color: t.text, fontSize: 13 }}>Later</Text>
                          </TouchableOpacity>
                        ) : null}
                        {unread && m.kind === "message" ? (
                          <TouchableOpacity
                            testID={`inbox-read-${m.id}`}
                            onPress={() => void markRead(m)}
                            style={[styles.filterChip, { backgroundColor: t.chipBg }]}
                            hitSlop={8}
                          >
                            <Text style={{ color: t.text, fontSize: 13 }}>Mark read</Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    ) : null}
                    {to ? (
                      <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                        <TextInput
                          testID={`inbox-reply-${m.id}`}
                          style={{
                            flex: 1, backgroundColor: t.chipBg, borderRadius: 10,
                            paddingHorizontal: 12, paddingVertical: 9, color: t.text, fontSize: 15,
                          }}
                          placeholder={`Reply to ${rowActor(m)}…`}
                          placeholderTextColor={t.textMuted}
                          value={replyText}
                          onChangeText={setReplyText}
                          multiline
                          numberOfLines={2}
                        />
                        <TouchableOpacity
                          testID={`inbox-reply-send-${m.id}`}
                          onPress={() => void send(to, m.id, replyText)}
                          disabled={sending || !replyText.trim()}
                          style={{
                            justifyContent: "center", alignItems: "center", width: 40,
                            backgroundColor: t.accent, borderRadius: 10,
                            opacity: sending || !replyText.trim() ? 0.5 : 1,
                          }}
                          hitSlop={8}
                        >
                          <Icon name="send" size={18} color="#fff" />
                        </TouchableOpacity>
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            )
          }}
        />
      )}

      {/* Composer: in a chat's mailbox the target is that chat; in the tab,
          pick one of this host's chats first; a bare project view has no
          single target, so it reads only. */}
      {(filter?.session || (isTab && !filter?.project)) ? (
        <View style={{ flexDirection: "column", backgroundColor: t.surface, borderTopWidth: 1, borderTopColor: t.border, paddingHorizontal: 12, paddingVertical: 8 }}>
          {isTab ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: "row", gap: 6 }}>
                {targets.map((s) => (
                  <TouchableOpacity
                    key={s.id}
                    testID={`inbox-target-${s.id}`}
                    onPress={() => setTarget(target === s.id ? null : s.id)}
                    hitSlop={6}
                    style={[styles.filterChip, target === s.id && styles.filterChipActive]}
                  >
                    <Text style={[styles.filterChipText, target === s.id && styles.filterChipTextActive]} numberOfLines={1}>{s.name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
            <TextInput
              testID="inbox-composer"
              style={{
                flex: 1, backgroundColor: t.chipBg, borderRadius: 10,
                paddingHorizontal: 12, paddingVertical: 9, color: t.text, fontSize: 15, maxHeight: 96,
              }}
              placeholder={
                filter?.session
                  ? `Message ${title || "this chat"}…`
                  : target
                    ? `Message ${targets.find((s) => s.id === target)?.name || "…"}…`
                    : "Pick a chat, then message it…"
              }
              placeholderTextColor={t.textMuted}
              value={draft}
              onChangeText={setDraft}
              multiline
              numberOfLines={2}
            />
            <TouchableOpacity
              testID="inbox-compose-send"
              onPress={() => {
                const to = filter?.session ? `session:${filter.session}` : target ? `session:${target}` : null
                if (to) void send(to, 0, draft)
                else Alert.alert("Pick a chat", "Tap a chat chip above to choose who this message goes to.")
              }}
              disabled={sending || !draft.trim()}
              style={{
                justifyContent: "center", alignItems: "center", width: 40,
                backgroundColor: t.accent, borderRadius: 10,
                opacity: sending || !draft.trim() ? 0.5 : 1,
              }}
              hitSlop={8}
            >
              <Icon name="send" size={18} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      <SheetModal visible={snoozeFor != null} onClose={() => setSnoozeFor(null)}>
        <Text style={styles.sheetTitle}>Not now — snooze for</Text>
        {SNOOZE_OPTIONS.map((o) => (
          <TouchableOpacity key={o.hours} testID={`snooze-${o.hours}`} onPress={() => void snooze(o.hours)}
            style={{ paddingHorizontal: 18, paddingVertical: 12 }}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }}>{o.label}</Text>
          </TouchableOpacity>
        ))}
        <Text style={{ color: t.textMuted, fontSize: 13, paddingHorizontal: 18, paddingBottom: 8 }}>
          Snoozed is not dropped — it resurfaces when the snooze lapses.
        </Text>
      </SheetModal>
    </KeyboardAvoidingView>
  )
}
