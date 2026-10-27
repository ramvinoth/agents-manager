/**
 * Physical feedback for the one-tap decisions and card moves that drive the
 * board. The single boundary to the native module: screens call tap/success/
 * warning, never expo-haptics directly.
 *
 * expo-haptics is a NATIVE module whose entry EAGERLY calls
 * requireNativeModule('ExpoHaptics') at import time — on a build that predates
 * the pod (the e2e tree reuses an ios/ without it) a static `import` would THROW
 * at module load and white-screen whatever screen imported it. A buzz is a
 * flourish, never on the critical path, so we load it the way notify.ts/attach.ts
 * load their native modules: a lazy require() behind try/catch, cached once. A
 * missing module, an older simulator, or a device with the Taptic Engine off all
 * degrade to a silent no-op. iOS already honours the system "System Haptics"
 * switch globally, so there is no app-level setting to add.
 */
let Haptics: any = null
let ready = false

function load() {
  if (ready) return Haptics
  try {
    Haptics = require("expo-haptics")
  } catch {
    Haptics = null
  }
  ready = true // cache the outcome either way: never re-require per buzz.
  return Haptics
}

const fire = (pick: (h: any) => Promise<void>) => {
  const h = load()
  if (!h) return
  try {
    pick(h)?.catch(() => {})
  } catch {
    // A synchronous throw from the native bridge is swallowed too — the buzz
    // is never allowed to surface an error to the caller.
  }
}

/** A real card move landed in a new column, or an item was consumed. */
export const tap = () => fire((h) => h.impactAsync(h.ImpactFeedbackStyle.Light))

/** An affirmative decision: Allow a tool, Approve a plan/Red action, send an answer. */
export const success = () => fire((h) => h.notificationAsync(h.NotificationFeedbackType.Success))

/** A negative decision: Deny or Decline. */
export const warning = () => fire((h) => h.notificationAsync(h.NotificationFeedbackType.Warning))
