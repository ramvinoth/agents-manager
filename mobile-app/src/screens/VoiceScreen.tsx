import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { Audio } from "expo-av"
import type { RootStackParamList } from "../../App"
import { api } from "../api/client"
import { groupThread, parseTranscript } from "../lib/thread"
import { prepareAudio, speak, startRecording, stopAndTranscribe } from "../lib/voice"
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
  const sid = (path?.split("/").pop() || "").replace(/\.jsonl$/, "")

  useEffect(() => {
    prepareAudio().then((ok) => !ok && setPhase("denied"))
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
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
    if (phase !== "idle") return
    setError("")
    try {
      recordingRef.current = await startRecording()
      setPhase("listening")
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function onPressOut() {
    if (phase !== "listening" || !recordingRef.current) return
    const rec = recordingRef.current
    recordingRef.current = null
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
