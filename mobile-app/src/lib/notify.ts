/**
 * Local notifications for agent replies.
 *
 * NOTE: expo-notifications adds the `aps-environment` entitlement via
 * autolinking (removing its config plugin does NOT stop this). The App ID
 * therefore has the Push Notifications capability enabled and the
 * "Agents Manager AppStore" profile was regenerated to include it — otherwise
 * -exportArchive fails with "profile doesn't include the Push Notifications
 * capability". We only use LOCAL notifications, but the entitlement rides along.
 *
 * Every call is defensive: expo-notifications is a NATIVE module, so on a build
 * that predates it (or in Expo Go) the import resolves to something unusable.
 * A notification is a nice-to-have — it must never take the app down, so all
 * failures are swallowed and the feature simply goes quiet.
 */
let Notifications: any = null
let ready = false
// The cold-start notification response is returned persistently by the OS, so we
// track the last-handled id to avoid re-navigating on a remount.
let _lastColdId: string | null = null
// Set by the app shell: true when a push's payload is about what the user is looking at.
let _suppressForeground: (data: Record<string, unknown>) => boolean = () => false
export function setForegroundSuppressor(fn: (data: Record<string, unknown>) => boolean): void {
  _suppressForeground = fn
}

async function load() {
  if (ready) return Notifications
  try {
    Notifications = require("expo-notifications")
    Notifications.setNotificationHandler({
      // Show a banner even when the app is foregrounded. iOS 14+/SDK 51 split
      // the old `shouldShowAlert` into `shouldShowBanner` + `shouldShowList`;
      // we set all three so it works across expo-notifications versions.
      handleNotification: async (n: any) => {
        const quiet = _suppressForeground(n?.request?.content?.data ?? {})
        return {
          shouldShowAlert: !quiet,
          shouldShowBanner: !quiet,
          shouldShowList: !quiet,
          shouldPlaySound: !quiet,
          shouldSetBadge: false,
        }
      },
    })
    ready = true // only mark ready AFTER the handler install succeeds, so a
    // transient throw (version skew) doesn't permanently disable notifications.
  } catch {
    Notifications = null
  }
  return Notifications
}

/** Ask once. Returns false if unavailable or denied — callers just skip notifying. */
export async function ensurePermission(): Promise<boolean> {
  const N = await load()
  if (!N) return false
  try {
    const current = await N.getPermissionsAsync()
    if (current.granted) return true
    const asked = await N.requestPermissionsAsync()
    return !!asked.granted
  } catch {
    return false
  }
}

// The APNs device token registered with the server this session, so logout can
// unregister exactly what was registered.
let _pushToken: string | null = null

/**
 * Register this device for BACKGROUND push and hand the raw APNs device token to
 * the server via `send`. Local notifications only fire while foregrounded (iOS
 * freezes JS timers otherwise), so background delivery comes from the server
 * talking to APNs directly. Returns the token, or null if unavailable/denied.
 *
 * Uses getDevicePushTokenAsync (raw APNs token) — the server contacts Apple
 * directly, so no Expo push token / EAS projectId is needed.
 *
 * Best-effort throughout: a device without push (simulator, Expo Go, denied
 * permission) simply gets no background notifications rather than an error.
 */
export async function registerForPush(
  send: (token: string) => Promise<unknown>
): Promise<string | null> {
  const N = await load()
  if (!N) return null
  try {
    if (!(await ensurePermission())) return null
    const res = await N.getDevicePushTokenAsync()
    const token = res?.data
    if (!token || typeof token !== "string") return null
    _pushToken = token
    try {
      await send(token)
    } catch {
      /* server unreachable now; re-register next launch */
    }
    return token
  } catch {
    return null
  }
}

/** Tell the server to forget this device's token (on logout). Best-effort. */
export async function unregisterPush(send: (token: string) => Promise<unknown>): Promise<void> {
  if (!_pushToken) return
  try {
    await send(_pushToken)
  } catch {
    /* best-effort */
  }
  _pushToken = null
}

/**
 * Route notification taps to the right chat. The server merges `{session, host}`
 * into every push payload (orchestrator/push.py:notify_all), so a tap carries enough to
 * open the exact session. Handles BOTH cases: a tap while the app is
 * running/backgrounded (addNotificationResponseReceivedListener) AND a cold start
 * where the tap launched the app (getLastNotificationResponseAsync). Best-effort:
 * on a build without the native module it simply does nothing. Returns an
 * unsubscribe fn.
 */
export function onNotificationTap(handler: (data: Record<string, unknown>, title: string) => void): () => void {
  let sub: { remove?: () => void } | null = null
  let cancelled = false
  ;(async () => {
    const N = await load()
    if (!N || cancelled) return
    try {
      // Cold start: the tap that launched the app. getLastNotificationResponseAsync
      // returns it PERSISTENTLY, so a remount would re-fire it and re-navigate —
      // dedupe by the notification id so each cold tap is handled at most once.
      const last = await N.getLastNotificationResponseAsync?.()
      const coldContent = last?.notification?.request?.content
      const coldData = coldContent?.data
      const coldId = last?.notification?.request?.identifier
      if (coldData && coldId && coldId !== _lastColdId) {
        _lastColdId = coldId
        handler(coldData, coldContent?.title ?? "")
      }
      // Warm taps while running/backgrounded.
      sub = N.addNotificationResponseReceivedListener((resp: any) => {
        const content = resp?.notification?.request?.content
        if (content?.data) handler(content.data, content.title ?? "")
      })
    } catch {
      /* tap routing is best-effort */
    }
  })()
  return () => {
    cancelled = true
    try {
      sub?.remove?.()
    } catch {
      /* already removed */
    }
  }
}

