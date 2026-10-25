import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import { useHeaderHeight } from "@react-navigation/elements"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, isQueued, type BoardColumn, type Card, type CardComment, type OrgProject } from "../api/client"
import { setToken, username } from "../state/config"
import { formatActor, type ActorKind } from "../lib/board"
import Icon from "../components/Icon"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"

type Props = NativeStackScreenProps<RootStackParamList, "CardDetail">

/**
 * CardDetailScreen — one card, in the open: its body, its column (tappable
 * chips to move it — the decision states included), and its
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
  // Fetched only when the card resolves to no board: the projects it can be
  // attached to (the attach action turns the dead card into a movable one).
  const [projects, setProjects] = useState<OrgProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  // Outcome of the owner's last action (move/attach/delete), shown inline —
  // kept apart from `error` so the 4s silent refresh never wipes it.
  const [notice, setNotice] = useState<{ text: string; tone: "error" | "info" } | null>(null)
  const [newComment, setNewComment] = useState("")
  const [posting, setPosting] = useState(false)
  const postPending = useRef(false)
  const [moving, setMoving] = useState(false)
  const movePending = useRef(false)
  const [attaching, setAttaching] = useState(false)
  const attachPending = useRef(false)
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
      setNotice(null)
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
        setNotice({ tone: "error", text: "Could not move the card. Check its column above before trying again." })
      } finally {
        movePending.current = false
        setMoving(false)
      }
    },
    [card, navigation]
  )

  // The card resolves to NO board (no project of its own, and its session has
  // none bound — e.g. a legacy card from before project binding, or one left
  // behind before project deletes moved cards): it cannot be moved. Fetch the
  // project list once so the owner can attach it; card_update is green, the attach lands at once.
  useEffect(() => {
    if (!card || columns.length) return
    api.orgProjects().then((r) => setProjects(r.projects || [])).catch(() => {})
  }, [card, columns.length])

  const attach = useCallback(
    async (projectId: number) => {
      if (!card || attachPending.current) return
      attachPending.current = true
      setAttaching(true)
      setNotice(null)
      try {
        try {
          await api.orgUpdateCard({ card_id: card.id, project_id: projectId })
        } catch (e) {
          if ((e as { status?: number })?.status === 401) {
            setToken(null)
            navigation.replace("Login")
            return
          }
          setNotice({ tone: "error", text: "Could not attach the card to that project. Please try again." })
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
          setNotice(null)
          try {
            const r = await api.orgDeleteCard({ card_id: card.id })
            if (isQueued(r)) {
              setNotice({ tone: "info", text: "Deletion is waiting for the owner's approval. The card stays until then." })
              return
            }
            if (r.deleted) navigation.goBack()
            else setNotice({ tone: "error", text: "Deletion was not confirmed. The card may already be gone; pull back to the board to check." })
          } catch (e) {
            if ((e as { status?: number })?.status === 401) {
              setToken(null)
              navigation.replace("Login")
              return
            }
            setNotice({ tone: "error", text: "Could not delete the card. Please try again." })
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
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    )
  }
  if (!card) return (
    <View testID="card-detail-unavailable" style={styles.cdUnavailable}>
      <Text accessibilityRole="header" style={styles.cdUnavailableTitle}>Card unavailable</Text>
      <Text accessibilityLiveRegion="polite" style={styles.cdUnavailableBody}>{error || "This card could not be loaded."}</Text>
      <Pressable testID="card-detail-retry" accessibilityRole="button" onPress={() => { setLoading(true); void load() }} style={styles.cdAction}>
        <Text style={styles.cdActionText}>Try again</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => navigation.goBack()} style={styles.cdAction}>
        <Text style={styles.cdActionText}>Go back</Text>
      </Pressable>
    </View>
  )

  const fmt = (ts: number) => new Date(ts * 1000).toLocaleString()
  // Principal strings ("user:ram", "session:Harman") rendered for a
  // person — the same rule the web card detail uses (lib/board.ts).
  const self = username()
  const creator = formatActor(card.created_by, self)

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={headerHeight}
    >
      {error ? <Text style={styles.errorBanner}>{error}</Text> : null}
      {notice ? (
        <Text testID="card-detail-notice" accessibilityLiveRegion="polite"
          style={notice.tone === "error" ? styles.errorBanner : styles.infoBanner}>{notice.text}</Text>
      ) : null}

      <ScrollView
        ref={sheet}
        style={{ flex: 1 }}
        contentContainerStyle={styles.cdContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.cdHead}>
          <Text style={styles.cdTitle}>
            <Text style={styles.cdTitleId}>#{card.id} </Text>{card.title}
          </Text>
          <Pressable onPress={deleteCard} hitSlop={8} testID="card-detail-delete">
            <Icon name="trash" size={18} color={t.danger} />
          </Pressable>
        </View>

        {card.body ? (
          <Text style={styles.cdBody}>{card.body}</Text>
        ) : null}

        <Text style={styles.cdMeta}>
          opened by <ActorName name={creator.name} kind={creator.kind} /> · {fmt(card.created_at)}
        </Text>

        {/* the pipeline in one row: tap a column to move the card there. When
            the card resolves to no board, this becomes the attach-to-project
            picker instead — a card is never left without a way to move it. */}
        <View>
          {columns.length ? (
            <>
              <Text style={styles.cdSectionLabel}>MOVE TO</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cdChips}>
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
                      style={[styles.cdChip, active && styles.cdChipActive, moving && styles.dimmed]}
                    >
                      <Text style={[styles.cdChipText, active && styles.cdChipTextActive]}>
                        {col.name}
                      </Text>
                    </Pressable>
                  )
                })}
              </ScrollView>
            </>
          ) : (
            <>
              <Text style={styles.cdSectionLabel}>
                ON NO BOARD — ATTACH TO A PROJECT
              </Text>
              {projects.length ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cdChips}>
                  {projects.map((p) => (
                    <Pressable
                      key={p.id}
                      onPress={() => attach(p.id)}
                      testID={`card-detail-project-${p.id}`}
                      disabled={attaching}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: attaching, busy: attaching }}
                      style={[styles.cdChip, attaching && styles.dimmed]}
                    >
                      <Text style={styles.cdChipText}>
                        {p.name}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : (
                <Text style={styles.cdEmpty}>
                  No projects exist yet — create one first, then this card can join a board.
                </Text>
              )}
            </>
          )}
        </View>

        <View style={styles.cdRule} />

        {comments.length ? (
          comments.map((c) => {
            const who = formatActor(c.author, self)
            return (
              <View key={c.id} style={[styles.cdComment, who.kind === "agent" && styles.cdCommentAgent]}>
                <View style={styles.cdCommentHead}>
                  <ActorName name={who.name} kind={who.kind} />
                  <Text style={styles.cdCommentTime}>{fmt(c.created_at)}</Text>
                </View>
                <Text style={styles.cdBody}>{c.body}</Text>
              </View>
            )
          })
        ) : (
          <Text style={styles.cdEmpty}>No comments yet — start the discussion.</Text>
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
            {posting ? <ActivityIndicator color={t.onAccent} size="small" /> : <Icon name="send" size={19} color={t.onAccent} />}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

/** One actor rendered for a person: the reader sees "you", other humans their
 *  name, agents get a small "agent" marker. The rule is formatActor in
 *  lib/board.ts (shared with the web card detail) — this is display only. */
function ActorName({ name, kind }: { name: string; kind: ActorKind }) {
  const styles = useStyles()
  return (
    <View style={styles.cdActor}>
      <Text style={styles.cdActorName}>{kind === "you" ? "you" : name}</Text>
      {kind === "agent" ? (
        <Text style={styles.cdActorAgent}>agent</Text>
      ) : null}
    </View>
  )
}
