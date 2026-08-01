import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { Audio } from "expo-av"
import type { RootStackParamList } from "../../App"
import { api } from "../api/client"
import { groupThread, parseTranscript } from "../lib/thread"
import { prepareAudio, resetRecorder, speak, startRecording, stopAndTranscribe } from "../lib/voice"
import { composerPrefs } from "../state/config"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "Voice">

// The voice loop's phases — each maps to a mic-button state + status line.
type Phase = "idle" | "listening" | "thinking" | "speaking" | "denied"

/**
 * Push-to-talk voice conversation for one session. Hold the mic to speak; on
 * release the audio is transcribed (STT), sent as a normal chat turn, and when
 * the agent's reply lands it is spoken back (TTS). Everything reuses the existing
 * chat pipeline (api.chat + status poll) — voice is just audio I/O around a turn.
 *
 * Phase 1 (this screen) is strictly turn-based: the mic is disabled while the
 * agent thinks/speaks. Hands-free/barge-in is Phase 2.
 */
export default function VoiceScreen({ route }: Props) {
  const { host, path, label } = route.params
  const styles = useStyles()
  const t = useTheme()
  const [phase, setPhase] = useState<Phase>("idle")
  const [heard, setHeard] = useState("") // last transcribed user utterance
  const [reply, setReply] = useState("") // last spoken agent reply
  const [error, setError] = useState("")
  const recordingRef = useRef<Audio.Recording | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // True between onPressIn and onPressOut. Guards the async gap while the
  // recorder is still starting up: if the finger lifts before startRecording()
  // resolves, we must stop immediately rather than strand a live recording (the
  // "stuck in listening" bug).
  const pressedRef = useRef(false)
  // Safety: a max recording length so a lost onPressOut (app backgrounded
  // mid-press, gesture cancelled) can't leave the recorder running forever.
  const maxRecRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sid = (path?.split("/").pop() || "").replace(/\.jsonl$/, "")

  useEffect(() => {
    prepareAudio().then((ok) => !ok && setPhase("denied"))
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      if (maxRecRef.current) clearTimeout(maxRecRef.current)
      // Unmounting mid-record: release the recorder so the mic is freed and the
      // next screen visit can start a fresh recording (single-recorder rule).
      recordingRef.current = null
      resetRecorder()
    }
  }, [])

  /** Wait for the in-flight turn to finish, then return the agent's final text
   *  by reading + parsing the transcript tail (same source the thread renders). */
  const awaitReply = useCallback((): Promise<string> => {
    return new Promise((resolve) => {
      let ticks = 0
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        ticks++
        try {
          const s = await api.chatStatus(sid)
          if (!s.running || ticks > 400) {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
            const lines = await api.sessionRead(host, path || "", 60)
            const items = groupThread(parseTranscript(lines))
            let last = ""
            for (const it of items) if (it.kind === "exchange" && it.finalText) last = it.finalText
            resolve(last)
          }
        } catch {
          /* keep polling through transient errors */
        }
      }, 1500)
    })
  }, [sid, host, path])

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
      if (!text.trim()) {
        setPhase("idle")
        return
      }
      setHeard(text)
      // Feed it into the SAME chat pipeline a typed message uses.
      const p = composerPrefs()
      await api.chat({ message: text, path: path || undefined, host, agent: "claude", mode: p.mode, model: p.model })
      const answer = await awaitReply()
      setReply(answer)
      setPhase("speaking")
      await speak(answer)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPhase("idle")
    }
  }

  const status =
    phase === "listening" ? "Listening…"
    : phase === "thinking" ? "Thinking…"
    : phase === "speaking" ? "Speaking…"
    : phase === "denied" ? "Microphone access denied"
    : "Hold to talk"

  const micColor = phase === "denied" ? t.textMuted : phase === "listening" ? "#fff" : t.accent

  return (
    <View style={[styles.center, { justifyContent: "space-between", paddingVertical: 32 }]}>
      {/* Conversation strip: what was heard, what was said. */}
      <ScrollView style={{ alignSelf: "stretch" }} contentContainerStyle={{ padding: 20, gap: 14 }}>
        <Text style={[styles.rowSub, { textAlign: "center" }]} numberOfLines={1}>
          {label}
        </Text>
        {heard ? (
          <View style={{ alignSelf: "flex-end", maxWidth: "85%", backgroundColor: t.accent, borderRadius: 16, padding: 12 }}>
            <Text style={{ color: "#fff", fontSize: 16 }}>{heard}</Text>
          </View>
        ) : null}
        {reply ? (
          <View style={{ alignSelf: "flex-start", maxWidth: "85%", backgroundColor: t.chipBg, borderRadius: 16, padding: 12 }}>
            <Text style={{ color: t.text, fontSize: 16 }}>{reply}</Text>
          </View>
        ) : null}
        {error ? <Text style={[styles.error, { textAlign: "center" }]}>{error}</Text> : null}
      </ScrollView>

      {/* Push-to-talk button + status. */}
      <View style={{ alignItems: "center", gap: 16 }}>
        <Text style={{ color: t.textMuted, fontSize: 15 }}>{status}</Text>
        <Pressable
          testID="voice-mic"
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          disabled={phase === "thinking" || phase === "speaking" || phase === "denied"}
          style={{
            width: 96,
            height: 96,
            borderRadius: 48,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: phase === "listening" ? t.accent : t.surface,
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
