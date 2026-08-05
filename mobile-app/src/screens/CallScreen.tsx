/**
 * CallScreen — a WhatsApp-style voice CALL with the agentic assistant.
 *
 * Unlike VoiceScreen (a foreground push-to-talk screen), this is a real iOS call:
 * CallKit shows the system call UI, and the conversation keeps running with the
 * screen locked or the app backgrounded. It reuses the shared `useAssistantTurn`
 * hands-free loop verbatim — the only additions are the CallKit lifecycle (via
 * `callManager`) and a call-styled UI.
 *
 * Flow on mount: start the CallKit call → start the hands-free listen loop (forced
 * assistant voice). CallKit's didActivateAudioSession hands the audio session to
 * our expo-av coordinator. Ending (in-app End, Recents, or the LOCK SCREEN) stops
 * the loop, releases audio, and pops the screen.
 *
 * Half-duplex for v1: Harman finishes speaking, then the mic reopens — the status
 * line ("Speaking…") sets that expectation. True barge-in is Phase 2.
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import { Pressable, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { callManager } from "../lib/callManager"
import { useAssistantTurn } from "../lib/useAssistantTurn"
import { stopSpeaking } from "../lib/voice"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"

type Props = NativeStackScreenProps<RootStackParamList, "Call">

/** mm:ss elapsed since the call connected. */
function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

export default function CallScreen({ route, navigation }: Props) {
  const { host, path, label } = route.params
  const t = useTheme()
  const insets = useSafeAreaInsets()
  // Barge-in "Harman, end the call" reaches hangUp via this ref (hangUp is defined
  // below the hook, so the hook gets a stable indirection instead of the closure).
  const hangUpRef = useRef<null | (() => void)>(null)
  const turn = useAssistantTurn(host, path, {
    callMode: true,
    onEndCall: () => hangUpRef.current?.(),
  })
  const { phase, error, startHandsFree, stopHandsFree, enrolled } = turn

  const [muted, setMuted] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const endedRef = useRef(false)

  /** Tear the call down exactly once: stop the loop + playback, end the CallKit
   *  call, and leave the screen. Safe to call from a button or a CallKit event. */
  const hangUp = useCallback(async () => {
    if (endedRef.current) return
    endedRef.current = true
    await stopHandsFree()
    await stopSpeaking().catch(() => {})
    callManager.endCall()
    if (navigation.canGoBack()) navigation.goBack()
  }, [stopHandsFree, navigation])
  hangUpRef.current = hangUp

  // Start the CallKit call + hands-free loop on mount; tear down on unmount.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // If the user hasn't enrolled a voiceprint the wake+verify loop can't fire a
      // turn; still start the call (they can enroll from the Voice screen), but the
      // status line will show the unenrolled hint from the shared hook's error.
      await callManager.startCall(label, {
        onEnd: () => {
          // System / lock-screen End button → tear down through the same path.
          hangUp()
        },
        onMuted: (m) => setMuted(m),
      })
      if (cancelled) return
      await startHandsFree()
    })()
    return () => {
      cancelled = true
      // Unmount safety: ensure everything is released even if we didn't go through
      // hangUp (e.g. a hardware back). endCall/stop are idempotent.
      if (!endedRef.current) {
        stopHandsFree()
        stopSpeaking().catch(() => {})
        callManager.endCall()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Call timer — ticks once connected (phase leaves the initial idle).
  useEffect(() => {
    const id = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(id)
  }, [])

  function toggleMute() {
    const next = !muted
    setMuted(next)
    callManager.setMuted(next)
    // With the mic muted, pause the listen loop; resume when unmuted.
    if (next) stopHandsFree()
    else startHandsFree()
  }

  const statusLine =
    phase === "denied" ? "Microphone access denied"
    : !enrolled ? "Enroll your voice in Voice mode first"
    // A call runs the full agent, which may work silently for a while on a task
    // (tools, files) before it speaks — "Working…" sets that expectation honestly.
    : phase === "thinking" ? "Working…"
    : phase === "speaking" ? "Speaking…"
    : muted ? "Muted"
    : "Listening…"

  // A soft pulsing dot conveys "live" without animation deps: color by phase.
  const dotColor =
    phase === "speaking" ? t.accent
    : phase === "thinking" ? t.textMuted
    : muted ? t.danger
    : "#4caf50"

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top + 40, paddingBottom: insets.bottom + 32, alignItems: "center", justifyContent: "space-between" }}>
      {/* Caller identity + live status. */}
      <View style={{ alignItems: "center", gap: 10, paddingHorizontal: 24 }}>
        <View
          style={{
            width: 112, height: 112, borderRadius: 56, backgroundColor: t.surface,
            alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: t.accent, marginBottom: 8,
          }}
        >
          <Icon name="sparkle" size={48} color={t.accent} />
        </View>
        <Text style={{ color: t.text, fontSize: 24, fontWeight: "700" }}>Harman</Text>
        <Text style={{ color: t.textMuted, fontSize: 14 }} numberOfLines={1}>{label}</Text>
        <Text style={{ color: t.textMuted, fontSize: 13, marginTop: 2 }}>{fmtElapsed(elapsed)}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dotColor }} />
          <Text style={{ color: t.text, fontSize: 16 }}>{statusLine}</Text>
        </View>
        {error ? (
          <Text style={{ color: t.danger, fontSize: 13, textAlign: "center", marginTop: 8, maxWidth: 300 }}>{error}</Text>
        ) : null}
      </View>

      {/* Call controls: Mute + big red End (mirror the CallKit / lock-screen UI). */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 48 }}>
        <View style={{ alignItems: "center", gap: 8 }}>
          <Pressable
            testID="call-mute"
            onPress={toggleMute}
            style={{
              width: 68, height: 68, borderRadius: 34, alignItems: "center", justifyContent: "center",
              backgroundColor: muted ? t.accent : t.surface, borderWidth: 1, borderColor: t.border,
            }}
          >
            <Icon name={muted ? "micOff" : "mic"} size={28} color={muted ? "#fff" : t.text} />
          </Pressable>
          <Text style={{ color: t.textMuted, fontSize: 12 }}>{muted ? "Unmute" : "Mute"}</Text>
        </View>
        <View style={{ alignItems: "center", gap: 8 }}>
          <Pressable
            testID="call-end"
            onPress={hangUp}
            style={{
              width: 68, height: 68, borderRadius: 34, alignItems: "center", justifyContent: "center",
              backgroundColor: t.danger,
            }}
          >
            <Icon name="phone" size={28} color="#fff" />
          </Pressable>
          <Text style={{ color: t.textMuted, fontSize: 12 }}>End</Text>
        </View>
      </View>
    </View>
  )
}
