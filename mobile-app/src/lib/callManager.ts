/**
 * callManager — a thin wrapper over react-native-callkeep that gives the agentic
 * voice feature a real iOS phone call.
 *
 * Why CallKit: it makes iOS treat the assistant conversation as a genuine call —
 * a system full-screen call UI, lock-screen call controls, an entry in Recents,
 * and (the point) audio + CPU that keep running when the screen is locked or the
 * app is backgrounded. The existing `UIBackgroundModes:["audio"]` alone is fragile
 * for continuous background *recording*; a CallKit call is not.
 *
 * Audio ownership (the one real risk): CallKit owns *activation* of the shared
 * AVAudioSession. We never touch the session on activation: whichever audio stack
 * runs the call (the native Fish engine, or the expo-av `audioSession` on the legacy
 * path) sets its own category when it starts, so there is one writer per path.
 *
 * Scope: OUTGOING, user-initiated calls only (tap the phone icon). No PushKit / no
 * incoming-call path — that would need server VoIP push we don't have.
 */
import RNCallKeep from "react-native-callkeep"
import { Platform } from "react-native"
import { stopSpeaking } from "./voice"

// A CallKit call needs a UUID. crypto.randomUUID isn't guaranteed in Hermes, so
// build an RFC-4122-ish v4 from Math.random — uniqueness across one device's call
// history is all we need (this is not a security token).
function uuidv4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

const SETUP_OPTIONS = {
  ios: {
    appName: "Harman",
    supportsVideo: false,
    maximumCallGroups: "1",
    maximumCallsPerCallGroup: "1",
    includesCallsInRecents: true,
  },
  // callkeep's types require an android block; we're iOS-only for this feature, so
  // it's inert filler (no Android CallConnectionService wired).
  android: {
    alertTitle: "Permissions required",
    alertDescription: "Harman needs access to make calls",
    cancelButton: "Cancel",
    okButton: "OK",
    additionalPermissions: [],
    selfManaged: true,
  },
}

/** What the CallScreen wants to know when the system (or lock-screen) ends/mutes
 *  the call, so it can tear down the loop and pop the screen. */
export interface CallHandlers {
  /** The red End button was pressed (in-app, Recents, or lock screen). */
  onEnd: () => void
  /** The Mute button toggled — pause/resume the listen loop accordingly. */
  onMuted?: (muted: boolean) => void
}

class CallManager {
  private uuid: string | null = null
  private didSetup = false
  private listeners: { remove: () => void }[] = []

  /** Whether we're on a platform that has CallKit (iOS). */
  get supported(): boolean {
    return Platform.OS === "ios"
  }

  private async ensureSetup(): Promise<void> {
    if (this.didSetup) return
    await RNCallKeep.setup(SETUP_OPTIONS)
    this.didSetup = true
  }

  /**
   * Start an outgoing call: iOS shows the active-call UI. Returns
   * the call UUID (or null if unsupported). Wire teardown/mute via `handlers`.
   */
  async startCall(label: string, handlers: CallHandlers): Promise<string | null> {
    if (!this.supported) return null
    await this.ensureSetup()
    this.detach() // never stack listeners across calls
    const uuid = uuidv4()
    this.uuid = uuid

    this.listeners.push(
      RNCallKeep.addEventListener("endCall", ({ callUUID }) => {
        if (callUUID.toLowerCase() !== uuid.toLowerCase()) return
        stopSpeaking().catch(() => {})
        handlers.onEnd()
      })
    )
    this.listeners.push(
      RNCallKeep.addEventListener("didPerformSetMutedCallAction", ({ muted, callUUID }) => {
        if (callUUID.toLowerCase() !== uuid.toLowerCase()) return
        handlers.onMuted?.(muted)
      })
    )

    RNCallKeep.startCall(uuid, "Harman", label || "Harman", "generic", false)
    // Mark it connected right away — there's no remote ringing party.
    RNCallKeep.setCurrentCallActive(uuid)
    return uuid
  }

  /** End the active call (from the in-app End button). Idempotent. */
  endCall(): void {
    const uuid = this.uuid
    this.uuid = null
    this.detach()
    if (uuid && this.supported) {
      try {
        RNCallKeep.endCall(uuid)
      } catch {
        /* already ended by the system */
      }
    }
  }

  /** Reflect an in-app mute toggle back to the CallKit UI so both agree. */
  setMuted(muted: boolean): void {
    if (this.uuid && this.supported) RNCallKeep.setMutedCall(this.uuid, muted)
  }

  private detach(): void {
    for (const l of this.listeners) {
      try {
        l.remove()
      } catch {
        /* already removed */
      }
    }
    this.listeners = []
  }
}

export const callManager = new CallManager()
