import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import { Gesture, GestureDetector } from "react-native-gesture-handler"
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type BoardColumn, type Card, type CardFilter, type Employee, type OpenDecision } from "../api/client"
import { boardScopeFilter, groupByColumn, nextPosition } from "../lib/board"
import { fmtWaiting } from "../lib/decisions"
import { setToken } from "../state/config"
import Icon from "../components/Icon"
import { useTheme } from "../lib/useTheme"

type Props = NativeStackScreenProps<RootStackParamList, "Kanban">

const COL_W = 260 // column width; horizontal strip scrolls

type Scope = {
  key: string
  filter: CardFilter | null
  active: boolean
  generation: number
  bounds: React.MutableRefObject<Record<number, { x: number; w: number }>>
  draft: { column: number; title: string } | null
}
type Snapshot = {
  scope: Scope
  columns: BoardColumn[]
  cards: Card[]
  employees: Employee[]
  decisions: OpenDecision[]
  loading: boolean
  error: string
}
const emptySnapshot = (scope: Scope): Snapshot => ({ scope, columns: [], cards: [], employees: [], decisions: [], loading: true, error: "" })

/**
 * KanbanScreen — the org's ONE canonical board rendered as a filtered VIEW.
 * Only filtered entries exist: swipe a chat row → its session's board, or a
 * project row on the company screen → that project's board.
 * Horizontal columns; cards are draggable (react-native-gesture-handler Pan +
 * reanimated — the one place drag-and-drop is justified, kept local to this screen)
 * with a tap→card-detail fallback (its chips move the card; the move menu lived
 * there). Moves compute a fractional position via the pure
 * lib (lib/board.nextPosition, identical to the server) then POST card_move.
 * A top band (DecisionBand) lists the system-wide queue of open decisions —
 * questions, plans, tool approvals across ALL sessions — with the count; it
 * polls with the board and only opens the owning thread (the thread performs
 * the decision).
 */
export default function KanbanScreen({ route, navigation }: Props) {
  const t = useTheme()
  const filter = boardScopeFilter(route.params)
  const key = JSON.stringify([route.key, filter])
  const scopeRef = useRef<Scope | null>(null)
  // Invalidate during render, not in an effect: neither retained rows nor old
  // callbacks may belong to this route, even before effect cleanup runs. The
  // object identity distinguishes A → B → A from the original A lifetime.
  if (!scopeRef.current || scopeRef.current.key !== key) {
    if (scopeRef.current) scopeRef.current.active = false
    scopeRef.current = { key, filter, active: true, generation: 0, bounds: { current: {} }, draft: null }
  }
  const scope = scopeRef.current
  const isCurrent = useCallback(() => scope.active && scopeRef.current === scope, [scope])
  const [snapshot, setSnapshot] = useState<Snapshot>(() => emptySnapshot(scope))
  // Draft text and measured bounds belong to the lifetime, not reusable state.
  const [, redrawDraft] = useState(0)
  const { columns, cards, employees, decisions, loading, error } = snapshot.scope === scope ? snapshot : emptySnapshot(scope)
  const adding = scope.draft?.column
  const newTitle = scope.draft?.title || ""
  const colBounds = scope.bounds

  const load = useCallback(async () => {
    if (!isCurrent() || !scope.filter) return
    const generation = ++scope.generation
    const current = () => isCurrent() && generation === scope.generation
    setSnapshot(cur => ({ ...(cur.scope === scope ? cur : emptySnapshot(scope)), error: "" }))
    try {
      const [b, c, e, d] = await Promise.all([
        api.orgBoard({ project: scope.filter.project, session: scope.filter.session }),
        api.orgCards(scope.filter),
        api.orgEmployees().catch(() => ({ employees: [] as Employee[] })),
        // The queue is system-wide (every session's open question/plan/approval),
        // not this filter's — a failed read must not hide the board, so it
        // degrades to "no open decisions" rather than erroring the poll.
        api.openDecisions().catch(() => ({ count: 0, decisions: [] as OpenDecision[] })),
      ])
      if (!current()) return
      setSnapshot({ scope, columns: b.columns || [], cards: c.cards || [], employees: e.employees || [], decisions: d.decisions || [], loading: false, error: "" })
    } catch (err) {
      if (!current()) return
      const e = err as Error & { status?: number }
      if (e.status === 401) {
        setToken(null)
        navigation.replace("Login")
        return
      }
      setSnapshot(cur => ({ ...cur, error: e.message }))
    } finally {
      if (current()) setSnapshot(cur => ({ ...cur, loading: false }))
    }
  }, [scope, isCurrent, navigation])

  useEffect(() => {
    scope.active = true
    load()
    const id = scope.filter ? setInterval(load, 4000) : undefined
    return () => {
      scope.active = false
      scope.generation++
      if (id !== undefined) clearInterval(id)
    }
  }, [scope, load])

  useEffect(() => {
    navigation.setOptions({ title: route.params?.title || "Board" })
  }, [navigation, route.params?.title])

  // Perform a move: compute the fractional position for the drop and persist.
  const moveCard = useCallback(
    async (card: Card, toColumn: number, indexInColumn: number) => {
      if (!isCurrent()) return
      const inCol = cards.filter((c) => c.column_id === toColumn && c.id !== card.id)
      const position = nextPosition(inCol, indexInColumn)
      setSnapshot(cur => cur.scope === scope ? { ...cur, cards: cur.cards.map(c => c.id === card.id ? { ...c, column_id: toColumn, position } : c) } : cur)
      try {
        await api.orgMoveCard({ card_id: card.id, column_id: toColumn, position })
      } catch {
        if (isCurrent()) load() // revert to server truth on failure
      }
    },
    [cards, scope, isCurrent, load]
  )

  const openCard = useCallback(
    (card: Card) => { if (isCurrent()) navigation.navigate("CardDetail", { id: card.id }) },
    [navigation, isCurrent]
  )

  // Open the session that owns a queued decision — the same Thread route push
  // taps use (App.tsx's navToSession), resolved id → path on the decision's
  // host. Best-effort: a session that is no longer listed (or on an unreachable
  // host) no-ops rather than throwing.
  const openDecision = useCallback(
    async (d: OpenDecision) => {
      if (!isCurrent()) return
      const host = d.host || "local"
      try {
        const sessions = await api.sessions(host)
        const match = sessions.find((s) => s.id === d.session)
        if (match) {
          if (!isCurrent()) return
          navigation.navigate("Thread", { host, label: match.title || d.label || match.id.slice(0, 8), path: match.path })
        } else {
          Alert.alert(d.label || d.session.slice(0, 8), `This session is not listed on ${host} right now — open it from the chat list, or it will re-appear in the queue while it waits.`)
        }
      } catch {
        /* cross-host or offline: leave the item in the queue */
      }
    },
    [isCurrent, navigation]
  )

  const promptAssign = useCallback(
    (card: Card) => {
      if (!isCurrent() || !employees.length) return
      Alert.alert(
        card.title,
        "Assign to",
        [
          ...employees.map((e) => ({
            text: e.name,
            onPress: async () => {
              if (!isCurrent()) return
              setSnapshot(cur => cur.scope === scope ? { ...cur, cards: cur.cards.map(c => c.id === card.id ? { ...c, assignee: e.id } : c) } : cur)
              try {
                await api.orgAssignCard({ card_id: card.id, assignee: e.id })
              } catch {
                if (isCurrent()) load()
              }
            },
          })),
          { text: "Cancel", style: "cancel" as const },
        ]
      )
    },
    [employees, scope, isCurrent, load]
  )

  async function addCard(columnId: number) {
    if (!isCurrent() || !scope.filter || scope.draft?.column !== columnId) return
    const title = scope.draft.title.trim()
    // Consume synchronously: submit and blur can both fire before a render.
    scope.draft = null
    redrawDraft(n => n + 1)
    if (!title) return
    try {
      await api.orgCreateCard({ title, column_id: columnId, session: scope.filter.session, project_id: scope.filter.project })
      if (isCurrent()) load()
    } catch (e) {
      if (isCurrent()) setSnapshot(cur => ({ ...cur, error: (e as Error).message }))
    }
  }

  if (!scope.filter) {
    return <View testID="kanban-unavailable" style={{ flex: 1, backgroundColor: t.bg, padding: 16 }}><Text style={{ color: t.text }}>Open a board from a chat or project.</Text></View>
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
    <View testID="kanban-board" style={{ flex: 1, backgroundColor: t.bg }}>
      {error ? (
        <Text style={{ color: t.danger, padding: 12 }}>{error}</Text>
      ) : null}
      {decisions.length ? (
        <DecisionBand decisions={decisions} theme={t} onOpen={openDecision} />
      ) : null}
      <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ padding: 10, gap: 10 }} showsHorizontalScrollIndicator={false}>
        {grouped.map(({ column, cards: colCards }) => (
          <View
            key={column.id}
            onLayout={(ev) => {
              if (!isCurrent()) return
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
                <TouchableOpacity testID={`kanban-add-${column.id}`} onPress={() => { if (isCurrent()) { scope.draft = { column: column.id, title: "" }; redrawDraft(n => n + 1) } }} hitSlop={8}>
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
                onChangeText={(title) => { if (isCurrent() && scope.draft?.column === column.id) { scope.draft.title = title; redrawDraft(n => n + 1) } }}
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
                commentCount={card.comment_count ?? 0}
                colBounds={colBounds}
                columns={columns}
                onDropColumn={(colId) => moveCard(card, colId, 9999)}
                onTap={() => openCard(card)}
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
 * The board's decision band (card #60): every OPEN decision across all
 * sessions — questions, plan approvals, tool Allow/Deny — oldest first, with
 * the total count. Read-only here: tapping an item opens the owning session's
 * thread, where the existing decision UI (race-safe via the decisions gate)
 * performs the actual decision. This screen never writes a decision.
 * Rendered only when non-empty — an empty queue shows nothing, so the board
 * stays clean for the common case.
 */
const DECISION_ICON: Record<OpenDecision["kind"], "help" | "file" | "shield"> = {
  question: "help",
  plan: "file",
  approval: "shield",
}

function DecisionBand({
  decisions,
  theme: t,
  onOpen,
}: {
  decisions: OpenDecision[]
  theme: ReturnType<typeof useTheme>
  onOpen: (d: OpenDecision) => void
}) {
  return (
    <View style={{ backgroundColor: t.surface, borderBottomWidth: 1, borderBottomColor: t.border, paddingHorizontal: 12, paddingVertical: 8, gap: 6 }}>
      <Text style={{ color: t.text, fontWeight: "700", fontSize: 13 }}>
        Decisions <Text style={{ color: t.accent, fontWeight: "700" }}>{decisions.length}</Text>
        <Text style={{ color: t.textMuted, fontWeight: "400" }}> · tap to open its thread</Text>
      </Text>
      <ScrollView style={{ maxHeight: 140 }} contentContainerStyle={{ gap: 4 }}>
        {decisions.map((d) => (
          <Pressable
            key={`${d.kind}:${d.session}:${d.tool_use_id || d.id || d.run_id}`}
            testID={`decision-${d.kind}-${d.session}`}
            onPress={() => onOpen(d)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              backgroundColor: t.bg,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: t.border,
              padding: 8,
            }}
          >
            <Icon name={DECISION_ICON[d.kind] || "help"} size={16} color={t.accent} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
                {d.label || d.session.slice(0, 8)}
                {d.host !== "local" ? ` · ${d.host}` : ""}
              </Text>
              <Text style={{ color: t.textMuted, fontSize: 12 }} numberOfLines={1}>
                {d.summary || "waiting for a decision"}
              </Text>
            </View>
            <Text style={{ color: t.textMuted, fontSize: 12, flexShrink: 0 }}>
              {fmtWaiting(d.waiting_s)}
            </Text>
          </Pressable>
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
  card, theme: t, assigneeName, commentCount, colBounds, columns, onDropColumn, onTap, onLongPress,
}: {
  card: Card
  theme: ReturnType<typeof useTheme>
  index: number
  columnCount: number
  assigneeName?: string
  commentCount?: number
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
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
            {assigneeName ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Icon name="user" size={12} color={t.textMuted} />
                <Text style={{ color: t.textMuted, fontSize: 12 }}>{assigneeName}</Text>
              </View>
            ) : null}
            {commentCount ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                <Icon name="chat" size={12} color={t.textMuted} />
                <Text style={{ color: t.textMuted, fontSize: 12 }}>{commentCount}</Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      </Animated.View>
    </GestureDetector>
  )
}
