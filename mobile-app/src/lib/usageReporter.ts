// usageReporter.ts — the side-effect half of lib/usage.ts: holds the queue,
// flushes it to the owner's server every 30 s and when the app backgrounds.
// Started from App.tsx once signed in; screen changes come from the
// NavigationContainer's onStateChange.

import { AppState } from "react-native"
import { api } from "../api/client"
import { enqueue, screenChange, type UsageEvent } from "./usage"

const FLUSH_MS = 30_000
let queue: UsageEvent[] = []
let lastScreen: string | undefined
let started = false

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

export function recordScreen(name: string | undefined) {
  const ev = screenChange(lastScreen, name, Date.now() / 1000)
  if (!ev) return
  lastScreen = name
  queue = enqueue(queue, ev)
}

/** The owner's note about the app; sent now, not on the next tick. */
export function recordFeedback(surface: string, detail: string) {
  queue = enqueue(queue, { kind: "feedback", surface, detail, ts: Date.now() / 1000 })
  void flush()
}
