import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { Audio } from "expo-av"
import type { RootStackParamList } from "../../App"
import { api } from "../api/client"
import { groupThread, parseTranscript } from "../lib/thread"
import {
  enrollVoice,
  prepareAudio,
  resetRecorder,
  speak,
  startListening,
  startRecording,
  stopAndTranscribe,
  stopListening,
  stopSpeaking,
  type ListenEvent,
} from "../lib/voice"
import { composerPrefs } from "../state/config"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "Voice">

// The voice loop's phases — each maps to a mic-button state + status line.
// "waiting" is the hands-free resting state (listening for the wake word).
type Phase = "idle" | "listening" | "waiting" | "thinking" | "speaking" | "denied"

/**
 * Voice conversation for one session, in two modes:
 *  - Push-to-talk (default): hold the mic, speak, release → transcribe → chat
 *    turn → spoken reply. Turn-based; mic disabled while thinking/speaking.
 *  - Hands-free: flip the toggle and the mic stays live. The app streams short
 *    audio windows to the server, which fires a turn ONLY when the enrolled user
 *    says "Harman …" (wake word + strict speaker verification on the GPU box).
 *    Requires a one-time voice enrollment.
 *
 * Both modes reuse the same chat pipeline (api.chat + status poll); voice is just
 * audio I/O around a normal turn.
 */
export default function VoiceScreen({ route }: Props) {
  const { host, path, label } = route.params
  const styles = useStyles()
  const t = useTheme()
  const [phase, setPhase] = useState<Phase>("idle")
  const [heard, setHeard] = useState("") // last transcribed user utterance
  const [reply, setReply] = useState("") // last spoken agent reply
  const [error, setError] = useState("")
  const [handsFree, setHandsFree] = useState(false)
  const [enrolled, setEnrolled] = useState(false)
  const [enrolling, setEnrolling] = useState(false)
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
  // Hands-free bookkeeping: the active listen-loop stopper, and a busy flag so a
  // wake utterance that lands while a turn is already running is ignored.
  const listenStopRef = useRef<null | (() => void)>(null)
  const busyRef = useRef(false)
  const handsFreeRef = useRef(false)
  const sid = (path?.split("/").pop() || "").replace(/\.jsonl$/, "")

  useEffect(() => {
    prepareAudio().then((ok) => !ok && setPhase("denied"))
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      if (maxRecRef.current) clearTimeout(maxRecRef.current)
      // Unmounting mid-record: release the recorder so the mic is freed and the
      // next screen visit can start a fresh recording (single-recorder rule).
      recordingRef.current = null
      stopListening()
      stopSpeaking()
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

  /** Run one turn from already-transcribed text: send it into the SAME chat
   *  pipeline a typed message uses, await the reply, and speak it. Shared by
   *  push-to-talk (finishTurn) and hands-free (onListenEvent). */
  const runTurn = useCallback(
    async (text: string): Promise<void> => {
      if (!text.trim()) return
      setHeard(text)
      setPhase("thinking")
      try {
        const p = composerPrefs()
        await api.chat({ message: text, path: path || undefined, host, agent: "claude", mode: p.mode, model: p.model })
        const answer = await awaitReply()
        setReply(answer)
        setPhase("speaking")
        await speak(answer)
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [host, path, awaitReply]
  )

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

  /** Begin the hands-free listen loop: stream windows, act on wake utterances. */
  const startHandsFree = useCallback(async () => {
    setError("")
    setPhase("waiting")
    const stop = await startListening(onListenEvent, { speakerId: "default" })
    listenStopRef.current = stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Stop the hands-free loop and settle back to idle. */
  const stopHandsFree = useCallback(async () => {
    listenStopRef.current = null
    await stopListening()
    if (!busyRef.current) setPhase("idle")
  }, [])

  /** Each window's verdict from the server. Fire a turn only on a verified
   *  "Harman …" utterance; ignore idle windows and anything while already busy. */
  const onListenEvent = useCallback(
    async (e: ListenEvent) => {
      if (e.type === "unenrolled") {
        setEnrolled(false)
        setError("Enroll your voice first so Harman only answers you.")
        return
      }
      if (e.type === "error") return
      if (e.type !== "utterance" || !e.text.trim()) return
      if (busyRef.current) return // a turn is already running
      busyRef.current = true
      // Pause listening while we run + speak the turn (mic and playback share the
      // one audio session); resume afterward if still in hands-free mode.
      await stopListening()
      try {
        await runTurn(e.text)
      } finally {
        busyRef.current = false
        if (handsFreeRef.current) {
          setPhase("waiting")
          const stop = await startListening(onListenEvent, { speakerId: "default" })
          listenStopRef.current = stop
        } else {
          setPhase("idle")
        }
      }
    },
    [runTurn]
  )

  /** Toggle hands-free on/off. Turning it on requires an enrolled voiceprint. */
  async function toggleHandsFree(on: boolean) {
    if (on && !enrolled) {
      setError("Enroll your voice first (tap “Enroll my voice”).")
      return
    }
    setHandsFree(on)
    handsFreeRef.current = on
    if (on) await startHandsFree()
    else await stopHandsFree()
  }

  /** Record ~5s and enroll the voiceprint so hands-free can verify the speaker. */
  async function onEnroll() {
    setError("")
    setEnrolling(true)
    try {
      const ok = await enrollVoice(5, "default")
      setEnrolled(ok)
      if (!ok) setError("Enrollment failed — try again in a quiet spot.")
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setEnrolling(false)
    }
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

      {/* Hands-free controls: enroll once, then toggle. */}
      <View style={{ alignSelf: "stretch", paddingHorizontal: 24, gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>Hands-free</Text>
            <Text style={{ color: t.textMuted, fontSize: 12 }}>
              {enrolled ? "Say “Harman” then your question" : "Enroll your voice to enable"}
            </Text>
          </View>
          <Switch
            testID="voice-handsfree"
            value={handsFree}
            onValueChange={toggleHandsFree}
            disabled={phase === "denied" || !enrolled}
          />
        </View>
        {!enrolled ? (
          <Pressable
            testID="voice-enroll"
            onPress={onEnroll}
            disabled={enrolling || phase === "denied"}
            style={{
              alignItems: "center",
              paddingVertical: 12,
              borderRadius: 12,
              backgroundColor: t.chipBg,
              borderWidth: 1,
              borderColor: t.border,
            }}
          >
            {enrolling ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <ActivityIndicator color={t.accent} />
                <Text style={{ color: t.text }}>Recording — keep talking…</Text>
              </View>
            ) : (
              <Text style={{ color: t.accent, fontWeight: "600" }}>Enroll my voice</Text>
            )}
          </Pressable>
        ) : null}
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
