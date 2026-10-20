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
import { applyMention, hashTerm } from "../lib/fileMention"
import { ensurePermission } from "../lib/notify"
import { activeServerId, composerPrefs, draftFor, setDraft } from "../state/config"
import { offlineCache } from "../api/offlineCache"
import OfflineBanner from "../components/OfflineBanner"
import { useReachability } from "../lib/useReachability"
import { isTransportError, userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import { buildReply, quotePreview } from "../lib/quote"
import { completesBoardSwipe, shouldClaimBoardSwipe } from "../lib/gestures"
import { attachMessage, pickImage, uploadImage } from "../lib/attach"
import MessageActions, { type MsgTarget } from "../components/MessageActions"
import CapabilitiesDrawer from "../components/CapabilitiesDrawer"
import { findMatches, stepMatch } from "../lib/search"
import QuestionCard from "../components/QuestionCard"
import PlanCard from "../components/PlanCard"
import { ItemView, PinnedBanner, WorkingBubble } from "../components/ThreadItems"
import Icon from "../components/Icon"
import HeaderButton from "../components/HeaderButton"
import { useStyles } from "../lib/styles"
import { resolveSessionPath } from "../lib/session"
import { showActions } from "../lib/actionSheet"
import { takeReply, withReply } from "../lib/canvas"

type Props = NativeStackScreenProps<RootStackParamList, "Thread">

// Sentinel appended to the list while a run is in flight (see WorkingBubble).
const WORKING = { kind: "working" as const, id: "__working__" }
type ListItem = ThreadItem | typeof WORKING

// A WhatsApp-style thread for one agent session. Each agent exchange shows its
// final response with the tool-call "steps" collapsed underneath (tap to expand,
// then tap a step to see its result). Composer: send / steer / queue, a
// permission-mode + model dropdown, and in-thread Allow/Deny cards.
export default function ThreadScreen({ route, navigation }: Props) {
  const { host, path, label, agent = "claude", starting } = route.params
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
  // The transcript on screen is the device's saved copy, not a live read.
  const [fromCache, setFromCache] = useState(false)
  const { online } = useReachability()
  // Back online while showing the saved copy → swap in the live transcript.
  // (An idle thread has no poll of its own; any request anywhere — the Chats
  // list, the inbox badge — flips `online`.) Declared before reload, so read
  // through a ref.
  const reloadRef = useRef<() => unknown>(() => {})
  useEffect(() => {
    if (online && fromCache) reloadRef.current()
  }, [online, fromCache])
  // The server's explicit AI configuration wins at launch; these are only the
  // composer's own picks. Never coerce a full model ID against a catalog.
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
  // The session's folder, from the same meta read: scopes the drawer's project skills/tools.
  const [cwd, setCwd] = useState<string | undefined>()
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
  const openMap = useCallback(() => {
    if (sessionId) navigation.navigate("Map", { session: sessionId, title: label })
  }, [navigation, sessionId, label])
  const openCanvas = useCallback((initial?: string) => {
    if (sessionId) navigation.navigate("Canvas", { session: sessionId, title: label, initial })
  }, [navigation, sessionId, label])
  // A Reply tapped on the Canvas screen lands in this chat's composer, after
  // whatever the owner had already typed.
  useFocusEffect(useCallback(() => {
    const reply = sessionId ? takeReply(sessionId) : ""
    if (reply) setInput((d) => withReply(d, reply))
  }, [sessionId]))
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
  // "#word" at the caret searches the session's project (lib/fileMention.ts);
  // picking a hit swaps it for @path, which Claude Code inlines.
  const [caret, setCaret] = useState<number | null>(null)
  // Set only right after a pick to place the caret past the mention; left
  // uncontrolled otherwise so iOS typing never fights a stale selection.
  const [placeCaret, setPlaceCaret] = useState<number | null>(null)
  const [fileHits, setFileHits] = useState<{ path: string; dir: boolean }[]>([])
  const hash = useMemo(() => (caret === null ? null : hashTerm(input, caret)), [input, caret])
  const hashQuery = hash?.query ?? null
  useEffect(() => {
    if (hashQuery === null || !cwd) {
      setFileHits([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      api.fsSearch(host, cwd, hashQuery)
        .then((r) => { if (live) setFileHits(r.results || []) })
        .catch(() => { if (live) setFileHits([]) })
    }, 150)
    return () => { live = false; clearTimeout(timer) }
  }, [hashQuery, cwd, host])
  const fileMatches = slashMatches.length || !hash ? [] : fileHits
  // iOS can answer the pick with a change event still carrying the pre-pick
  // text (the keyboard committing as the row is tapped); that echo would undo
  // the mention. Until the user's next real edit, the old text maps back to
  // the picked one.
  const pickEcho = useRef<{ from: string; to: string } | null>(null)
  const onComposerText = (text: string) => {
    const echo = pickEcho.current
    pickEcho.current = null
    setInput(echo && text === echo.from ? echo.to : text)
  }
  const pickFile = (p: string) => {
    if (!hash || caret === null) return
    const r = applyMention(input, hash, caret, p)
    pickEcho.current = { from: input, to: r.text }
    setInput(r.text)
    setCaret(r.caret)
    setPlaceCaret(r.caret)
    setFileHits([])
  }
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
  // Newest-first with `inverted`: item 0 sits at the bottom and new items prepend
  // at offset 0, so "stay on the latest" is the list's resting state and reading
  // history is never yanked back — nothing scrolls imperatively (the WhatsApp /
  // iMessage approach). The only scroll command is jump-to-latest;
  // `distanceFromBottom` (0 = pinned to newest) just drives that button.
  const distanceFromBottom = useRef(0)

  // The transcript lines currently rendered and the byte offset they end at. A
  // full reload() replaces both; poll() appends only what the file gained since
  // `end`, so a running turn costs bytes proportional to its new output instead
  // of re-downloading the whole tail window every tick.
  const loadedRef = useRef<{ path?: string; lines: string[]; end: number }>({ lines: [], end: 0 })

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
      loadedRef.current = { path, lines: page.lines, end: page.end }
      setFromCache(false)
      setError("")
      offlineCache.saveThread(activeServerId(), host, path, page.lines)
      return render(page.lines)
    } catch (e) {
      // Unreachable: show the saved copy (if any) under the offline banner,
      // instead of an error in place of the conversation.
      if (isTransportError(e)) {
        if (loadedRef.current.path !== path) {
          const saved = await offlineCache.loadThread(activeServerId(), host, path)
          if (saved) {
            setFromCache(true)
            return render(saved)
          }
        }
      } else {
        setError(userError(e, "this chat"))
      }
      return [] as ReturnType<typeof groupThread>
    } finally {
      setLoading(false)
    }
  }, [host, path, windowLines])
  reloadRef.current = reload

  // Incremental refresh for the live-run poll. Falls back to a full reload when
  // there's no baseline for this path or the file shrank (rewritten/trimmed).
  const poll = useCallback(async () => {
    const loaded = loadedRef.current
    if (!path || loaded.path !== path) return reload()
    try {
      const page = await api.sessionReadFrom(host, path, loaded.end)
      if (loadedRef.current !== loaded) return // a full reload landed meanwhile
      if (page.size < loaded.end) return reload()
      if (!page.lines.length) return // nothing new — skip the re-parse/re-render
      const lines = [...loaded.lines, ...page.lines]
      loadedRef.current = { path, lines, end: page.end }
      offlineCache.saveThread(activeServerId(), host, path, lines)
      return render(lines)
    } catch {
      /* transient; the next tick retries */
    }
  }, [host, path, reload])

  function render(lines: string[]) {
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
  }

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
          .then((m) => { setPinned(Array.isArray(m.pinned) ? m.pinned : []); setCwd(m.cwd || undefined) })
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
            } else if (!s.running && !pollRef.current) {
              setBusy(false) // a just-started chat that finished before it was adopted
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

  // A chat opened the moment it was started (`starting`): its transcript isn't
  // written until the CLI is up, so show the sent message and the working
  // bubble now, wait for the file, then adopt its path — the focus effect above
  // then loads it and attaches the live poll like any running chat.
  useEffect(() => {
    if (path || !starting) return
    setSessionId(starting.session)
    setLoading(false)
    setBusy(true)
    pendingSteers.current = [{ kind: "user", id: "local-start", text: starting.message }]
    setItems([...pendingSteers.current])
    // The name was stored by the server at creation — nothing to save here.
    resolveSessionPath(() => api.resolve(starting.session, host))
      .then((found) => {
        if (!isCurrentThread()) return
        if (!found) {
          setBusy(false)
          setError("This chat stopped before it wrote anything. Try sending the message again.")
          setInput(starting.message)
          return
        }
        navigation.setParams({ path: found, starting: undefined })
      })
  }, [path, starting?.session]) // eslint-disable-line react-hooks/exhaustive-deps

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
          accessibilityLabel="Session details"
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
        <View style={styles.headerIcons}>
          <HeaderButton testID="thread-call" label="Voice call" icon="phone" color={t.accent}
            onPress={() => navigation.navigate("Call", { label, path })} />
          <HeaderButton testID="thread-tools" label="Skills and tools" icon="tool" color={capDrawerOpen ? t.text : t.accent}
            onPress={() => setCapDrawerOpen((o) => !o)} />
          <HeaderButton testID="thread-more" label="More options" icon="more" color={t.accent} style={{ marginRight: 4 }}
            onPress={() => {
              showActions(label || "This chat", [
                { text: "Search", onPress: () => setSearchOpen(true) },
                { text: "Board", onPress: openBoard },
                { text: "Notes", onPress: openNotes },
                { text: "Inbox", onPress: openInbox },
                // A map needs the session's project; an unsent chat has none yet.
                ...(sessionId ? [{ text: "Map", onPress: openMap }, { text: "Canvas", onPress: () => openCanvas() }] : []),
              ])
            }} />
        </View>
      ),
    })
  }, [navigation, label, busy, activity, host, path, sessionId, agent, t, capDrawerOpen, openBoard, openNotes, openInbox, openMap, openCanvas, isCurrentThread])

  // Reveal the floating day pill, then schedule it to fade out ~1s after the
  // last scroll event — the WhatsApp behaviour of showing the date only while
  // the finger is moving. Cleared on unmount.
  // Called on every scroll frame: start the fade-in once, then only push the
  // hide timer back, so a scroll doesn't restart an animation 60 times a second.
  const dateShown = useRef(false)
  const revealDate = useCallback(() => {
    if (!dateShown.current) {
      dateShown.current = true
      dateOpacity.stopAnimation()
      Animated.timing(dateOpacity, { toValue: 1, duration: 120, useNativeDriver: true }).start()
    }
    if (dateHideTimer.current) clearTimeout(dateHideTimer.current)
    dateHideTimer.current = setTimeout(() => {
      dateShown.current = false
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
          await poll() // final response replaces the "working" bubble
          // The run ended. It may have ended WAITING on you — a per-tool approval
          // or a parked AskUserQuestion (pending_question). Either way the server
          // already pushed a notification; we just stop the busy spinner and let
          // the card(s) render. An unanswered prompt is not "done".
          setActivity("")
          setBusy(false)
          return
        }
        // Still running → stream the new steps in. poll() fetches only bytes
        // appended since the last read, so it's cheap enough to run every tick.
        await poll()
      } catch {
        /* keep polling through transient errors */
      } finally {
        inFlight = false
      }
    }, 1500)
  }

  /**
   * The composer's action. Idle → start a new turn. Busy → the caller passes an
   * explicit `mode`: "steer" injects the text into the running turn now (the CLI
   * reads it from stdin mid-turn), "queue" runs it after this turn ends. Two
   * distinct buttons in the working pill call this, so there's never a mode to
   * guess — each button does exactly what it says.
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
          setError(userError(e, "your message", "send"))
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
        setError(userError(e, "your message", "send"))
        dropUserBubble(bubbleId)
        setInput(text)
      }
      return
    }

    const bubbleId = addUserBubble(text)
    setBusy(true)
    try {
      const res = await api.chat({ message: text, path: path || undefined, host, agent: "claude", ...sendPrefs() })
      setSessionId(res.session)
      startPoll(res.session)
    } catch (e) {
      // Not sent: take back the bubble and give the text back to retry.
      setError(userError(e, "your message", "send"))
      dropUserBubble(bubbleId)
      setInput(text)
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
      setError(userError(e, "the run", "stop"))
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
          setError(userError(e, "your queued messages", "send"))
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
    if (path) api.sessionMetaSave({ session: path, pinned: next, host }).catch((e) => setError(userError(e, "the pin", "save")))
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
      .catch((e) => setError(userError(e, "the fork", "create")))
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
            .catch((e) => setError(userError(e, "this chat", "revert"))),
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
      const remote = await uploadImage(api, host, picked)
      setInput((cur) => attachMessage(remote, cur))
    } catch (e) {
      setError(userError(e, "the image", "upload"))
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
      setError(userError(e, "the queued message", "remove"))
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
      setError(userError(e, "your decision", "send"))
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
      .catch((e) => setError(userError(e, "your answer", "send")))
  }

  /** Approve or deny a proposed plan (ExitPlanMode). The run is blocked waiting;
   *  approve continues in place, deny sends feedback so the agent re-plans. */
  function decidePendingPlan(decision: "approve" | "deny", feedback?: string) {
    setPendingPlan(null) // optimistic clear
    setBusy(true)
    api
      .chatPlanDecide({ session: path || sessionId, decision, feedback })
      .then(() => startPoll((path?.split("/").pop() || "").replace(/\.jsonl$/, "") || sessionId))
      .catch((e) => setError(userError(e, "your decision", "send")))
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
      // The run pill floats in the strip between the message list and the composer
      // slab; the KAV's only uncovered region IS that strip. Painting it with the
      // thread wallpaper (not the lighter screen bg) makes the pill float on the
      // chat background like the day-pill and jump button do — no white seam behind
      // its rounded corners. The composer below stays its own bordered surface slab.
      style={{ flex: 1, backgroundColor: t.thread }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={headerHeight}
      // While the capabilities drawer (and its editor modal) is open, THIS
      // screen has nothing focused — but the keyboard notification is global,
      // so without this the chat + composer behind the transparent modal would
      // slide up too. Only the editor's own KAV should react then.
      enabled={!capDrawerOpen}
    >
      <OfflineBanner saved={fromCache} onRetry={() => { reload() }} />
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
      {/* Pinned banner: tap jumps to the current pin, tap again cycles (WhatsApp style). */}
      {pinnedItems.length ? (
        <PinnedBanner
          items={pinnedItems}
          index={Math.min(bannerIdx, pinnedItems.length - 1)}
          onPress={(cur) => {
            jumpToUuid(cur.uuid)
            if (pinnedItems.length > 1) setBannerIdx((n) => (n + 1) % pinnedItems.length)
          }}
          onUnpin={(cur) => togglePin(cur.uuid)}
        />
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
            {error || (fromCache || online ? "No messages yet — say something below." : "This chat isn't saved on this phone yet. It loads when you're back online.")}
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
              onOpenCanvas={sessionId ? openCanvas : undefined}
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
              text is drafted, Queue runs it after this turn and Steer injects
              it into the running turn now (mid-turn, no need to Stop first).
              Each button does exactly what it says — no mode to guess. Stop
              stays pinned at the right end. */}
          {input.trim() ? (
            <>
              <TouchableOpacity
                testID="run-queue"
                accessibilityLabel="Queue after this run"
                style={styles.runModeToggle}
                onPress={() => primary("queue")}
              >
                <Icon name="clock" size={13} color={t.textMuted} />
                <Text style={styles.runModeText}>Queue</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="run-interrupt"
                accessibilityLabel="Steer the running turn now"
                style={styles.runModeToggle}
                onPress={() => primary("steer")}
              >
                <Icon name="flash" size={13} color={t.textMuted} />
                <Text style={styles.runModeText}>Steer</Text>
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

          {/* Per-call tool approvals (Allow/Deny). Questions are the card above. */}
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

        {fileMatches.length ? (
          <View testID="file-mention-list" style={styles.slashList}>
            <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 190 }}>
              {fileMatches.map((f) => {
                const cut = f.path.lastIndexOf("/") + 1
                return (
                  <TouchableOpacity
                    key={f.path}
                    testID={`file-mention-${f.path}`}
                    style={[styles.slashRow, { flexDirection: "row", alignItems: "center", gap: 8 }]}
                    onPress={() => pickFile(f.path)}
                  >
                    <Icon name={f.dir ? "folder" : "file"} size={15} color={t.textMuted} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.slashName} numberOfLines={1}>
                        {f.path.slice(cut) + (f.dir ? "/" : "")}
                      </Text>
                      {cut ? (
                        <Text style={styles.slashDesc} numberOfLines={1}>
                          {f.path.slice(0, cut)}
                        </Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                )
              })}
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
            accessibilityLabel="Attach a file"
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
            onChangeText={onComposerText}
            onSelectionChange={(e) => {
              const { start, end } = e.nativeEvent.selection
              setCaret(start === end ? start : null)
              setPlaceCaret(null)
            }}
            selection={placeCaret === null ? undefined : { start: placeCaret, end: placeCaret }}
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
        cwd={cwd}
        session={path}
        onClose={() => setCapDrawerOpen(false)}
      />
    </>
  )
}
