import React, { useRef, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { Audio } from "expo-av"
import type { RootStackParamList } from "../../App"
import { setAssistantVoice, startRecording, stopAndTranscribe } from "../lib/voice"
import { useAssistantTurn } from "../lib/useAssistantTurn"
import { ExchangeView } from "./ThreadScreen"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "Voice">

/**
 * Voice conversation for one session, in two modes:
 *  - Push-to-talk (default): hold the mic, speak, release → transcribe → chat
 *    turn → spoken reply. Turn-based; mic disabled while thinking/speaking.
 *  - Hands-free: flip the toggle and the mic stays live. The app streams short
 *    audio windows to the server, which fires a turn ONLY when the enrolled user
 *    says "Harman …" (wake word + strict speaker verification on the GPU box).
 *    Requires a one-time voice enrollment.
 *
 * The shared turn engine (phase machine, runTurn, hands-free loop, enrollment)
 * lives in `useAssistantTurn` — the same hook drives the CallKit Call screen.
 * This screen adds only the push-to-talk gesture handling on top.
 */
export default function VoiceScreen({ route }: Props) {
  const { host, path, label } = route.params
  const styles = useStyles()
  const t = useTheme()
  const turn = useAssistantTurn(host, path)
  const {
    phase, setPhase, heard, reply, replyItem, error, setError, runTurn,
    startHandsFree, stopHandsFree, enrolled, enrolling, onEnroll,
    assistantVoice, setAssistantVoicePref,
  } = turn

  const [handsFree, setHandsFree] = useState(false)
  const recordingRef = useRef<Audio.Recording | null>(null)
  // True between onPressIn and onPressOut. Guards the async gap while the
  // recorder is still starting up: if the finger lifts before startRecording()
  // resolves, we must stop immediately rather than strand a live recording (the
  // "stuck in listening" bug).
  const pressedRef = useRef(false)
  // Safety: a max recording length so a lost onPressOut (app backgrounded
  // mid-press, gesture cancelled) can't leave the recorder running forever.
  const maxRecRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function onPressIn() {
    // Only start from a settled idle state; ignore presses while busy.
    if (phase !== "idle" && phase !== "listening") return
    if (recordingRef.current) return // already recording
    setError("")
    pressedRef.current = true
    setPhase("listening")
    try {
      const rec = await startRecording()
      // If the finger was already lifted during startup, don't strand a live
      // recording — stop it now and run the turn from whatever was captured.
      recordingRef.current = rec
      // Auto-stop after 60s so a lost onPressOut can't record forever.
      if (maxRecRef.current) clearTimeout(maxRecRef.current)
      maxRecRef.current = setTimeout(() => {
        pressedRef.current = false
        if (recordingRef.current) finishTurn()
      }, 60000)
      if (!pressedRef.current) {
        await finishTurn()
      }
    } catch (e) {
      recordingRef.current = null
      pressedRef.current = false
      setError((e as Error).message)
      setPhase("idle")
    }
  }

  function onPressOut() {
    if (!pressedRef.current) return
    pressedRef.current = false
    // If the recorder is still starting up, onPressIn's own post-await check will
    // finish the turn once it resolves. Otherwise finish now.
    if (recordingRef.current && phase === "listening") {
      finishTurn()
    }
  }

  /** Stop recording → STT → chat turn → await reply → speak it. Always returns
   *  to idle (even on error) so the mic can never get stuck. */
  async function finishTurn() {
    if (maxRecRef.current) {
      clearTimeout(maxRecRef.current)
      maxRecRef.current = null
    }
    const rec = recordingRef.current
    recordingRef.current = null
    if (!rec) {
      setPhase("idle")
      return
    }
    setPhase("thinking")
    try {
      const text = await stopAndTranscribe(rec)
      await runTurn(text)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPhase("idle")
    }
  }

  // ---- Hands-free mode --------------------------------------------------------

  /** Toggle hands-free on/off. Turning it on requires an enrolled voiceprint.
   *  The loop itself lives in the shared hook. */
  async function toggleHandsFree(on: boolean) {
    if (on && !enrolled) {
      setError("Enroll your voice first (tap “Enroll”).")
      return
    }
    setHandsFree(on)
    if (on) await startHandsFree()
    else await stopHandsFree()
  }

  const status =
    phase === "listening" ? "Listening…"
    : phase === "waiting" ? "Listening for “Harman”…"
    : phase === "thinking" ? "Thinking…"
    : phase === "speaking" ? "Speaking…"
    : phase === "denied" ? "Microphone access denied"
    : handsFree ? "Hands-free on"
    : "Hold to talk"

  const micColor = phase === "denied" ? t.textMuted : phase === "listening" || phase === "waiting" ? "#fff" : t.accent

  return (
    <View style={[styles.center, { justifyContent: "space-between", paddingVertical: 32 }]}>
      {/* Conversation strip: what was heard, what was said. */}
      <ScrollView style={{ alignSelf: "stretch" }} contentContainerStyle={{ padding: 20, gap: 14 }}>
        <Text style={[styles.rowSub, { textAlign: "center" }]} numberOfLines={1}>
          {label}
        </Text>
        {heard ? (
          <View style={{ alignSelf: "flex-end", maxWidth: "85%", backgroundColor: t.accent, borderRadius: 16, padding: 12 }}>
            <Text style={{ color: "#fff", fontSize: 16, flexShrink: 1 }}>{heard}</Text>
          </View>
        ) : null}
        {replyItem ? (
          // Harness turn: render the whole exchange chat-style — tool steps, plan
          // card, and markdown — identical to the thread, not just plain prose.
          <ExchangeView
            finalText={replyItem.finalText}
            steps={replyItem.steps}
            plan={replyItem.plan?.input}
            defaultOpen
            ts={replyItem.ts}
          />
        ) : reply ? (
          // Assistant-appliance path (no exchange item): plain spoken text.
          <View style={{ alignSelf: "flex-start", maxWidth: "85%", backgroundColor: t.chipBg, borderRadius: 16, padding: 12 }}>
            <Text style={{ color: t.text, fontSize: 16, flexShrink: 1 }}>{reply}</Text>
          </View>
        ) : null}
        {error ? (
          <View
            style={{
              alignSelf: "center", maxWidth: "90%", flexDirection: "row", alignItems: "center", gap: 8,
              backgroundColor: t.dangerBg, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14,
            }}
          >
            <Icon name="warning" size={16} color={t.danger} />
            <Text style={{ color: t.danger, fontSize: 13, flex: 1 }}>{error}</Text>
            <Pressable onPress={() => setError("")} hitSlop={8}>
              <Icon name="close" size={16} color={t.danger} />
            </Pressable>
          </View>
        ) : null}
      </ScrollView>

      {/* Settings card: mode toggles + enroll, grouped so the eye parses one
          block instead of three loose rows. Icon + title + one-line hint each. */}
      <View
        style={{
          alignSelf: "stretch",
          marginHorizontal: 20,
          backgroundColor: t.surface,
          borderRadius: 18,
          borderWidth: 1,
          borderColor: t.border,
          overflow: "hidden",
        }}
      >
        {/* Assistant voice — the headline capability, so it leads. */}
        <View style={{ flexDirection: "row", alignItems: "center", padding: 16, gap: 12 }}>
          <View
            style={{
              width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center",
              backgroundColor: assistantVoice ? t.accent : t.chipBg,
            }}
          >
            <Icon name="sparkle" size={20} color={assistantVoice ? "#fff" : t.textMuted} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>Assistant voice</Text>
            <Text style={{ color: t.textMuted, fontSize: 12 }}>Natural voice · live tools</Text>
          </View>
          <Switch
            testID="voice-assistant"
            value={assistantVoice}
            onValueChange={(on) => {
              setAssistantVoicePref(on)
              setAssistantVoice(on)
            }}
            disabled={phase === "denied"}
          />
        </View>

        <View style={{ height: 1, backgroundColor: t.border, marginLeft: 64 }} />

        {/* Hands-free — needs enrollment; the hint doubles as the CTA. */}
        <View style={{ flexDirection: "row", alignItems: "center", padding: 16, gap: 12 }}>
          <View
            style={{
              width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center",
              backgroundColor: handsFree ? t.accent : t.chipBg,
            }}
          >
            <Icon name="volume" size={20} color={handsFree ? "#fff" : t.textMuted} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>Hands-free</Text>
            <Text style={{ color: t.textMuted, fontSize: 12 }}>
              {enrolled ? "Say “Harman”, then ask" : "Enroll your voice to enable"}
            </Text>
          </View>
          {enrolled ? (
            <Switch
              testID="voice-handsfree"
              value={handsFree}
              onValueChange={toggleHandsFree}
              disabled={phase === "denied"}
            />
          ) : (
            <Pressable
              testID="voice-enroll"
              onPress={onEnroll}
              disabled={enrolling || phase === "denied"}
              style={{
                paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
                backgroundColor: t.chipBg, borderWidth: 1, borderColor: t.accent,
                flexDirection: "row", alignItems: "center", gap: 6,
              }}
            >
              {enrolling ? (
                <>
                  <ActivityIndicator color={t.accent} size="small" />
                  <Text style={{ color: t.accent, fontWeight: "600", fontSize: 13 }}>Recording…</Text>
                </>
              ) : (
                <Text style={{ color: t.accent, fontWeight: "600", fontSize: 13 }}>Enroll</Text>
              )}
            </Pressable>
          )}
        </View>
      </View>

      {/* Push-to-talk button + status. Hidden while hands-free is active. */}
      <View style={{ alignItems: "center", gap: 16 }}>
        <Text style={{ color: t.textMuted, fontSize: 15 }}>{status}</Text>
        <Pressable
          testID="voice-mic"
          onPressIn={handsFree ? undefined : onPressIn}
          onPressOut={handsFree ? undefined : onPressOut}
          disabled={handsFree || phase === "thinking" || phase === "speaking" || phase === "denied"}
          style={{
            width: 96,
            height: 96,
            borderRadius: 48,
            alignItems: "center",
            justifyContent: "center",
            opacity: handsFree ? 0.55 : 1,
            backgroundColor: phase === "listening" || phase === "waiting" ? t.accent : t.surface,
            borderWidth: 2,
            borderColor: phase === "denied" ? t.border : t.accent,
          }}
        >
          {phase === "thinking" || phase === "speaking" ? (
            <ActivityIndicator color={t.accent} />
          ) : (
            <Icon name={phase === "denied" ? "micOff" : "mic"} size={40} color={micColor} />
          )}
        </Pressable>
      </View>
    </View>
  )
}
