export type NotificationTarget = { session: string; host: string }

export function notificationTarget(data: unknown): NotificationTarget | null {
  if (!data || typeof data !== "object") return null
  const value = data as Record<string, unknown>
  if (typeof value.session !== "string" || !value.session) return null
  return { session: value.session, host: typeof value.host === "string" && value.host ? value.host : "local" }
}

/** Buffer the latest tap until navigation/auth is ready. Ignore obsolete lookups. */
export function createNotificationRouter<T>(deps: {
  ready: () => boolean
  scope: () => string
  resolve: (target: NotificationTarget) => Promise<T | undefined>
  navigate: (value: T) => void
}) {
  let pending: NotificationTarget | null = null
  let version = 0
  async function flush() {
    if (!pending || !deps.ready()) return
    const target = pending
    pending = null
    const ownVersion = version
    const scope = deps.scope()
    try {
      const value = await deps.resolve(target)
      if (value && ownVersion === version && scope === deps.scope() && deps.ready()) deps.navigate(value)
    } catch { /* stale notification or offline host: best-effort */ }
  }
  return {
    tap(data: unknown) {
      const target = notificationTarget(data)
      if (!target) return
      pending = target
      version++
      void flush()
    },
    flush,
    clear() { pending = null; version++ },
  }
}

/** Native response subscription with shared cold/warm dedup and cancellation. */
export function subscribeNotificationResponses(
  native: {
    addNotificationResponseReceivedListener: (fn: (response: any) => void) => { remove?: () => void }
    getLastNotificationResponseAsync?: () => Promise<any>
  },
  handler: (data: Record<string, unknown>) => void,
  seen: Set<string>,
): () => void {
  let cancelled = false
  const deliver = (response: any) => {
    if (cancelled) return
    const request = response?.notification?.request
    if (!notificationTarget(request?.content?.data)) return
    const id = request?.identifier
    if (typeof id !== "string" || !id || seen.has(id)) return
    seen.add(id)
    handler(request.content.data)
  }
  // Subscribe before awaiting the cold response so a warm tap cannot fall in a gap.
  let warmReceived = false
  const sub = native.addNotificationResponseReceivedListener((response) => {
    if (notificationTarget(response?.notification?.request?.content?.data)) warmReceived = true
    deliver(response)
  })
  Promise.resolve().then(() => native.getLastNotificationResponseAsync?.()).then((response) => {
    // A persistent older cold tap must not supersede a newer live tap.
    if (!warmReceived) deliver(response)
  }).catch(() => {})
  return () => { cancelled = true; sub.remove?.() }
}
