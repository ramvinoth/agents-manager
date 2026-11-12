import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api/client"
import { offlineCache } from "../api/offlineCache"
import { openThreadPage } from "../api/threadOpen"
import { activeServerId } from "../state/config"
import { isTransportError, userError } from "./errors"
import { groupThread, parseTranscript, type ThreadItem } from "./thread"
import { EMPTY_WINDOW, hasOlder, prependOlder, type TranscriptWindow } from "./transcriptWindow"

// Transcript lines per read: the opening tail and each older page.
const PAGE_LINES = 400

type UserBubble = { kind: "user"; id: string; text: string }

/** The transcript one Thread screen shows: the window of lines on screen, how it
 *  loads (saved copy first, then the live tail), how a live run appends to it,
 *  how older pages prepend, and the optimistic user bubbles kept until the
 *  server's transcript catches up. The screen owns everything else. */
export function useThreadTranscript(opts: {
  host: string
  path?: string
  /** Opened by session id alone: the screen resolves the path, keep the spinner. */
  session?: string
  online: boolean
  setError: (text: string) => void
  /** The newest tool call, for the header subtitle and the working bubble. */
  setActivity: (name: string) => void
}) {
  const { host, path, session, online, setError, setActivity } = opts
  const [items, setItems] = useState<ThreadItem[]>([])
  const [loading, setLoading] = useState(true)
  // Paging older history in from the top of the (inverted) list: "loading"
  // shows a spinner there, "error" a tap-to-retry row (onEndReached won't refire
  // until the content grows, so a failed page needs an explicit retry).
  const [older, setOlder] = useState<"idle" | "loading" | "error">("idle")
  const loadingMoreRef = useRef(false)
  // The transcript on screen is the device's saved copy, not a live read.
  const [fromCache, setFromCache] = useState(false)
  const localId = useRef(0)
  // Optimistic user bubbles (fresh send + steer) that the server transcript may
  // not have caught up to yet. render() keeps re-appending these until the server
  // shows them, so a steered message can't flash-and-vanish mid-run.
  const pendingSteers = useRef<UserBubble[]>([])
  // The transcript lines currently rendered and the byte range they cover. A
  // full reload() replaces the window with the latest tail; poll() appends only
  // what the file gained since `end`, so a running turn costs bytes proportional
  // to its new output; loadMore() prepends the page before `start`.
  const loadedRef = useRef<TranscriptWindow>(EMPTY_WINDOW)

  function render(lines: string[]) {
    const next = groupThread(parseTranscript(lines))
    // Keep pending optimistic bubbles the server hasn't written yet; drop each
    // once a matching user turn appears. Match by COUNT, not set-membership:
    // send the same text twice and each server turn consumes exactly ONE bubble.
    // The transcript doesn't echo our client id, so text-with-count is the best
    // identity there is.
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
        serverTextCounts.set(b.text, n - 1)
        return false
      }
      return true
    })
    setItems(pendingSteers.current.length > 0 ? [...next, ...pendingSteers.current] : next)
    const last = next[next.length - 1]
    if (last && last.kind === "exchange") {
      const tools = last.steps.filter((b) => b.kind === "tool")
      const newest = tools[tools.length - 1]
      if (newest && newest.kind === "tool") setActivity(newest.name)
    }
    return next
  }

  const reload = useCallback(async () => {
    if (!path) {
      if (!session) setLoading(false)
      return [] as ThreadItem[]
    }
    // First open: a short shared read (the Chats row already started it on
    // press-in), and the saved copy paints at once while it is in flight.
    const first = loadedRef.current.path !== path
    let landed = false
    if (first) {
      offlineCache.loadThread(activeServerId(), host, path).then((saved) => {
        if (saved && !landed && loadedRef.current.path !== path) {
          render(saved)
          setLoading(false)
        }
      })
    }
    try {
      const page = first ? await openThreadPage(host, path) : await api.sessionReadPage(host, path, PAGE_LINES)
      landed = true
      loadedRef.current = { path, lines: page.lines, start: page.start, end: page.end }
      setOlder("idle")
      setFromCache(false)
      setError("")
      offlineCache.saveThread(activeServerId(), host, path, page.lines)
      return render(page.lines)
    } catch (e) {
      landed = true
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
      return [] as ThreadItem[]
    } finally {
      setLoading(false)
    }
  }, [host, path]) // eslint-disable-line react-hooks/exhaustive-deps

  // Back online while showing the saved copy → swap in the live transcript.
  // (An idle thread has no refresh loop of its own; any request anywhere flips
  // `online`.)
  useEffect(() => {
    if (online && fromCache) reload()
  }, [online, fromCache]) // eslint-disable-line react-hooks/exhaustive-deps

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
      loadedRef.current = { ...loaded, lines, end: page.end }
      offlineCache.saveThread(activeServerId(), host, path, lines)
      return render(lines)
    } catch {
      /* transient; the next tick retries */
    }
  }, [host, path, reload]) // eslint-disable-line react-hooks/exhaustive-deps

  /** poll(), reporting whether the transcript on screen changed. */
  const pollGrew = useCallback(async () => {
    const before = loadedRef.current
    await poll()
    return loadedRef.current !== before
  }, [poll])

  // Lazy-load older history when the user scrolls to the TOP of the (inverted)
  // list: prepend the page just before the window's first byte. A page of only
  // tool results can group into no new rows, and onEndReached refires only when
  // the content grows, so keep paging (bounded) until a row appears.
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !path || !hasOlder(loadedRef.current, path)) return
    loadingMoreRef.current = true
    setOlder("loading")
    try {
      const rows = (lines: string[]) => groupThread(parseTranscript(lines)).length
      const before = rows(loadedRef.current.lines)
      let grew = false
      for (let i = 0; i < 5 && !grew && hasOlder(loadedRef.current, path); i++) {
        const page = await api.sessionReadBefore(host, path, loadedRef.current.start, PAGE_LINES)
        const next = prependOlder(loadedRef.current, path, page)
        if (!next) return // a reload replaced the window meanwhile
        loadedRef.current = next
        grew = rows(next.lines) > before
      }
      render(loadedRef.current.lines)
    } catch {
      render(loadedRef.current.lines) // keep any pages that did arrive
      setOlder("error")
    } finally {
      loadingMoreRef.current = false
      setOlder((o) => (o === "loading" ? "idle" : o))
    }
  }, [host, path]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Show a just-sent message now; it stays until the server transcript has it. */
  const addUserBubble = useCallback((text: string) => {
    const id = `local-${++localId.current}`
    pendingSteers.current = [...pendingSteers.current, { kind: "user", id, text }]
    setItems((it) => [...it, { kind: "user", id, text }])
    return id
  }, [])

  /** Drop an optimistic bubble that failed to send so no reload re-appends it. */
  const dropUserBubble = useCallback((id: string) => {
    pendingSteers.current = pendingSteers.current.filter((b) => b.id !== id)
    setItems((it) => it.filter((m) => !(m.kind === "user" && m.id === id)))
  }, [])

  /** Switching sessions: never carry optimistic bubbles from a prior thread. */
  const clearUserBubbles = useCallback(() => { pendingSteers.current = [] }, [])

  /** A chat opened the moment it started: only the sent message exists so far. */
  const showStarting = useCallback((text: string) => {
    pendingSteers.current = [{ kind: "user", id: "local-start", text }]
    setItems([...pendingSteers.current])
    setLoading(false)
  }, [])

  return {
    items, loading, setLoading, older, fromCache,
    reload, poll, pollGrew, loadMore,
    addUserBubble, dropUserBubble, clearUserBubbles, showStarting,
  }
}
