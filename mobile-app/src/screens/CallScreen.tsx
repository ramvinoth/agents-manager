/**
 * CallScreen — a WhatsApp-style voice CALL with Manager.
 *
 * CallKit shows the system call UI, and the conversation keeps running with the
 * screen locked or the app backgrounded. `useAssistantTurn` owns the listen /
 * think / speak loop against the fast call brain — the only additions here are
 * the CallKit lifecycle (via `callManager`) and a call-styled UI that shows the
 * last thing heard and the last reply.
 *
 * Flow on mount: start the CallKit call → start the listen loop. CallKit's
 * didActivateAudioSession hands the audio session to our expo-av coordinator.
 * Ending (in-app End, Recents, or the LOCK SCREEN) stops the loop, releases
 * audio, and pops the screen.
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
import { useStyles } from "../lib/styles"

type Props = NativeStackScreenProps<RootStackParamList, "Call">

/** mm:ss elapsed since the call connected. */
function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

export default function CallScreen({ route, navigation }: Props) {
  const { path, label } = route.params
  const styles = useStyles()
  const t = useTheme()
  const insets = useSafeAreaInsets()
  // Barge-in "Manager, end the call" reaches hangUp via this ref (hangUp is defined
  // below the hook, so the hook gets a stable indirection instead of the closure).
  const hangUpRef = useRef<null | (() => void)>(null)
  const { phase, engine, model, heard, reply, error, startHandsFree, stopHandsFree } = useAssistantTurn(path, {
    onEndCall: () => hangUpRef.current?.(),
  })

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
    : phase === "connecting" ? (engine === "nemotron" ? "Loading voice model…" : "Connecting…")
    : phase === "thinking" ? "Thinking…"
    : phase === "speaking" ? "Speaking…"
    : muted ? "Muted"
    : "Listening…"

  // A soft pulsing dot conveys "live" without animation deps: color by phase.
  const dotColor =
    phase === "speaking" ? t.accent
    : phase === "thinking" || phase === "connecting" ? t.textMuted
    : muted ? t.danger
    : t.success

  return (
    <View style={[styles.callPage, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 32 }]}>
      {/* Caller identity + live status. */}
      <View style={styles.callIdentity}>
        <View style={styles.callAvatar}>
          <Icon name="sparkle" size={48} color={t.accent} />
        </View>
        <Text style={styles.callName}>Manager</Text>
        <Text style={styles.callLabel} numberOfLines={1}>{label}</Text>
        {/* The server's own name for what is answering — so a tester can tell a
            Nemotron call from the STT/brain/TTS path without guessing. */}
        {engine ? (
          <Text style={styles.callCaption} numberOfLines={1}>
            {engine === "nemotron" ? `Voice: ${model || "Nemotron"}` : `Brain: ${model || "call brain"}`}
          </Text>
        ) : null}
        <Text style={styles.callElapsed}>{fmtElapsed(elapsed)}</Text>
        <View style={styles.callStatus}>
          <View style={[styles.callDot, { backgroundColor: dotColor }]} />
          <Text style={styles.callStatusText}>{statusLine}</Text>
        </View>
        {/* The exchange in text, so a glance confirms what was heard and said. */}
        {heard ? (
          <Text style={styles.callHeard} numberOfLines={2}>
            You: {heard}
          </Text>
        ) : null}
        {reply ? (
          <Text style={styles.callReply} numberOfLines={4}>
            {reply}
          </Text>
        ) : null}
        {error ? (
          <Text style={styles.callError}>{error}</Text>
        ) : null}
      </View>

      {/* Call controls: Mute + big red End (mirror the CallKit / lock-screen UI). */}
      <View style={styles.callControls}>
        <View style={styles.callControl}>
          <Pressable
            testID="call-mute"
            onPress={toggleMute}
            style={[styles.callBtn, styles.callMute, muted ? styles.callMuteOn : null]}
          >
            <Icon name={muted ? "micOff" : "mic"} size={28} color={muted ? t.onAccent : t.text} />
          </Pressable>
          <Text style={styles.callCaption}>{muted ? "Unmute" : "Mute"}</Text>
        </View>
        <View style={styles.callControl}>
          <Pressable
            testID="call-end"
            onPress={hangUp}
            style={[styles.callBtn, styles.callEnd]}
          >
            <Icon name="phone" size={28} color={t.onAccent} />
          </Pressable>
          <Text style={styles.callCaption}>End</Text>
        </View>
      </View>
    </View>
  )
}
