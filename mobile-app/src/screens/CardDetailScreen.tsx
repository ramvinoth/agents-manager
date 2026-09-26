import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import { useHeaderHeight } from "@react-navigation/elements"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, isQueued, type BoardColumn, type Card, type CardComment, type Employee, type OrgProject } from "../api/client"
import { setToken } from "../state/config"
import Icon from "../components/Icon"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "CardDetail">

/**
 * CardDetailScreen — one card, in the open: its body, its column (tappable
 * chips to move it — the decision states included), its assignee, and its
 * comment thread — the conversation between the owner and the card's session.
 *
 * This is the pickup surface of the board's decision pipeline: the owner moves
 * the card to Review/Approved/Declined from here (or by dragging on the board)
 * and comments here to talk; the card's session wakes on that (boardwatch).
 * Polls like the board; missing or inaccessible cards show a safe retry state.
 *
 * The composer is the SAME one as the thread screen (styles.ts composerWrap/
 * composerBar/composerInput/circleBtn) — the app has one input pattern, and it
 * is the one that sits right above the soft keyboard: a KeyboardAvoidingView
 * with the real header height (ThreadScreen's pattern), safe-area bottom
 * padding, and the send button bottom-aligned in its row.
 */
export default function CardDetailScreen({ route, navigation }: Props) {
  const t = useTheme()
  const styles = useStyles()
  const insets = useSafeAreaInsets()
  // The real header height, like the thread screen — this is what makes the
  // keyboard land flush against the composer instead of covering it.
  const headerHeight = useHeaderHeight()
  const id = route.params.id
  const [card, setCard] = useState<Card | null>(null)
  const [comments, setComments] = useState<CardComment[]>([])
  const [columns, setColumns] = useState<BoardColumn[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  // Fetched only when the card resolves to no board: the projects it can be
  // attached to (the attach action turns the dead card into a movable one).
  const [projects, setProjects] = useState<OrgProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [newComment, setNewComment] = useState("")
  const [posting, setPosting] = useState(false)
  const postPending = useRef(false)
  const [moving, setMoving] = useState(false)
  const movePending = useRef(false)
  const [attaching, setAttaching] = useState(false)
  const attachPending = useRef(false)
  const [assigning, setAssigning] = useState(false)
  const assignPending = useRef(false)
  const draftRevision = useRef(0)
  const sheet = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const lastCommentCount = useRef(0)
  const reads = useRef({ issued: 0, applied: 0 })

  const load = useCallback(async () => {
    const request = ++reads.current.issued
    try {
      const r = await api.orgCard(id)
      // A slow poll must not undo a newer completed refresh. Still accept a
      // completed read while the next poll is pending, so slow links can load.
      if (request < reads.current.applied) return
      reads.current.applied = request
      if (r.card) {
        setError("")
        setCard(r.card)
        setComments(r.comments || [])
        // The card's move options come WITH the card: the server resolves the
        // board (the card's own project, else its session's bound one) and
        // returns its columns — one round trip, no client-side re-derivation.
        setColumns(r.columns || [])
      } else {
        setCard(null)
        setComments([])
        setColumns([])
        setError("This card is unavailable. It may have been removed or you may no longer have access.")
      }
    } catch (err) {
      if (request < reads.current.applied) return
      reads.current.applied = request
      const e = err as Error & { status?: number }
      if (e.status === 401) {
        setToken(null)
        navigation.replace("Login")
        return
      }
      if (e.status === 403 || e.status === 404) {
        setCard(null)
        setComments([])
        setColumns([])
        setError("This card is unavailable. It may have been removed or you may no longer have access.")
        return
      }
      setError("Could not refresh this card. Check your connection and try again.")
    } finally {
      if (request === reads.current.applied) setLoading(false)
    }
  }, [id, navigation])

  useEffect(() => {
    load()
    api.orgEmployees().then((e) => setEmployees(e.employees || [])).catch(() => {})
  }, [load])

  useEffect(() => {
    const interval = setInterval(load, 4000) // silent refresh, mirrors the board
    return () => clearInterval(interval)
  }, [load])

  // Jump to the newest message when a NEW one lands (the thread grows) — not on
  // every silent poll, which would yank the reader's scroll back from an old
  // message they are still reading.
  useEffect(() => {
    if (comments.length !== lastCommentCount.current) {
      lastCommentCount.current = comments.length
      sheet.current?.scrollToEnd({ animated: true })
    }
  }, [comments])

  const move = useCallback(
    async (toColumn: number) => {
      if (!card || toColumn === card.column_id || movePending.current) return
      movePending.current = true
      setMoving(true)
      const prev = card
      const preview = { ...card, column_id: toColumn }
      setCard(preview)
      try {
        await api.orgMoveCard({ card_id: card.id, column_id: toColumn, position: 9999 })
      } catch (e) {
        // Roll back only this preview, never a newer refresh or another edit.
        setCard((current) => current === preview ? prev : current)
        if ((e as { status?: number })?.status === 401) {
          setToken(null)
          navigation.replace("Login")
          return
        }
        Alert.alert("Could not move card", "The move could not be confirmed. Refresh the card to check its current column before trying again.")
      } finally {
        movePending.current = false
        setMoving(false)
      }
    },
    [card, navigation]
  )

  // The card resolves to NO board (no project of its own, and its session has
  // none bound — e.g. a card created before project binding existed, or whose
  // project was deleted): it cannot be moved. Fetch the project list once so
  // the owner can attach it; card_update is green, the attach lands at once.
  useEffect(() => {
    if (!card || columns.length) return
    api.orgProjects().then((r) => setProjects(r.projects || [])).catch(() => {})
  }, [card, columns.length])

  const attach = useCallback(
    async (projectId: number) => {
      if (!card || attachPending.current) return
      attachPending.current = true
      setAttaching(true)
      try {
        try {
          await api.orgUpdateCard({ card_id: card.id, project_id: projectId })
        } catch (e) {
          if ((e as { status?: number })?.status === 401) {
            setToken(null)
            navigation.replace("Login")
            return
          }
          Alert.alert("Could not attach card", "The attachment could not be confirmed. Refresh the card to check its project before trying again.")
          return
        }
        // Fetch the authoritative card AND board together; there is no local
        // project preview to roll back over a newer refresh on failure.
        await load()
      } finally {
        attachPending.current = false
        setAttaching(false)
      }
    },
    [card, load, navigation]
  )

  const assign = useCallback(() => {
    if (!card || !employees.length || assignPending.current) return
    Alert.alert(card.title, "Assign to", [
      ...employees.map((e) => ({
        text: e.name,
        onPress: async () => {
          if (assignPending.current) return
          assignPending.current = true
          setAssigning(true)
          try {
            try {
              await api.orgAssignCard({ card_id: card.id, assignee: e.id })
            } catch (err) {
              if ((err as { status?: number })?.status === 401) {
                setToken(null)
                navigation.replace("Login")
                return
              }
              Alert.alert("Could not assign card", "The assignment could not be confirmed. Refresh the card to check its assignee before trying again.")
              return
            }
            await load()
          } finally {
            assignPending.current = false
            setAssigning(false)
          }
        },
      })),
      { text: "Cancel", style: "cancel" as const },
    ])
  }, [card, employees, load, navigation])

  const deleteCard = useCallback(() => {
    if (!card) return
    Alert.alert(card.title, "Delete this card?", [
      { text: "Cancel", style: "cancel" as const },
      {
        text: "Delete",
        style: "destructive" as const,
        onPress: async () => {
          // card_delete is Red: an approval back means the card stays until the
          // owner says so — say that out loud instead of pretending it vanished.
          try {
            const r = await api.orgDeleteCard({ card_id: card.id })
            if (isQueued(r)) {
              Alert.alert("Queued", "Deletion is queued for the owner's approval.")
              return
            }
            if (r.deleted) navigation.goBack()
            else Alert.alert("Deletion not confirmed", "The card may already have been removed. Refresh it to check its status.")
          } catch (e) {
            if ((e as { status?: number })?.status === 401) {
              setToken(null)
              navigation.replace("Login")
              return
            }
            Alert.alert("Could not delete card", "Deletion could not be confirmed. Please try again.")
          }
        },
      },
    ])
  }, [card, navigation])

  const post = useCallback(async () => {
    const body = newComment.trim()
    if (!body || !card || postPending.current) return
    postPending.current = true
    setPosting(true)
    const revision = draftRevision.current
    try {
      await api.orgAddCardComment({ card_id: card.id, body })
      // Only clear the submitted draft, never edits made while awaiting it.
      if (draftRevision.current === revision) setNewComment("")
    } catch (e) {
      if ((e as { status?: number })?.status === 401) {
        setToken(null)
        navigation.replace("Login")
        return
      }
      setError("Could not post your comment. Please try again.")
      return
    } finally {
      postPending.current = false
      setPosting(false)
    }
    // The write succeeded. A failed refresh must not present it as an unsent
    // draft and invite a duplicate; reuse the normal safe card-read handling.
    await load()
  }, [card, newComment, load, navigation])

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    )
  }
  if (!card) return (
    <View testID="card-detail-unavailable" style={{ flex: 1, backgroundColor: t.bg, padding: 24, justifyContent: "center", gap: 16 }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 20, fontWeight: "600" }}>Card unavailable</Text>
      <Text accessibilityLiveRegion="polite" style={{ color: t.text, fontSize: 16 }}>{error || "This card could not be loaded."}</Text>
      <Pressable testID="card-detail-retry" accessibilityRole="button" onPress={() => { setLoading(true); void load() }} style={{ minHeight: 44, justifyContent: "center" }}>
        <Text style={{ color: t.text, fontSize: 17 }}>Try again</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => navigation.goBack()} style={{ minHeight: 44, justifyContent: "center" }}>
        <Text style={{ color: t.text, fontSize: 17 }}>Go back</Text>
      </Pressable>
    </View>
  )

  const assignee = employees.find((e) => e.id === card.assignee)?.name
  const fmt = (ts: number) => new Date(ts * 1000).toLocaleString()

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.bg }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={headerHeight}
    >
      {error ? <Text style={{ color: t.danger, padding: 12 }}>{error}</Text> : null}

      <ScrollView
        ref={sheet}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12, gap: 10 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
          <Text style={{ color: t.text, fontSize: 18, fontWeight: "700", flex: 1, marginRight: 8 }}>
            {card.title}
          </Text>
          <Pressable onPress={deleteCard} hitSlop={8} testID="card-detail-delete">
            <Icon name="trash" size={18} color={t.danger} />
          </Pressable>
        </View>

        {card.body ? (
          <Text style={{ color: t.text, fontSize: 14, lineHeight: 20 }}>{card.body}</Text>
        ) : null}

        {/* the pipeline in one row: tap a column to move the card there. When
            the card resolves to no board, this becomes the attach-to-project
            picker instead — a card is never left without a way to move it. */}
        <View>
          {columns.length ? (
            <>
              <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: 4 }}>MOVE TO</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                {columns.map((col) => {
                  const active = col.id === card.column_id
                  return (
                    <Pressable
                      key={col.id}
                      onPress={() => move(col.id)}
                      testID={`card-detail-col-${col.id}`}
                      disabled={moving}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: moving, busy: moving && active, selected: active }}
                      style={{
                        opacity: moving ? 0.6 : 1,
                        backgroundColor: active ? t.accent : t.surface,
                        borderWidth: 1,
                        borderColor: active ? t.accent : t.border,
                        borderRadius: 999,
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                      }}
                    >
                      <Text style={{ color: active ? "#fff" : t.text, fontSize: 12, fontWeight: "600" }}>
                        {col.name}
                      </Text>
                    </Pressable>
                  )
                })}
              </ScrollView>
            </>
          ) : (
            <>
              <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: 4 }}>
                ON NO BOARD — ATTACH TO A PROJECT
              </Text>
              {projects.length ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                  {projects.map((p) => (
                    <Pressable
                      key={p.id}
                      onPress={() => attach(p.id)}
                      testID={`card-detail-project-${p.id}`}
                      disabled={attaching}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: attaching, busy: attaching }}
                      style={{
                        opacity: attaching ? 0.6 : 1,
                        backgroundColor: t.surface,
                        borderWidth: 1,
                        borderColor: t.border,
                        borderRadius: 999,
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                      }}
                    >
                      <Text style={{ color: t.text, fontSize: 12, fontWeight: "600" }}>
                        {p.name}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : (
                <Text style={{ color: t.textMuted, fontSize: 12, fontStyle: "italic" }}>
                  No projects exist yet — create one first, then this card can join a board.
                </Text>
              )}
            </>
          )}
        </View>

        {assignee ? (
          <Pressable
            testID="card-detail-assign"
            onPress={assign}
            disabled={assigning}
            accessibilityRole="button"
            accessibilityState={{ disabled: assigning, busy: assigning }}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, opacity: assigning ? 0.6 : 1 }}
          >
            <Icon name="user" size={14} color={t.textMuted} />
            <Text style={{ color: t.textMuted, fontSize: 12 }}>
              {assignee} — tap to reassign
            </Text>
          </Pressable>
        ) : null}

        <View style={{ height: 1, backgroundColor: t.border, marginVertical: 4 }} />

        {comments.length ? (
          comments.map((c) => (
            <View key={c.id} style={{ backgroundColor: t.surface, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: t.border }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                <Text style={{ color: t.text, fontSize: 12, fontWeight: "700" }}>{c.author}</Text>
                <Text style={{ color: t.textMuted, fontSize: 11 }}>{fmt(c.created_at)}</Text>
              </View>
              <Text style={{ color: t.text, fontSize: 14, lineHeight: 20 }}>{c.body}</Text>
            </View>
          ))
        ) : (
          <Text style={{ color: t.textMuted, fontSize: 12, fontStyle: "italic" }}>No comments yet — start the discussion.</Text>
        )}
      </ScrollView>

      {/* Composer — the app's one input pattern (ThreadScreen's), so it aligns
          with the chat: hairline top border, pill input, circular send button
          bottom-aligned, and bottom padding that clears the home indicator. */}
      <View style={[styles.composerWrap, { paddingBottom: insets.bottom }]}>
        <View style={styles.composerBar}>
          <TextInput
            testID="card-detail-comment"
            style={[styles.composerInput, { backgroundColor: t.inputBg, color: t.text, borderColor: t.border }]}
            placeholder="Comment on this card…"
            placeholderTextColor={t.textMuted}
            value={newComment}
            onChangeText={(text) => { draftRevision.current++; setNewComment(text) }}
            multiline
          />
          <Pressable
            testID="card-detail-send"
            accessibilityLabel={posting ? "sending comment" : "send comment"}
            accessibilityState={{ disabled: posting || !newComment.trim(), busy: posting }}
            style={[styles.circleBtn, !posting && newComment.trim() ? styles.sendBtn : styles.sendBtnDisabled]}
            onPress={post}
            disabled={posting || !newComment.trim()}
          >
            {posting ? <ActivityIndicator color="#fff" size="small" /> : <Icon name="send" size={19} color="#fff" />}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}
