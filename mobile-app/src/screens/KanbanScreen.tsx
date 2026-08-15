import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import { Gesture, GestureDetector } from "react-native-gesture-handler"
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type BoardColumn, type Card, type Employee } from "../api/client"
import { groupByColumn, nextPosition } from "../lib/board"
import { setToken } from "../state/config"
import Icon from "../components/Icon"
import { useTheme } from "../lib/useTheme"

type Props = NativeStackScreenProps<RootStackParamList, "Kanban">

const COL_W = 260 // column width; horizontal strip scrolls

/**
 * KanbanScreen — the org's ONE canonical board rendered as a filtered VIEW.
 * Reached filtered (swipe a chat row → its session) or unfiltered (CEO dashboard).
 * Horizontal columns; cards are draggable (react-native-gesture-handler Pan +
 * reanimated — the one place drag-and-drop is justified, kept local to this screen)
 * with a tap→move menu fallback. Moves compute a fractional position via the pure
 * lib (lib/board.nextPosition, identical to the server) then POST card_move.
 */
export default function KanbanScreen({ route, navigation }: Props) {
  const t = useTheme()
  const filter = {
    session: route.params?.session,
    project: route.params?.project,
    assignee: route.params?.assignee,
  }
  const [columns, setColumns] = useState<BoardColumn[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [adding, setAdding] = useState<number | null>(null) // column id we're adding a card to
  const [newTitle, setNewTitle] = useState("")

  // Measured x-range of each column (screen coords) so a drop can be mapped to a
  // column. Filled by each column's onLayout.
  const colBounds = useRef<Record<number, { x: number; w: number }>>({})

  const load = useCallback(async () => {
    setError("")
    try {
      const [b, c, e] = await Promise.all([
        api.orgBoard(),
        api.orgCards(filter),
        api.orgEmployees().catch(() => ({ employees: [] as Employee[] })),
      ])
      setColumns(b.columns || [])
      setCards(c.cards || [])
      setEmployees(e.employees || [])
    } catch (err) {
      const e = err as Error & { status?: number }
      if (e.status === 401) {
        setToken(null)
        navigation.replace("Login")
        return
      }
      setError(e.message)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.session, route.params?.project, route.params?.assignee])

  useEffect(() => {
    load()
    const id = setInterval(load, 4000) // silent refresh, mirrors ChatsScreen
    return () => clearInterval(id)
  }, [load])

  useEffect(() => {
    navigation.setOptions({ title: route.params?.title || "Board" })
  }, [navigation, route.params?.title])

  // Perform a move: compute the fractional position for the drop and persist.
  const moveCard = useCallback(
    async (card: Card, toColumn: number, indexInColumn: number) => {
      const inCol = cards.filter((c) => c.column_id === toColumn && c.id !== card.id)
      const position = nextPosition(inCol, indexInColumn)
      // Optimistic: update local state, reconcile on next poll.
      setCards((cur) => cur.map((c) => (c.id === card.id ? { ...c, column_id: toColumn, position } : c)))
      try {
        await api.orgMoveCard({ card_id: card.id, column_id: toColumn, position })
      } catch {
        load() // revert to server truth on failure
      }
    },
    [cards, load]
  )

  const promptMove = useCallback(
    (card: Card) => {
      const others = columns.filter((c) => c.id !== card.column_id)
      Alert.alert(
        card.title,
        "Move to column",
        [
          ...others.map((col) => ({ text: col.name, onPress: () => moveCard(card, col.id, 9999) })),
          { text: "Cancel", style: "cancel" as const },
        ]
      )
    },
    [columns, moveCard]
  )

  const promptAssign = useCallback(
    (card: Card) => {
      if (!employees.length) return
      Alert.alert(
        card.title,
        "Assign to",
        [
          ...employees.map((e) => ({
            text: e.name,
            onPress: async () => {
              setCards((cur) => cur.map((c) => (c.id === card.id ? { ...c, assignee: e.id } : c)))
              try {
                await api.orgAssignCard({ card_id: card.id, assignee: e.id })
              } catch {
                load()
              }
            },
          })),
          { text: "Cancel", style: "cancel" as const },
        ]
      )
    },
    [employees, load]
  )

  async function addCard(columnId: number) {
    const title = newTitle.trim()
    if (!title) { setAdding(null); return }
    setNewTitle("")
    setAdding(null)
    try {
      await api.orgCreateCard({ title, column_id: columnId, session: filter.session, project_id: filter.project })
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    )
  }

  const grouped = groupByColumn(cards, columns)
  const empName = (id: number | null) => employees.find((e) => e.id === id)?.name

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {error ? (
        <Text style={{ color: t.danger, padding: 12 }}>{error}</Text>
      ) : null}
      <ScrollView horizontal contentContainerStyle={{ padding: 10, gap: 10 }} showsHorizontalScrollIndicator={false}>
        {grouped.map(({ column, cards: colCards }) => (
          <View
            key={column.id}
            onLayout={(ev) => {
              const { x, width } = ev.nativeEvent.layout
              colBounds.current[column.id] = { x, w: width }
            }}
            style={{ width: COL_W, backgroundColor: t.surface, borderRadius: 12, borderWidth: 1, borderColor: t.border, padding: 8 }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <Text style={{ color: t.text, fontWeight: "700", fontSize: 14 }}>
                {column.name} <Text style={{ color: t.textMuted, fontWeight: "500" }}>{colCards.length}</Text>
              </Text>
              {column.id > 0 ? (
                <TouchableOpacity testID={`kanban-add-${column.id}`} onPress={() => { setAdding(column.id); setNewTitle("") }} hitSlop={8}>
                  <Icon name="add" size={18} color={t.accent} />
                </TouchableOpacity>
              ) : null}
            </View>

            {adding === column.id ? (
              <TextInput
                testID="kanban-new-card"
                style={{ backgroundColor: t.inputBg, color: t.text, borderRadius: 8, padding: 8, marginBottom: 6, borderWidth: 1, borderColor: t.border }}
                placeholder="Card title…"
                placeholderTextColor={t.textMuted}
                value={newTitle}
                onChangeText={setNewTitle}
                autoFocus
                onSubmitEditing={() => addCard(column.id)}
                onBlur={() => addCard(column.id)}
                returnKeyType="done"
              />
            ) : null}

            {colCards.map((card, i) => (
              <DraggableCard
                key={card.id}
                card={card}
                theme={t}
                index={i}
                columnCount={colCards.length}
                assigneeName={empName(card.assignee)}
                colBounds={colBounds}
                columns={columns}
                onDropColumn={(colId) => moveCard(card, colId, 9999)}
                onTap={() => promptMove(card)}
                onLongPress={() => promptAssign(card)}
              />
            ))}
            {!colCards.length ? (
              <Text style={{ color: t.textMuted, fontSize: 12, fontStyle: "italic", padding: 8 }}>No cards</Text>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

/**
 * A single draggable card. Drag horizontally past a column boundary → onDropColumn
 * with the target column id (computed from the measured colBounds). A plain tap →
 * onTap (move menu); long-press → onLongPress (assign). Spring back to origin on
 * release regardless — the list re-renders from state, so no stale transform.
 */
function DraggableCard({
  card, theme: t, assigneeName, colBounds, columns, onDropColumn, onTap, onLongPress,
}: {
  card: Card
  theme: ReturnType<typeof useTheme>
  index: number
  columnCount: number
  assigneeName?: string
  colBounds: React.MutableRefObject<Record<number, { x: number; w: number }>>
  columns: BoardColumn[]
  onDropColumn: (columnId: number) => void
  onTap: () => void
  onLongPress: () => void
}) {
  const tx = useSharedValue(0)
  const ty = useSharedValue(0)
  const dragging = useSharedValue(0)

  const settle = useCallback(
    (absX: number) => {
      // Find the column whose measured x-range contains the drop point.
      let target: number | null = null
      for (const col of columns) {
        const b = colBounds.current[col.id]
        if (b && absX >= b.x && absX <= b.x + b.w) { target = col.id; break }
      }
      if (target != null && target !== card.column_id) onDropColumn(target)
    },
    [card.column_id, columns, colBounds, onDropColumn]
  )

  const pan = Gesture.Pan()
    .activateAfterLongPress(120)
    .onStart(() => {
      dragging.value = 1
    })
    .onUpdate((e) => {
      tx.value = e.translationX
      ty.value = e.translationY
    })
    .onEnd((e) => {
      runOnJS(settle)(e.absoluteX)
      tx.value = withSpring(0)
      ty.value = withSpring(0)
      dragging.value = 0
    })

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }],
    zIndex: dragging.value ? 10 : 0,
    opacity: dragging.value ? 0.92 : 1,
  }))

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={style}>
        <Pressable
          testID={`kanban-card-${card.id}`}
          onPress={onTap}
          onLongPress={onLongPress}
          delayLongPress={300}
          style={{ backgroundColor: t.bubbleAgent, borderRadius: 10, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: t.border }}
        >
          <Text style={{ color: t.text, fontSize: 14 }} numberOfLines={3}>{card.title}</Text>
          {assigneeName ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 }}>
              <Icon name="user" size={12} color={t.textMuted} />
              <Text style={{ color: t.textMuted, fontSize: 12 }}>{assigneeName}</Text>
            </View>
          ) : null}
        </Pressable>
      </Animated.View>
    </GestureDetector>
  )
}
