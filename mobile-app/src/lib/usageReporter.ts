// usageReporter.ts — the side-effect half of lib/usage.ts: holds the queue,
// flushes it to the owner's server every 30 s and when the app backgrounds.
// Started from App.tsx once signed in; screen changes come from the
// NavigationContainer's onStateChange, presses and what is on screen from
// components/Tracked.tsx, swipes from each gesture's completion.

import { AppState } from "react-native"
import { api } from "../api/client"
import { enqueue, gestureEvent, screenChange, seenEvents, controlName, type ControlFacts, type UseKind, type UsageEvent } from "./usage"

const FLUSH_MS = 30_000
const SCAN_DELAY_MS = 300
let queue: UsageEvent[] = []
let lastScreen: string | undefined
let started = false

/** Every named control mounted right now, with whether its screen is the
 *  focused one. A screen stays mounted under the one pushed over it (and the
 *  tab pager keeps its neighbours), so "mounted" is not "on screen": only the
 *  controls whose screen is focused count as seen on a visit. */
type Mounted = { name: string; focused: () => boolean }
const mounted = new Set<Mounted>()
let seenThisVisit = new Set<string>()

async function flush() {
  if (!queue.length) return
  const batch = queue
  queue = []
  try {
    await api.usageSend(batch)
  } catch (e) {
    // Retry only a transport/server failure; a refusal (signed out, 4xx) is
    // dropped so one bad batch can't loop forever.
    const status = (e as { status?: number }).status
    if (!status || status >= 500) for (const ev of batch) queue = enqueue(queue, ev)
  }
}

export function startUsageReporting() {
  if (started) return
  started = true
  setInterval(() => void flush(), FLUSH_MS)
  AppState.addEventListener("change", (s) => { if (s !== "active") void flush() })
}

/** Count these controls as seen on the focused screen, once per visit. Queued
 *  only once reporting has started, like every use. */
function markSeen(names: string[]) {
  if (!started || !lastScreen) return
  for (const ev of seenEvents(lastScreen, names, seenThisVisit, Date.now() / 1000)) queue = enqueue(queue, ev)
}

function focusedNames(): string[] {
  const out: string[] = []
  for (const m of mounted) {
    try { if (m.focused()) out.push(m.name) } catch { /* a navigator mid-teardown names nothing */ }
  }
  return out
}

export function recordScreen(name: string | undefined) {
  const ev = screenChange(lastScreen, name, Date.now() / 1000)
  if (!ev) return
  lastScreen = name
  queue = enqueue(queue, ev)
  // A new visit: what is on this screen is seen afresh.
  seenThisVisit = new Set()
  markSeen(focusedNames())
}

/** Controls that mount mid-visit (a list loading, a sheet opening) are seen on
 *  the next scan. Deferred, never inline: a screen being pushed mounts its
 *  controls in the same commit as the navigation, before onStateChange has
 *  moved `lastScreen` — counting them inline would book them on the screen
 *  being left. */
let scanTimer: ReturnType<typeof setTimeout> | null = null
function scheduleScan() {
  if (scanTimer) return
  scanTimer = setTimeout(() => { scanTimer = null; markSeen(focusedNames()) }, SCAN_DELAY_MS)
}

/** A named control (or swipe) is on a screen while it is mounted. `focused`
 *  says whether that screen is the one in front (no navigator around it:
 *  always). Returns the unmount. */
export function controlMounted(facts: ControlFacts, focused: () => boolean): () => void {
  const name = controlName(facts)
  if (!name) return () => {}
  const m: Mounted = { name, focused }
  mounted.add(m)
  scheduleScan()
  return () => { mounted.delete(m) }
}

/** A tap, long-press or swipe on a named control, counted against the focused
 *  screen. Queued only once reporting has started (signed in), so the sign-in
 *  screens' presses never sit in memory waiting for a server that may refuse
 *  them. */
export function recordUse(kind: UseKind, facts: ControlFacts) {
  if (!started) return
  const ev = gestureEvent(kind, lastScreen, facts, Date.now() / 1000)
  if (ev) queue = enqueue(queue, ev)
}

/** A completed swipe gesture, by its name (`swipe-board`, `swipe-reply`). */
export function recordSwipe(name: string) {
  recordUse("swipe", { testID: name })
}

/** The owner's note about the app; sent now, not on the next tick. */
export function recordFeedback(surface: string, detail: string) {
  queue = enqueue(queue, { kind: "feedback", surface, detail, ts: Date.now() / 1000 })
  void flush()
}
