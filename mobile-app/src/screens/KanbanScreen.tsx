import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import { Gesture, GestureDetector, ScrollView as GHScrollView } from "react-native-gesture-handler"
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type BoardColumn, type Card, type CardFilter, type OpenDecision } from "../api/client"
import { boardScopeFilter, groupByColumn, matchesQuery, nextPosition } from "../lib/board"
import { fmtWaiting } from "../lib/decisions"
import { setToken } from "../state/config"
import Icon from "../components/Icon"
import { useDecisionCockpit } from "../components/useDecisionCockpit"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
import { userError } from "../lib/errors"

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
  decisions: OpenDecision[]
  loading: boolean
  error: string
}
const emptySnapshot = (scope: Scope): Snapshot => ({ scope, columns: [], cards: [], decisions: [], loading: true, error: "" })

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
  const st = useStyles()
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
  // Height of the horizontal strip the columns live in, measured on layout —
  // the ceiling that makes a tall column scroll vertically instead of
  // overflowing off-screen. Re-measured when the band/error banner toggles.
  const [viewportH, setViewportH] = useState(0)
  const [query, setQuery] = useState("") // find box: "#107" or words
  // Draft text and measured bounds belong to the lifetime, not reusable state.
  const [, redrawDraft] = useState(0)
  const { columns, cards, decisions, loading, error } = snapshot.scope === scope ? snapshot : emptySnapshot(scope)
  const adding = scope.draft?.column
  const newTitle = scope.draft?.title || ""
  const colBounds = scope.bounds

  const load = useCallback(async () => {
    if (!isCurrent() || !scope.filter) return
    const generation = ++scope.generation
    const current = () => isCurrent() && generation === scope.generation
    setSnapshot(cur => ({ ...(cur.scope === scope ? cur : emptySnapshot(scope)), error: "" }))
    try {
      const [b, c, d] = await Promise.all([
        api.orgBoard({ project: scope.filter.project, session: scope.filter.session }),
        api.orgCards(scope.filter),
        // The queue is system-wide (every session's open question/plan/approval),
        // not this filter's — a failed read must not hide the board, so it
        // degrades to "no open decisions" rather than erroring the poll.
        api.openDecisions().catch(() => ({ count: 0, decisions: [] as OpenDecision[] })),
      ])
      if (!current()) return
      setSnapshot({ scope, columns: b.columns || [], cards: c.cards || [], decisions: d.decisions || [], loading: false, error: "" })
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

  // Stable per scope for the memoized rows (the 4s poll re-renders only changed cards),
  // yet bound to this scope's lifetime so a row captured under an old scope stays dead.
  const moveRef = useRef(moveCard)
  moveRef.current = moveCard
  const dropCard = useCallback((card: Card, colId: number) => {
    if (isCurrent()) moveRef.current(card, colId, 9999)
  }, [isCurrent])

  const cockpit = useDecisionCockpit(navigation, { onResolved: load, guard: isCurrent })
  const openCard = cockpit.openCard
  // Open the cockpit at the tapped item over the queue as it stands now.
  const openCockpit = useCallback((index: number) => cockpit.open(decisions, index), [cockpit.open, decisions])

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
      if (isCurrent()) setSnapshot(cur => ({ ...cur, error: userError(e, "the card", "create") }))
    }
  }

  if (!scope.filter) {
    return <View testID="kanban-unavailable" style={st.screen}><Text style={st.kbCardTitle}>Open a board from a chat or project.</Text></View>
  }

  if (loading) {
    return (
      <View style={st.center}>
        <ActivityIndicator />
      </View>
    )
  }

  // The find box narrows what is SHOWN; moves still position against the full
  // card list, so a move into a filtered column lands after its hidden cards.
  const shown = cards.filter((c) => matchesQuery(c, query))
  const grouped = groupByColumn(shown, columns)

  return (
    <View testID="kanban-board" style={st.page}>
      {error ? (
        <Text style={st.errorBanner}>{error}</Text>
      ) : null}
      {decisions.length ? (
        <DecisionBand decisions={decisions} theme={t} onOpen={openCockpit} />
      ) : null}
      <View style={st.kbFind}>
        <Icon name="search" size={14} color={t.textMuted} />
        <TextInput
          testID="kanban-find"
          value={query}
          onChangeText={setQuery}
          placeholder="Find #107 or words"
          placeholderTextColor={t.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          // Go on a single hit opens it — "#107" + Go jumps straight to the card.
          onSubmitEditing={() => { if (shown.length === 1) navigation.navigate("CardDetail", { id: shown[0].id }) }}
          style={st.kbFindInput}
        />
        {query ? (
          <Pressable onPress={() => setQuery("")} hitSlop={8} testID="kanban-find-clear">
            <Icon name="close" size={14} color={t.textMuted} />
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        horizontal
        style={{ flex: 1 }}
        contentContainerStyle={st.kbLanes}
        showsHorizontalScrollIndicator={false}
        onLayout={(ev) => { if (isCurrent()) setViewportH(ev.nativeEvent.layout.height) }}
      >
        {grouped.map(({ column, cards: colCards }) => (
          <View
            key={column.id}
            onLayout={(ev) => {
              if (!isCurrent()) return
              const { x, width } = ev.nativeEvent.layout
              colBounds.current[column.id] = { x, w: width }
            }}
            style={[st.kbColumn, { width: COL_W, maxHeight: viewportH ? viewportH - 20 : undefined }]}
          >
            <View style={st.kbColumnHead}>
              <Text style={st.kbColumnName}>
                {column.name} <Text style={st.kbColumnCount}>{colCards.length}</Text>
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
                style={st.kbNewCard}
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

            <GHScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
              {colCards.map((card) => (
                <DraggableCard
                  key={card.id}
                  card={card}
                  theme={t}
                  commentCount={card.comment_count ?? 0}
                  colBounds={colBounds}
                  columns={columns}
                  onDrop={dropCard}
                  onTap={openCard}
                />
              ))}
              {!colCards.length ? (
                <Text style={st.kbEmpty}>No cards</Text>
              ) : null}
            </GHScrollView>
          </View>
        ))}
      </ScrollView>
      {cockpit.element}
    </View>
  )
}

/**
 * The board's decision band (card #60): every OPEN decision across all
 * sessions — questions, plan approvals, tool Allow/Deny, cards parked for the
 * owner — oldest first, with the total count. Tapping an item opens the
 * DecisionCockpit at that item, where the owner decides IN PLACE (approve/deny,
 * answer, skip, browse) without leaving the board. The cockpit uses the same
 * race-safe per-session routes the thread does — the band and cockpit are
 * delivery surfaces, never a second decision store. Rendered only when
 * non-empty, so the board stays clean for the common case.
 */
const DECISION_ICON: Record<OpenDecision["kind"], "help" | "file" | "shield" | "clipboard" | "warning"> = {
  question: "help",
  plan: "file",
  approval: "shield",
  card: "clipboard",
  red: "warning",
}

function DecisionBand({
  decisions,
  theme: t,
  onOpen,
}: {
  decisions: OpenDecision[]
  theme: ReturnType<typeof useTheme>
  onOpen: (index: number) => void
}) {
  const st = useStyles()
  return (
    <View style={st.kbBand}>
      <Text style={st.kbBandTitle}>
        Decisions <Text style={st.kbBandCount}>{decisions.length}</Text>
        <Text style={st.kbBandHint}> · tap to decide</Text>
      </Text>
      <ScrollView style={st.kbBandList} contentContainerStyle={st.kbBandListContent}>
        {decisions.map((d, i) => (
          <Pressable
            key={`${d.kind}:${d.session}:${d.tool_use_id || d.id || d.run_id}`}
            testID={`decision-${d.kind}-${d.session}`}
            onPress={() => onOpen(i)}
            style={st.kbBandRow}
          >
            <Icon name={DECISION_ICON[d.kind] || "help"} size={16} color={t.accent} />
            <View style={{ flex: 1 }}>
              <Text style={st.kbBandRowTitle} numberOfLines={1}>
                {d.kind === "card" ? d.summary : d.label || d.session.slice(0, 8)}
                {d.host !== "local" ? ` · ${d.host}` : ""}
              </Text>
              <Text style={st.kbSmallMuted} numberOfLines={1}>
                {d.kind === "card"
                  ? `${d.column} · ${d.label || "agent"} is waiting on you`
                  : d.summary || "waiting for a decision"}
              </Text>
            </View>
            <Text style={[st.kbSmallMuted, { flexShrink: 0 }]}>
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
 * onTap (card detail). Spring back to origin on
 * release regardless — the list re-renders from state, so no stale transform.
 */
type DraggableCardProps = {
  card: Card
  theme: ReturnType<typeof useTheme>
  commentCount?: number
  colBounds: React.MutableRefObject<Record<number, { x: number; w: number }>>
  columns: BoardColumn[]
  onDrop: (card: Card, columnId: number) => void
  onTap: (cardId: number) => void
}

// Each poll hands over fresh card objects, so compare what the row draws.
const DraggableCard = React.memo(DraggableCardRow, (a, b) =>
  a.card.id === b.card.id && a.card.title === b.card.title && a.card.column_id === b.card.column_id
  && a.commentCount === b.commentCount && a.theme === b.theme
  && a.columns.length === b.columns.length && a.columns.every((c, i) => c.id === b.columns[i].id)
  && a.onDrop === b.onDrop && a.onTap === b.onTap)

function DraggableCardRow({ card, theme: t, commentCount, colBounds, columns, onDrop, onTap }: DraggableCardProps) {
  const st = useStyles()
  const onDropColumn = (columnId: number) => onDrop(card, columnId)
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
          onPress={() => onTap(card.id)}
          style={st.kbCard}
        >
          <Text style={st.kbCardTitle} numberOfLines={3}>
            <Text style={st.kbMuted}>#{card.id} </Text>{card.title}
          </Text>
          <View style={st.kbCardMeta}>
            {commentCount ? (
              <View style={st.kbCardStat}>
                <Icon name="chat" size={12} color={t.textMuted} />
                <Text style={st.kbSmallMuted}>{commentCount}</Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      </Animated.View>
    </GestureDetector>
  )
}
