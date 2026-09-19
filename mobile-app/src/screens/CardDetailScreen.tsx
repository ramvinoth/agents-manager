import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, isQueued, type BoardColumn, type Card, type CardComment, type Employee } from "../api/client"
import { setToken } from "../state/config"
import Icon from "../components/Icon"
import { useTheme } from "../lib/useTheme"

type Props = NativeStackScreenProps<RootStackParamList, "CardDetail">

/**
 * CardDetailScreen — one card, in the open: its body, its column (tappable
 * chips to move it — the decision states included), its assignee, and its
 * comment thread — the conversation between the owner and the card's session.
 *
 * This is the pickup surface of the board's decision pipeline: the owner moves
 * the card to Review/Approved/Declined from here (or by dragging on the board)
 * and comments here to talk; the card's session wakes on that (boardwatch).
 * Polls like the board; a 404 means the card was deleted — go back.
 */
export default function CardDetailScreen({ route, navigation }: Props) {
  const t = useTheme()
  const id = route.params.id
  const [card, setCard] = useState<Card | null>(null)
  const [comments, setComments] = useState<CardComment[]>([])
  const [columns, setColumns] = useState<BoardColumn[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [newComment, setNewComment] = useState("")
  const sheet = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const lastCommentCount = useRef(0)

  const load = useCallback(async () => {
    setError("")
    try {
      const r = await api.orgCard(id)
      if (r.card) {
        setCard(r.card)
        setComments(r.comments || [])
        if (r.card.project_id != null) {
          const b = await api.orgBoard({ project: r.card.project_id }).catch(() => ({ columns: [] as BoardColumn[] }))
          setColumns(b.columns || [])
        }
      } else {
        navigation.goBack()
      }
    } catch (err) {
      const e = err as Error & { status?: number }
      if (e.status === 401) {
        setToken(null)
        navigation.replace("Login")
        return
      }
      if (e.status === 404) {
        navigation.goBack()
        return
      }
      setError(e.message)
    } finally {
      setLoading(false)
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
      if (!card || toColumn === card.column_id) return
      const prev = card
      setCard((c) => (c ? { ...c, column_id: toColumn } : c))
      try {
        await api.orgMoveCard({ card_id: card.id, column_id: toColumn, position: 9999 })
      } catch {
        setCard(prev)
      }
    },
    [card]
  )

  const assign = useCallback(() => {
    if (!card || !employees.length) return
    Alert.alert(card.title, "Assign to", [
      ...employees.map((e) => ({
        text: e.name,
        onPress: async () => {
          const prev = card
          setCard((c) => (c ? { ...c, assignee: e.id } : c))
          try {
            await api.orgAssignCard({ card_id: card.id, assignee: e.id })
          } catch {
            setCard(prev)
          }
        },
      })),
      { text: "Cancel", style: "cancel" as const },
    ])
  }, [card, employees])

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
          const r = await api.orgDeleteCard({ card_id: card.id }).catch(() => null)
          if (r && isQueued(r)) Alert.alert("Queued", "Deletion is queued for the owner's approval.")
          navigation.goBack()
        },
      },
    ])
  }, [card, navigation])

  const post = useCallback(async () => {
    const body = newComment.trim()
    if (!body || !card) return
    setNewComment("")
    try {
      await api.orgAddCardComment({ card_id: card.id, body })
      const r = await api.orgCard(id)
      setCard(r.card)
      setComments(r.comments || [])
    } catch (e) {
      setNewComment(body)
      setError((e as Error).message)
    }
  }, [card, newComment, id])

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    )
  }
  if (!card) return null

  const assignee = employees.find((e) => e.id === card.assignee)?.name
  const fmt = (ts: number) => new Date(ts * 1000).toLocaleString()

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {error ? <Text style={{ color: t.danger, padding: 12 }}>{error}</Text> : null}

      <ScrollView
        ref={sheet}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12, gap: 10 }}
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

        {/* the pipeline in one row: tap a column to move the card there */}
        <View>
          <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: 4 }}>MOVE TO</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {columns.map((col) => {
              const active = col.id === card.column_id
              return (
                <Pressable
                  key={col.id}
                  onPress={() => move(col.id)}
                  testID={`card-detail-col-${col.id}`}
                  style={{
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
        </View>

        {assignee ? (
          <Pressable onPress={assign} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
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

      {/* pinned composer */}
      <View style={{ flexDirection: "row", gap: 8, padding: 10, borderTopWidth: 1, borderColor: t.border, backgroundColor: t.surface }}>
        <TextInput
          testID="card-detail-comment"
          style={{ flex: 1, backgroundColor: t.inputBg, color: t.text, borderRadius: 8, padding: 10, borderWidth: 1, borderColor: t.border }}
          placeholder="Comment on this card…"
          placeholderTextColor={t.textMuted}
          value={newComment}
          onChangeText={setNewComment}
          multiline
          returnKeyType="send"
        />
        <Pressable onPress={post} hitSlop={8} disabled={!newComment.trim()} testID="card-detail-send">
          <Icon name="send" size={20} color={newComment.trim() ? t.accent : t.textMuted} />
        </Pressable>
      </View>
    </View>
  )
}
