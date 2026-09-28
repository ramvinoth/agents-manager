import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  FlatList,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import { useHeaderHeight } from "@react-navigation/elements"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type PendingPlan, type PendingQuestion, type PermApproval, type SlashCommand } from "../api/client"
import { fmtDate, groupThread, itemPreview, itemUuid, parseTranscript, type ThreadItem } from "../lib/thread"
import { matchCommands, slashTerm } from "../lib/slash"
import { ensurePermission } from "../lib/notify"
import { composerPrefs, draftFor, serverUrl, setDraft, token } from "../state/config"
import { useTheme } from "../lib/useTheme"
import { buildReply, quotePreview } from "../lib/quote"
import { completesBoardSwipe, shouldClaimBoardSwipe } from "../lib/boardSwipe"
import { attachMessage, pickImage, uploadImage } from "../lib/attach"
import MessageActions, { type MsgTarget } from "../components/MessageActions"
import CapabilitiesDrawer from "../components/CapabilitiesDrawer"
import { findMatches, stepMatch } from "../lib/search"
import QuestionCard from "../components/QuestionCard"
import PlanCard from "../components/PlanCard"
import { ItemView, WorkingBubble } from "../components/ThreadItems"
import Icon from "../components/Icon"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "Thread">

// Sentinel appended to the list while a run is in flight (see WorkingBubble).
const WORKING = { kind: "working" as const, id: "__working__" }
type ListItem = ThreadItem | typeof WORKING

// A WhatsApp-style thread for one agent session. Each agent exchange shows its
// final response with the tool-call "steps" collapsed underneath (tap to expand,
// then tap a step to see its result). Composer: send / steer / queue, a
// permission-mode + model dropdown, and in-thread Allow/Deny cards.
export default function ThreadScreen({ route, navigation }: Props) {
  const { host, path, label, agent = "claude" } = route.params
  const [items, setItems] = useState<ThreadItem[]>([])
  const [loading, setLoading] = useState(true)
  // How many trailing transcript lines to fetch. Grows when the user scrolls to
  // the top of the (inverted) list to lazy-load older history. hasMoreRef tracks
  // whether the server still has older lines beyond the current window.
  const [windowLines, setWindowLines] = useState(400)
  const hasMoreRef = useRef(true)
  const loadingMoreRef = useRef(false)
  // Seed the composer from a persisted per-session draft so unsent text survives
  // navigating back and app restarts. Keyed by path (existing chats).
  const [input, setInput] = useState(() => draftFor(path || ""))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  // Legacy request preferences remain untouched. Explicit server AI configuration
  // wins during launch resolution; never coerce a full model ID against a catalog.
  const sendPrefs = () => {
    const p = composerPrefs()
    return { mode: p.mode, model: p.model }
  }
  const [pending, setPending] = useState<PermApproval[]>([])
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null)
  const [queued, setQueued] = useState(0)
  // A reused Thread route may still hold the last chat's state. Existing chats
  // derive identity from the route; new-chat responses belong to one lifetime,
  // not merely a matching path/key (A → B → A must not revive old responses).
  const routeLifetime = useMemo(() => ({}), [route.key, host, path, agent])
  const activeLifetime = useRef<object | null>(routeLifetime)
  activeLifetime.current = routeLifetime
  useLayoutEffect(() => {
    activeLifetime.current = routeLifetime
    return () => { if (activeLifetime.current === routeLifetime) activeLifetime.current = null }
  }, [routeLifetime])
  const isCurrentThread = useCallback(() => activeLifetime.current === routeLifetime, [routeLifetime])
  const [createdSession, setCreatedSession] = useState<{ lifetime: object; id: string } | null>(null)
  const sessionId = path
    ? (path.split("/").pop() || "").replace(/\.jsonl$/, "").trim()
    : createdSession?.lifetime === routeLifetime ? createdSession.id : ""
  const setSessionId = useCallback((id: string) => {
    if (isCurrentThread()) setCreatedSession({ lifetime: routeLifetime, id: id.trim() })
  }, [routeLifetime, isCurrentThread])
  // What the agent is doing right now (last streamed tool) — drives the header
  // subtitle and the live "working on it" bubble.
  const [activity, setActivity] = useState("")
  // Slash-command autocomplete + live queue contents.
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [queueList, setQueueList] = useState<string[]>([])
  const [msgAction, setMsgAction] = useState<MsgTarget | null>(null)
  // Pinned message uuids (persisted in session meta) + which one the banner shows.
  const [pinned, setPinned] = useState<string[]>([])
  const [bannerIdx, setBannerIdx] = useState(0)
  // The message currently being replied to; quoted into the outgoing text.
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [attaching, setAttaching] = useState(false)
  // In-thread search: query + which matched item is focused.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQ, setSearchQ] = useState("")
  const [searchAt, setSearchAt] = useState(-1)
  // RHS capabilities drawer (skills + MCP tools)
  const [capDrawerOpen, setCapDrawerOpen] = useState(false)
  const boardOpening = useRef(false)
  const transcriptRef = useRef<View>(null)
  const transcriptBounds = useRef({ left: 0, width: 0 })
  const boundsGeneration = useRef(0)
  const boardSwipeCancelled = useRef(false)
  const measureTranscript = useCallback(() => {
    const generation = ++boundsGeneration.current
    transcriptRef.current?.measureInWindow((left, _top, width) => {
      if (generation === boundsGeneration.current && width > 0) transcriptBounds.current = { left, width }
    })
  }, [])
  const openBoard = useCallback(() => {
    if (!isCurrentThread() || boardOpening.current || !navigation.isFocused()) return
    boardOpening.current = true
    // Unsent chats have no board context yet; preserve the project-picker fallback.
    if (sessionId) navigation.navigate("Kanban", { session: sessionId, title: label })
    else navigation.navigate("Org")
  }, [navigation, sessionId, label, isCurrentThread])
  const openNotes = useCallback(() => {
    if (sessionId) navigation.navigate("Notes", { session: sessionId, title: label })
    else navigation.navigate("Notes")
  }, [navigation, sessionId, label])
  const openInbox = useCallback(() => {
    if (sessionId) navigation.navigate("Inbox", { session: sessionId, host, path, title: label })
    else navigation.navigate("Inbox")
  }, [navigation, sessionId, host, path, label])
  const boardSwipeState = useRef({ openBoard, enabled: true })
  boardSwipeState.current = { openBoard, enabled: !capDrawerOpen && !msgAction }
  useFocusEffect(useCallback(() => {
    boardOpening.current = false
    return () => { boardSwipeCancelled.current = true }
  }, [routeLifetime]))
  const boardPan = useRef(PanResponder.create({
    // Bubble phase only: nested code/table scrolling keeps its own responder.
    onMoveShouldSetPanResponder: (_event, g) =>
      boardSwipeState.current.enabled && navigation.isFocused()
      && !boardOpening.current && !boardSwipeCancelled.current
      // g.x0 is only assigned on grant, so during should-set it is still 0;
      // the touch's start point has to be derived from the current position.
      && shouldClaimBoardSwipe({
        ...transcriptBounds.current, x0: g.moveX - g.dx, dx: g.dx, dy: g.dy,
        touches: g.numberActiveTouches,
      }),
    onPanResponderMove: (_event, g) => {
      if (g.numberActiveTouches !== 1) boardSwipeCancelled.current = true
    },
    onPanResponderRelease: (_event, g) => {
      if (!boardSwipeCancelled.current && boardSwipeState.current.enabled
        && completesBoardSwipe(g)) boardSwipeState.current.openBoard()
    },
    onPanResponderTerminate: () => { boardSwipeCancelled.current = true },
  })).current
  // Shows a "jump to latest" button when the user has scrolled up from the bottom.
  const [showJump, setShowJump] = useState(false)
  // WhatsApp-style floating day header: the date of the topmost visible message,
  // shown only while scrolling and auto-hidden ~1s after scrolling stops.
  const [scrollDate, setScrollDate] = useState("")
  const dateOpacity = useRef(new Animated.Value(0)).current
  const dateHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const slashMatches = useMemo(() => matchCommands(slashTerm(input), commands), [input, commands])
  // Id of the most recent agent exchange — its steps default to expanded so the
  // current turn is visible without a tap; older exchanges stay collapsed. Keyed
  // by id (not list index) because the inverted render reorders indices.
  const lastExchangeId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === "exchange") return items[i].id
    }
    return ""
  }, [items])
  // The list renders `inverted` (newest at offset 0), so it consumes the data
  // reversed. The live WORKING placeholder is the newest thing of all, so it
  // goes to the FRONT of the reversed array (= visual bottom). Built once here so
  // the render stays declarative and index math has a single definition.
  const listData = useMemo<ListItem[]>(() => {
    const reversed = [...items].reverse()
    return busy ? [WORKING, ...reversed] : reversed
  }, [items, busy])
  // Pinned messages that still exist in the transcript, in thread order (oldest→
  // newest), each with its preview text — drives the banner and its cycle.
  const pinnedItems = useMemo(() => {
    const byUuid = new Map<string, ThreadItem>()
    for (const it of items) {
      const u = itemUuid(it)
      if (u) byUuid.set(u, it)
    }
    return pinned.map((u) => byUuid.get(u)).filter(Boolean).map((it) => ({ uuid: itemUuid(it as ThreadItem)!, text: itemPreview(it as ThreadItem) }))
  }, [items, pinned])
  // Search indexes the SAME array the list renders (listData), so a match's
  // index is a valid scrollToIndex target. itemText() returns "" for the WORKING
  // sentinel, so it never matches.
  const searchMatches = useMemo(
    () => (searchOpen ? findMatches(listData as ThreadItem[], searchQ) : []),
    [listData, searchOpen, searchQ]
  )
  const t = useTheme()
  const styles = useStyles()
  const insets = useSafeAreaInsets()
  // The real header height, rather than a hardcoded 90 that was wrong on most
  // devices — this is what makes the keyboard land flush against the composer.
  const headerHeight = useHeaderHeight()
  const listRef = useRef<FlatList<ListItem>>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const localId = useRef(0)
  // Optimistic user bubbles (fresh send + steer) that the server transcript may
  // not have caught up to yet. reload() keeps re-appending these until the server
  // shows them, so a steered message can't flash-and-vanish mid-run.
  const pendingSteers = useRef<{ kind: "user"; id: string; text: string }[]>([])
  // --- Autoscroll model: an INVERTED list --------------------------------------
  // The thread renders newest-first with `inverted`, so item 0 sits at the bottom
  // of the screen and the list grows upward. This makes "stay on the latest" the
  // list's natural resting state — new messages and streaming steps prepend at
  // offset 0 (the anchored edge), so the viewport holds on the newest message for
  // free. There is NOTHING to imperatively scroll: no follow flag, no
  // stickToBottom, no onContentSizeChange snapping. Scrolling up to read history
  // moves you away from offset 0 and is never yanked back, because nothing drives
  // the viewport. This is how WhatsApp/iMessage/Gifted-Chat solve it.
  // The one remaining scroll command is the jump-to-latest button, which scrolls
  // back to offset 0. `distanceFromBottom` here is the inverted list's scroll
  // offset (0 = pinned to the newest); it only drives the jump button's
  // visibility, never the auto-scroll.
  const distanceFromBottom = useRef(0)

  const reload = useCallback(async () => {
    if (!path) {
      setLoading(false)
      return [] as ReturnType<typeof groupThread>
    }
    try {
      const page = await api.sessionReadPage(host, path, windowLines)
      // start === 0 means the window reaches the top of the file → no older
      // history to lazy-load. Otherwise scrolling up can grow the window.
      hasMoreRef.current = page.start > 0
      const lines = page.lines
      const next = groupThread(parseTranscript(lines))
      // A steered message gets an optimistic bubble immediately, but the server
      // may not have written it into the transcript yet — so a naive setItems(next)
      // here would wipe it (it flashes then vanishes). Keep any pending optimistic
      // bubbles the server hasn't caught up to yet; drop each one once a matching
      // user turn appears. Match by COUNT, not set-membership: send the same text
      // twice and each server turn consumes exactly ONE pending bubble (a Set would
      // drop both on the first match, losing a real duplicate). The transcript user
      // turns don't echo our client id, so text-with-count is the best identity we
      // have here.
      const serverTextCounts = new Map<string, number>()
      for (const it of next) {
        if (it.kind === "user") {
          const txt = (it as { text: string }).text
          serverTextCounts.set(txt, (serverTextCounts.get(txt) || 0) + 1)
        }
      }
      pendingSteers.current = pendingSteers.current.filter((b) => {
        const n = serverTextCounts.get(b.text) || 0
        if (n > 0) {
          serverTextCounts.set(b.text, n - 1) // this server turn consumes this bubble
          return false
        }
        return true // not caught up yet — keep the optimistic bubble
      })
      const merged =
        pendingSteers.current.length > 0 ? [...next, ...pendingSteers.current] : next
      setItems(merged)
      // Track the newest tool call so the header/working bubble can name it.
      const last = next[next.length - 1]
      if (last && last.kind === "exchange") {
        const tools = last.steps.filter((b) => b.kind === "tool")
        const newest = tools[tools.length - 1]
        if (newest && newest.kind === "tool") setActivity(newest.name)
      }
      return next
    } catch (e) {
      setError((e as Error).message)
      return [] as ReturnType<typeof groupThread>
    } finally {
      setLoading(false)
    }
  }, [host, path, windowLines])

  // Lazy-load older history when the user scrolls to the TOP of the (inverted)
  // list. Grow the tail window and re-read; maintainVisibleContentPosition keeps
  // the current rows anchored so the viewport doesn't jump. Guarded so a burst of
  // onEndReached events triggers only one fetch, and only while more remains.
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current || !path) return
    loadingMoreRef.current = true
    setWindowLines((n) => n + 400)
    // reload() re-runs via its windowLines dep; release the guard shortly after so
    // the next scroll-to-top can page again.
    setTimeout(() => {
      loadingMoreRef.current = false
    }, 600)
  }, [path])

  useFocusEffect(
    useCallback(() => {
      // Switching sessions: don't carry optimistic bubbles from a prior thread.
      pendingSteers.current = []
      reload()
      // Hydrate pinned message uuids from server session meta (survives reinstall).
      if (path) {
        api
          .sessionMeta(host, path)
          .then((m) => setPinned(Array.isArray(m.pinned) ? m.pinned : []))
          .catch(() => {})
      }
      // On focus, fetch status once: reattach the poll if a run is active, and —
      // whether running or not — surface any parked AskUserQuestion so the card
      // renders when opening a paused chat (or reopening the app days later).
      const sid = (path?.split("/").pop() || "").replace(/\.jsonl$/, "")
      if (sid) {
        api
          .chatStatus(sid)
          .then((s) => {
            setPendingQuestion(s.pending_question || null)
            setPendingPlan(s.pending_plan || null)
            if (s.running && !pollRef.current) {
              setBusy(true)
              startPoll(sid)
            }
          })
          .catch(() => {})
      }
    }, [reload, path])
  )

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  // Persist the composer draft per session so it survives going back / app
  // close. Debounced so we don't hit SecureStore on every keystroke. Keyed by
  // path for existing chats, or the new session id once a fresh chat starts.
  useEffect(() => {
    const key = path || sessionId
    if (!key) return
    const h = setTimeout(() => {
      setDraft(key, input).catch(() => {})
    }, 400)
    return () => clearTimeout(h)
  }, [input, path, sessionId])

  // Ask for notification permission once; declined is fine, we just stay quiet.
  useEffect(() => {
    ensurePermission().catch(() => {})
  }, [])

  // Slash commands are host-scoped and rarely change — fetch once per thread.
  useEffect(() => {
    api
      .commands(host)
      .then((c) => setCommands(Array.isArray(c) ? c : []))
      .catch(() => {})
  }, [host])

  // WhatsApp-style header: the session name (tap it to open the session's
  // profile/settings page) with a live "typing…" subtitle while the agent
  // works. Header actions: search and this session's board (three-dot menu) —
  // mode/model/system-prompt/goal/loops/stats all moved to the SessionProfile
  // screen behind the name.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <TouchableOpacity
          testID="header-title"
          accessibilityLabel="open-session-profile"
          onPress={() =>
            isCurrentThread() && navigation.isFocused() && navigation.navigate("SessionProfile", {
              host,
              label,
              path,
              sessionId,
              agent,
            })
          }
          style={styles.headerTitleWrap}
        >
          <Text style={[styles.headerTitleText, { color: t.text }]} numberOfLines={1}>
            {label}
          </Text>
          {busy ? (
            <Text testID="header-typing" style={styles.headerSubtitle}>
              {activity ? `${activity}…` : "typing…"}
            </Text>
          ) : null}
        </TouchableOpacity>
      ),
      headerRight: () => (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <TouchableOpacity
            testID="thread-call"
            accessibilityLabel="call-mode"
            onPress={() => navigation.navigate("Call", { label, path })}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", marginRight: 2 }}
          >
            <Icon name="phone" size={20} color={t.accent} />
          </TouchableOpacity>
          <TouchableOpacity
            testID="thread-tools"
            accessibilityLabel="skills-and-tools"
            onPress={() => setCapDrawerOpen((o) => !o)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", marginRight: 2 }}
          >
            <Icon name="tool" size={20} color={capDrawerOpen ? t.text : t.accent} />
          </TouchableOpacity>
          <TouchableOpacity
            testID="thread-more"
            accessibilityLabel="more-options"
            onPress={() => {
              Alert.alert("", "", [
                { text: "Search", onPress: () => setSearchOpen(true) },
                { text: "Board", onPress: openBoard },
                { text: "Notes", onPress: openNotes },
                { text: "Inbox", onPress: openInbox },
                { text: "Cancel", style: "cancel" },
              ])
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", marginRight: 6 }}
          >
            <Icon name="more" size={20} color={t.accent} />
          </TouchableOpacity>
        </View>
      ),
    })
  }, [navigation, label, busy, activity, host, path, sessionId, agent, t, capDrawerOpen, openBoard, openNotes, openInbox, isCurrentThread])

  // Reveal the floating day pill, then schedule it to fade out ~1s after the
  // last scroll event — the WhatsApp behaviour of showing the date only while
  // the finger is moving. Cleared on unmount.
  const revealDate = useCallback(() => {
    dateOpacity.stopAnimation()
    Animated.timing(dateOpacity, { toValue: 1, duration: 120, useNativeDriver: true }).start()
    if (dateHideTimer.current) clearTimeout(dateHideTimer.current)
    dateHideTimer.current = setTimeout(() => {
      Animated.timing(dateOpacity, { toValue: 0, duration: 350, useNativeDriver: true }).start()
    }, 1000)
  }, [dateOpacity])

  useEffect(() => {
    return () => {
      if (dateHideTimer.current) clearTimeout(dateHideTimer.current)
    }
  }, [])

  // Track the topmost visible message so the floating pill shows ITS day. The
  // list is inverted, so the row at the TOP of the screen is the one with the
  // highest data index (index 0 sits at the bottom). Kept in a stable ref
  // because FlatList forbids changing these props at runtime.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<{ item: ListItem; index: number | null }> }) => {
      let top: ThreadItem | undefined
      let topIndex = -1
      for (const v of viewableItems) {
        if ((v.item as ThreadItem).id === WORKING.id) continue
        if ((v.index ?? -1) > topIndex) {
          topIndex = v.index ?? -1
          top = v.item as ThreadItem
        }
      }
      const d = top ? fmtDate(top.ts) : ""
      if (d) setScrollDate(d)
    }
  ).current

  function jumpTo(dir: 1 | -1) {
    const next = stepMatch(searchMatches, searchAt, dir)
    if (next === -1) return
    setSearchAt(next)
    listRef.current?.scrollToIndex({ index: next, viewPosition: 0.3, animated: true })
  }

  // Jump back to the newest message. In an inverted list "the newest" is offset
  // 0, so this is a plain scroll-to-top of the underlying list. It's the only
  // programmatic scroll left — everything else the inverted layout handles.
  const jumpToLatest = useCallback(() => {
    setShowJump(false)
    listRef.current?.scrollToOffset({ offset: 0, animated: true })
  }, [])

  function addUserBubble(text: string): string {
    // Append in natural order; the list is `inverted`, so this lands at offset 0
    // (the bottom) and the viewport follows it automatically. No scroll call.
    const id = `local-${++localId.current}`
    // Remember it so a poll reload (which rebuilds from the server transcript)
    // re-appends it until the server has persisted this user turn.
    pendingSteers.current = [...pendingSteers.current, { kind: "user", id, text }]
    setItems((it) => [...it, { kind: "user", id, text }])
    return id
  }

  /** Drop an optimistic bubble that failed to send (from both the list and the
   *  pending-steers set) so it doesn't get re-appended by the next reload. */
  function dropUserBubble(id: string) {
    pendingSteers.current = pendingSteers.current.filter((b) => b.id !== id)
    setItems((it) => it.filter((m) => !(m.kind === "user" && m.id === id)))
  }

  function startPoll(sid: string) {
    if (!isCurrentThread()) return
    if (pollRef.current) clearInterval(pollRef.current)
    let ticks = 0
    let inFlight = false // guard: a slow status+reload must not overlap the next tick
    pollRef.current = setInterval(async () => {
      if (inFlight) return // previous tick still awaiting — skip so setItems can't race
      inFlight = true
      ticks++
      try {
        const s = await api.chatStatus(sid)
        setPending(s.pending_approvals || [])
        setPendingQuestion(s.pending_question || null)
        setPendingPlan(s.pending_plan || null)
        setQueued(s.queue?.length || 0)
        setQueueList(s.queue || [])
        if (!s.running || ticks > 400) {
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
          await reload() // final response replaces the "working" bubble
          // The run ended. It may have ended WAITING on you — a per-tool approval
          // or a parked AskUserQuestion (pending_question). Either way the server
          // already pushed a notification; we just stop the busy spinner and let
          // the card(s) render. An unanswered prompt is not "done".
          setActivity("")
          setBusy(false)
          return
        }
        // Still running → stream the steps in as they happen (every other tick,
        // ~3s, so the transcript fetch doesn't pile up behind the status poll).
        if (ticks % 2 === 0) {
          await reload()
        }
      } catch {
        /* keep polling through transient errors */
      } finally {
        inFlight = false
      }
    }, 1500)
  }

  /**
   * The composer's action. Idle → start a new turn. Busy → the caller passes an
   * explicit `mode`: "interrupt" steers the running turn now, "queue" runs it
   * after. Two distinct buttons in the working pill call this, so there's never
   * a mode to guess — each button does exactly what it says.
   */
  async function primary(mode: "queue" | "steer" = "queue") {
    const raw = input.trim()
    if (!raw) return
    // A reply quotes the message it answers, so the agent sees the referent.
    const text = replyTo ? buildReply(replyTo, raw) : raw
    setInput("")
    setReplyTo(null)
    setError("")

    if (busy) {
      // Queued messages belong in the queue chips, NOT the transcript — adding a
      // thread bubble here made them flash in the chat and then vanish when the
      // next poll rebuilt items from the server. Steered messages DO join the
      // turn, so they get an optimistic bubble.
      if (mode === "queue") {
        setQueueList((q) => [...q, text]) // optimistic chip; poll reconciles
        setQueued((n) => n + 1)
        try {
          await api.chat({ message: text, path: path || undefined, host, agent: "claude", ...sendPrefs(), queue: true })
        } catch (e) {
          setError((e as Error).message)
          setQueueList((q) => q.filter((m) => m !== text))
          setQueued((n) => Math.max(0, n - 1))
          setInput(text)
        }
        return
      }
      const bubbleId = addUserBubble(text)
      try {
        await api.chatSteer({ path: path || sessionId, message: text, host })
      } catch (e) {
        // Don't silently swallow the message: drop the optimistic bubble and put
        // the text back in the composer so the user can retry.
        setError((e as Error).message)
        dropUserBubble(bubbleId)
        setInput(text)
      }
      return
    }

    addUserBubble(text)
    setBusy(true)
    try {
      const res = await api.chat({ message: text, path: path || undefined, host, agent: "claude", ...sendPrefs() })
      setSessionId(res.session)
      startPoll(res.session)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  async function stop() {
    if (!sessionId) return
    // Snapshot the queue before interrupting: the server drops it on interrupt
    // ("stop what's planned"), but the user asked for Stop to end only the
    // CURRENT turn and still run what they lined up. We re-send them below.
    const carry = [...queueList]
    try {
      await api.chatInterrupt(path || sessionId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      // Recover the UI immediately rather than waiting on the next poll tick —
      // if the server run is wedged, the poll might never report !running, which
      // would otherwise leave the user stuck in the "busy" state forever.
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      setBusy(false)
      setActivity("")
      setQueued(0)
      setQueueList([])
      await reload()
      // Re-run the messages that were queued behind the stopped turn, in order.
      // The first starts a fresh resumed run; the rest queue behind it.
      if (carry.length) {
        try {
          setBusy(true)
          const first = carry[0]
          const res = await api.chat({ message: first, path: path || undefined, host, agent: "claude", ...sendPrefs() })
          const sid = res.session
          setSessionId(sid)
          for (const msg of carry.slice(1)) {
            await api.chat({ message: msg, path: path || sid, host, agent: "claude", ...sendPrefs(), queue: true })
          }
          startPoll(sid)
        } catch (e) {
          // If re-running fails, surface the error and restore the drafts so
          // nothing the user queued is silently lost.
          setError((e as Error).message)
          setBusy(false)
          setInput(carry.join("\n\n"))
        }
      }
    }
  }

  /**
   * Long-press on one of your messages: fork the session from that point into a
   * new chat, or revert this session back to it. Both are destructive-ish, so
   * each is confirmed and the wording says exactly what will happen.
   */
  function askMessageAction(uuid: string | undefined, text: string, isUser: boolean) {
    setMsgAction({ uuid, text, isUser })
  }

  // Persist the pin list (optimistic) to server session meta.
  function savePins(next: string[]) {
    setPinned(next)
    if (path) api.sessionMetaSave({ session: path, pinned: next, host }).catch((e) => setError((e as Error).message))
  }

  function togglePin(uuid: string) {
    if (!uuid) return
    savePins(pinned.includes(uuid) ? pinned.filter((u) => u !== uuid) : [...pinned, uuid])
  }

  // Scroll to a message by its transcript uuid (banner tap / profile deep-link).
  function jumpToUuid(uuid: string) {
    const idx = listData.findIndex((it) => it.id !== WORKING.id && itemUuid(it as ThreadItem) === uuid)
    if (idx >= 0) listRef.current?.scrollToIndex({ index: idx, viewPosition: 0.3, animated: true })
  }

  // Deep-link jump: when arriving from the profile's pinned list (route.jumpTo),
  // scroll to that message once the transcript has loaded. The ref guards against
  // re-jumping on every data change (e.g. a new message streaming in).
  const jumpedTo = useRef<string | undefined>(undefined)
  useEffect(() => {
    const target = route.params.jumpTo
    if (!target || jumpedTo.current === target || !listData.length) return
    const idx = listData.findIndex((it) => it.id !== WORKING.id && itemUuid(it as ThreadItem) === target)
    if (idx >= 0) {
      jumpedTo.current = target
      setTimeout(() => listRef.current?.scrollToIndex({ index: idx, viewPosition: 0.3, animated: true }), 300)
    }
  }, [route.params.jumpTo, listData])

  function doFork() {
    const uuid = msgAction?.uuid
    setMsgAction(null)
    if (!uuid) return
    api
      .forkSession({ session: path || "", uuid, host, agent: "claude" })
      .then(() => navigation.goBack())
      .catch((e) => setError((e as Error).message))
  }

  function doRevert() {
    const uuid = msgAction?.uuid
    setMsgAction(null)
    if (!uuid) return
    Alert.alert("Revert session?", "Everything after this message is removed from the conversation.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Revert",
        style: "destructive",
        onPress: () =>
          api
            .restoreSession({ session: path || "", uuid, mode: "conversation", host, agent: "claude" })
            .then(reload)
            .catch((e) => setError((e as Error).message)),
      },
    ])
  }

  async function copyText(t: string) {
    try {
      const Clipboard = require("expo-clipboard")
      await Clipboard.setStringAsync(t)
    } catch {
      setError("Copying needs a newer build of the app.")
    }
  }

  /** Pick a screenshot, upload it to the host, and reference its path. The chat
   *  API is text-only, but the agent can Read a file on its own machine. */
  async function attach() {
    setError("")
    try {
      const picked = await pickImage()
      if (!picked) return
      setAttaching(true)
      const remote = await uploadImage({ base: serverUrl(), token: token(), host }, picked)
      setInput((cur) => attachMessage(remote, cur))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAttaching(false)
    }
  }

  /** Drop a queued message before it runs. */
  async function removeQueued(index: number) {
    setQueueList((q) => q.filter((_, i) => i !== index)) // optimistic
    try {
      await api.chatQueueRemove({ path: path || "", index })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** Tap a queued chip to pull it back: drop it from the queue AND restore its
   *  text to the composer so it isn't lost (the ✕ discards instead). If the
   *  composer already holds a draft, prepend so nothing is overwritten. */
  async function unqueue(index: number) {
    const text = queueList[index]
    if (text === undefined) return
    await removeQueued(index)
    setInput((cur) => (cur.trim() ? `${text}\n\n${cur}` : text))
  }

  async function decide(id: string, decision: "allow" | "deny") {
    setPending((p) => p.filter((x) => x.id !== id))
    try {
      await api.chatPermissionDecide({ session: sessionId, id, decision })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** Answer a parked AskUserQuestion (async): the server resolves the pending row
   *  and RESUMES the session with the picks. The run had already ended, so this
   *  starts a fresh (resumed) turn — nothing was held while we waited. */
  function answerPendingQuestion(picks: string[], note: string) {
    setPendingQuestion(null) // optimistic clear
    setBusy(true)
    api
      .chatQuestionAnswer({ session: path || sessionId, picks, note, ...sendPrefs() })
      .then((res) => {
        const sid = res.session || sessionId
        if (res.session) setSessionId(res.session)
        startPoll(sid)
      })
      .catch((e) => setError((e as Error).message))
  }

  /** Approve or deny a proposed plan (ExitPlanMode). The run is blocked waiting;
   *  approve continues in place, deny sends feedback so the agent re-plans. */
  function decidePendingPlan(decision: "approve" | "deny", feedback?: string) {
    setPendingPlan(null) // optimistic clear
    setBusy(true)
    api
      .chatPlanDecide({ session: path || sessionId, decision, feedback })
      .then(() => startPoll((path?.split("/").pop() || "").replace(/\.jsonl$/, "") || sessionId))
      .catch((e) => setError((e as Error).message))
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    )
  }

  return (
    <>
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={headerHeight}
      // While the capabilities drawer (and its editor modal) is open, THIS
      // screen has nothing focused — but the keyboard notification is global,
      // so without this the chat + composer behind the transparent modal would
      // slide up too. Only the editor's own KAV should react then.
      enabled={!capDrawerOpen}
    >
      {/* WhatsApp-style in-thread search: chevrons step through matches. */}
      {searchOpen ? (
        <View style={[styles.threadSearchBar, { backgroundColor: t.surface }]}>
          <TextInput
            testID="thread-search-input"
            style={[styles.threadSearchInput, { backgroundColor: t.inputBg, color: t.text }]}
            placeholder="Search in chat"
            placeholderTextColor={t.textMuted}
            value={searchQ}
            onChangeText={(v) => {
              setSearchQ(v)
              setSearchAt(-1)
            }}
            autoFocus
            autoCapitalize="none"
          />
          <Text style={[styles.threadSearchCount, { color: t.textMuted }]}>
            {searchMatches.length ? `${Math.max(1, searchMatches.indexOf(searchAt) + 1)}/${searchMatches.length}` : "0"}
          </Text>
          <TouchableOpacity testID="search-prev" onPress={() => jumpTo(-1)} hitSlop={8}>
            <Icon name="chevronDown" size={18} color={t.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity testID="search-next" onPress={() => jumpTo(1)} hitSlop={8}>
            <Icon name="chevronRight" size={18} color={t.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            testID="search-close"
            onPress={() => {
              setSearchOpen(false)
              setSearchQ("")
              setSearchAt(-1)
            }}
            hitSlop={8}
          >
            <Icon name="close" size={18} color={t.textMuted} />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* The list and its floating overlays share one flex:1 box so the
          jump-to-latest button and day pill anchor to the LIST's edges, not the
          screen's — keeping the button clear of the composer + run bar, whose
          combined height varies (Working…/Stop, errors, permission cards). */}
      <View
        ref={transcriptRef}
        testID="thread-viewport"
        style={{ flex: 1 }}
        onLayout={() => {
          transcriptBounds.current = { left: 0, width: 0 }
          boardSwipeCancelled.current = true
          measureTranscript()
        }}
        onTouchStart={(event) => {
          if (event.nativeEvent.touches.length === 1) boardSwipeCancelled.current = false
          else boardSwipeCancelled.current = true
          // A layout pass while another screen covers this one (the keyboard
          // opening there resizes our KeyboardAvoidingView) measures a view with
          // no window as zero width, which disables the edge swipe until the next
          // layout. A touch proves the view is on screen, so measure again now.
          measureTranscript()
        }}
        {...boardPan.panHandlers}
      >
      {/* Pinned banner: shows the current pin; tap jumps to it, tap again cycles
          (WhatsApp style). The count shows position; the pin icon unpins it. */}
      {pinnedItems.length ? (
        (() => {
          const i = Math.min(bannerIdx, pinnedItems.length - 1)
          const cur = pinnedItems[i]
          return (
            <TouchableOpacity
              testID="pinned-banner"
              style={[styles.pinnedBanner, { backgroundColor: t.chipBg, borderBottomColor: t.border }]}
              activeOpacity={0.8}
              onPress={() => {
                jumpToUuid(cur.uuid)
                if (pinnedItems.length > 1) setBannerIdx((n) => (n + 1) % pinnedItems.length)
              }}
            >
              <Icon name="pin" size={15} color={t.accent} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.pinnedBannerLabel, { color: t.accent }]}>
                  Pinned{pinnedItems.length > 1 ? ` · ${i + 1}/${pinnedItems.length}` : ""}
                </Text>
                <Text style={[styles.pinnedBannerText, { color: t.text }]} numberOfLines={1}>
                  {cur.text || "(no text)"}
                </Text>
              </View>
              <TouchableOpacity testID="pinned-banner-unpin" onPress={() => togglePin(cur.uuid)} hitSlop={8}>
                <Icon name="close" size={16} color={t.textMuted} />
              </TouchableOpacity>
            </TouchableOpacity>
          )
        })()
      ) : null}
      <FlatList
        ref={listRef}
        testID="thread-list"
        style={[styles.threadList, { backgroundColor: t.thread }]}
        // Inverted: newest at offset 0 (the visual bottom), list grows upward.
        // This is what makes "stay on the latest" free — new rows prepend at the
        // anchored edge and the viewport follows without any scroll command.
        inverted
        data={listData}
        keyExtractor={(it) => it.id}
        // Lazy-load older history: in an inverted list the "end" is the TOP, so
        // onEndReached fires as the user scrolls up into older messages.
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        // Keep the visible rows anchored when older messages prepend above, so the
        // viewport doesn't jump on a page-in.
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        // onScroll is display-only: in the inverted list, contentOffset.y is the
        // distance from the bottom (0 = pinned to newest). It drives just the
        // jump-to-latest button and the day-pill flash — never the scroll itself.
        onScroll={(e) => {
          const y = e.nativeEvent.contentOffset.y
          distanceFromBottom.current = y
          setShowJump(y > 240)
          revealDate()
        }}
        scrollEventThrottle={16}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        // Lazy-render: only mount rows near the viewport instead of the whole
        // transcript, so long sessions open fast and scroll smoothly.
        // removeClippedSubviews is deliberately NOT set: it is off by default on
        // iOS, saves no memory (views detach, not deallocate), and RN documents
        // it as buggy on iOS under transforms — `inverted` is a scaleY(-1)
        // transform, and Show more/less resizes rows in place.
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={11}
        onScrollToIndexFailed={(info) => {
          // Rows are lazily measured; approximate, then retry once settled.
          listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })
          setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.3 }), 120)
        }}
        contentContainerStyle={styles.threadContent}
        ListEmptyComponent={
          <Text style={[styles.hint, { padding: 16, textAlign: "center" }]}>
            {error || "No messages yet — say something below."}
          </Text>
        }
        renderItem={({ item }) =>
          item.id === WORKING.id ? (
            <WorkingBubble activity={activity} />
          ) : (
            <ItemView
              item={item as ThreadItem}
              isLatest={item.id === lastExchangeId}
              pinnedSet={pinned}
              onMessageAction={askMessageAction}
              onReply={setReplyTo}
            />
          )
        }
      />

      {/* WhatsApp-style floating day header: fades in while scrolling, shows the
          date of the topmost visible message, auto-hides ~1s after scrolling. */}
      {scrollDate ? (
        <Animated.View pointerEvents="none" style={[styles.scrollDatePill, { opacity: dateOpacity }]}>
          <Text style={styles.scrollDateText}>{scrollDate}</Text>
        </Animated.View>
      ) : null}

      {/* Jump to latest — appears when scrolled up so the newest message is one
          tap away instead of a long flick. */}
      {showJump ? (
        <TouchableOpacity
          testID="jump-to-latest"
          accessibilityLabel="jump-to-latest"
          style={styles.jumpBtn}
          onPress={jumpToLatest}
        >
          <Icon name="chevronDown" size={16} color={t.onAccent} />
        </TouchableOpacity>
      ) : null}
      </View>

      {/* Live run controls: how to stop the run + queued count. The "Running …"
          activity text lives in the inline WorkingBubble (in the thread) so it
          isn't duplicated here — this bar is just the anchored Stop control. */}
      {busy ? (
        <View style={styles.runBar}>
          <ActivityIndicator size="small" color={t.textMuted} />
          <Text style={styles.runText} numberOfLines={1}>
            {queued ? `${queued} queued` : "Working…"}
          </Text>
          {/* Two explicit actions inside the working pill (not a toggle): while
              text is drafted, Queue runs it after this turn and Interrupt steers
              it in now. Each button does exactly what it says — no mode to guess.
              Stop stays pinned at the right end. */}
          {input.trim() ? (
            <>
              <TouchableOpacity
                testID="run-queue"
                accessibilityLabel="run-queue"
                style={styles.runModeToggle}
                onPress={() => primary("queue")}
              >
                <Icon name="clock" size={13} color={t.textMuted} />
                <Text style={styles.runModeText}>Queue</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="run-interrupt"
                accessibilityLabel="run-interrupt"
                style={styles.runModeToggle}
                onPress={() => primary("steer")}
              >
                <Icon name="flash" size={13} color={t.textMuted} />
                <Text style={styles.runModeText}>Interrupt</Text>
              </TouchableOpacity>
            </>
          ) : null}
          <TouchableOpacity testID="composer-stop" style={styles.stopGhost} onPress={stop}>
            <Text style={styles.stopGhostText}>Stop</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {error ? (
        <View style={styles.statusLine}>
          <Text style={[styles.statusText, { color: t.danger }]} numberOfLines={2}>
            {error}
          </Text>
        </View>
      ) : null}

      {/* Pending input band (plan / question / tool approvals). Bounded + scrollable
          so a TALL card (e.g. a multi-question AskUserQuestion) can't push its
          Approve/Submit buttons off-screen — the user must always be able to reach
          them. Capped at ~55% of the screen; the composer stays visible below. */}
      {(pendingPlan || pendingQuestion || pending.length) ? (
        <ScrollView
          style={{ maxHeight: Dimensions.get("window").height * 0.55 }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 4 }}
        >
          {/* A proposed plan (ExitPlanMode) awaiting your Approve/Deny. The run is
              blocked; approve continues, deny sends feedback so the agent re-plans. */}
          {pendingPlan ? (
            <View testID="pending-plan" style={{ marginHorizontal: 12, marginBottom: 8 }}>
              <PlanCard input={pendingPlan.plan} onDecide={decidePendingPlan} />
            </View>
          ) : null}

          {/* A parked AskUserQuestion (async): the run ended waiting on your answer.
              Rendered from durable server state (pending_question), so it survives
              app-close/reopen. Tapping resolves it server-side and resumes the
              session. */}
          {pendingQuestion ? (
            <View testID="pending-question" style={{ marginHorizontal: 12, marginBottom: 8 }}>
              <QuestionCard input={pendingQuestion.questions} onAnswer={answerPendingQuestion} />
            </View>
          ) : null}

          {/* Per-call tool approvals (Allow/Deny). AskUserQuestion no longer appears
              here — it's an async pending_question, not a permission gate. */}
          {pending.map((p) => (
            <View key={p.id} testID={`perm-${p.id}`} style={styles.permCard}>
              <Text style={styles.permTitle}>Allow tool: {p.tool_name}?</Text>
              <Text style={styles.permInput} numberOfLines={3}>
                {typeof p.input === "string" ? p.input : JSON.stringify(p.input)}
              </Text>
              <View style={styles.permBtnRow}>
                <TouchableOpacity style={styles.permDeny} onPress={() => decide(p.id, "deny")}>
              <Text style={styles.permDenyText}>Deny</Text>
            </TouchableOpacity>
            <TouchableOpacity testID={`perm-allow-${p.id}`} style={styles.permAllow} onPress={() => decide(p.id, "allow")}>
              <Text style={styles.permAllowText}>Allow</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
        </ScrollView>
      ) : null}

      {/* Composer. Bottom padding respects the home indicator; Steer/Queue sit
          ABOVE the input so the text field never gets squeezed mid-run. */}
      <View style={[styles.composerWrap, { paddingBottom: insets.bottom, backgroundColor: t.surface, borderTopColor: t.border }]}>
        {/* What you're replying to — clear it with ✕. */}
        {replyTo ? (
          <View style={[styles.replyBar, { backgroundColor: t.chipBg }]}>
            <View style={styles.replyBarAccent} />
            <Text style={[styles.replyBarText, { color: t.textMuted }]} numberOfLines={2}>
              {quotePreview(replyTo)}
            </Text>
            <TouchableOpacity testID="reply-cancel" onPress={() => setReplyTo(null)} hitSlop={8}>
              <Icon name="close" size={14} color={t.textMuted} />
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Slash-command autocomplete — appears while typing "/foo". */}
        {slashMatches.length ? (
          <View testID="slash-list" style={styles.slashList}>
            <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 190 }}>
              {slashMatches.map((c) => (
                <TouchableOpacity
                  key={c.name}
                  testID={`slash-${c.name}`}
                  style={styles.slashRow}
                  onPress={() => setInput(`/${c.name} `)}
                >
                  <Text style={styles.slashName}>/{c.name}</Text>
                  {c.description ? (
                    <Text style={styles.slashDesc} numberOfLines={1}>
                      {c.description}
                    </Text>
                  ) : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {/* Queued messages. Tap the chip to pull it back into the composer —
            it un-queues and the text is restored (never discarded). The revert
            icon signals "return to composer" rather than "delete". */}
        {queueList.length ? (
          <View style={styles.queueWrap}>
            {queueList.map((q, i) => (
              <TouchableOpacity
                key={i}
                testID={`queue-unqueue-${i}`}
                style={styles.queueChip}
                onPress={() => unqueue(i)}
                activeOpacity={0.7}
              >
                <Text style={styles.queueChipText} numberOfLines={1}>
                  {q}
                </Text>
                <Icon name="revert" size={13} color={t.textMuted} />
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        <View style={styles.composerBar}>
          <TouchableOpacity
            testID="composer-attach"
            accessibilityLabel="composer-attach"
            style={[styles.circleBtn, styles.gearBtn]}
            onPress={attach}
            disabled={attaching}
          >
            {attaching ? <ActivityIndicator size="small" /> : <Icon name="attach" size={19} color={t.textMuted} />}
          </TouchableOpacity>

          <TextInput
            testID="composer-input"
            style={[styles.composerInput, { backgroundColor: t.inputBg, color: t.text, borderColor: t.border }]}
            placeholder={busy ? "Steer or queue a follow-up…" : "Message the agent…"}
            placeholderTextColor={t.textMuted}
            value={input}
            onChangeText={setInput}
            multiline
          />

          {/* Idle: sends a new turn. While busy the explicit Queue/Interrupt
              buttons in the working pill are the actions; this defaults to
              queueing so a stray tap never interrupts. */}
          <TouchableOpacity
            testID="composer-send"
            accessibilityLabel="composer-send"
            style={[
              styles.circleBtn,
              !input.trim() ? styles.sendBtnDisabled : styles.sendBtn,
            ]}
            onPress={() => primary()}
            disabled={!input.trim()}
          >
            <Icon name="send" size={19} color={t.onAccent} />
          </TouchableOpacity>
        </View>
      </View>

      <MessageActions
        target={msgAction}
        onClose={() => setMsgAction(null)}
        onReply={() => {
          if (msgAction) setReplyTo(msgAction.text)
          setMsgAction(null)
        }}
        onCopy={() => {
          if (msgAction) copyText(msgAction.text)
          setMsgAction(null)
        }}
        onFork={doFork}
        onRevert={doRevert}
        pinned={msgAction?.uuid ? pinned.includes(msgAction.uuid) : false}
        onPin={() => {
          if (msgAction?.uuid) togglePin(msgAction.uuid)
          setMsgAction(null)
        }}
      />
    </KeyboardAvoidingView>
      <CapabilitiesDrawer
        visible={capDrawerOpen}
        host={host}
        onClose={() => setCapDrawerOpen(false)}
      />
    </>
  )
}
