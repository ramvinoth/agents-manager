import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, FlatList, Text, View } from "react-native"
import { Pressable } from "../components/Tracked"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import { Audio } from "expo-av"
import * as FileSystem from "expo-file-system"
import type { RootStackParamList } from "../../App"
import { api } from "../api/client"
import { setToken } from "../state/config"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
import { userError } from "../lib/errors"
import { callLength, callPreview, callWhen, mergeCalls, speakerLabel, type CallEntry } from "../lib/callLog"

type Props = NativeStackScreenProps<RootStackParamList, "CallLog">
type Stream = "caller" | "reply"
type Playing = { id: string; stream: Stream } | null

// Past calls, newest first. Transcripts come with the page; voice is fetched only when a Play is tapped.
export default function CallLogScreen({ navigation }: Props) {
  const t = useTheme()
  const styles = useStyles()
  const insets = useSafeAreaInsets()
  const [calls, setCalls] = useState<CallEntry[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState<"initial" | "refresh" | "older" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [olderError, setOlderError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [playing, setPlaying] = useState<Playing>(null)
  const [playError, setPlayError] = useState<{ id: string; text: string } | null>(null)
  const request = useRef(0)
  const busy = useRef<string | null>(null)
  const sound = useRef<Audio.Sound | null>(null)
  const tmpFile = useRef<string | null>(null)

  const load = useCallback(async (mode: "initial" | "refresh" | "older", before?: number) => {
    if (mode === "older" && busy.current) return
    const current = ++request.current
    busy.current = mode
    setLoading(mode)
    try {
      const page = await api.callLog(before)
      if (current !== request.current) return
      setCalls((prev) => (mode === "older" ? mergeCalls(prev, page.calls) : page.calls))
      setNext(page.next)
      setLoaded(true)
      setError(null)
      setOlderError(null)
    } catch (e) {
      if (current !== request.current) return
      if ((e as { status?: number })?.status === 401) { setToken(null); navigation.replace("Login"); return }
      const msg = userError(e, "the call log")
      if (mode === "older") setOlderError(msg); else setError(msg)
    } finally {
      if (current === request.current) { busy.current = null; setLoading(null) }
    }
  }, [navigation])

  const stop = useCallback(async () => {
    const s = sound.current, f = tmpFile.current
    sound.current = null; tmpFile.current = null
    setPlaying(null)
    if (s) await s.unloadAsync().catch(() => {})
    if (f) await FileSystem.deleteAsync(f, { idempotent: true }).catch(() => {})
  }, [])

  useEffect(() => {
    void load("initial")
    return () => { ++request.current; busy.current = null; void stop() }
  }, [load, stop])

  const play = async (id: string, stream: Stream) => {
    if (playing?.id === id && playing.stream === stream) { await stop(); return }
    await stop()
    setPlayError(null)
    setPlaying({ id, stream })
    try {
      const dest = `${FileSystem.cacheDirectory}call-${id}-${stream}.wav`
      const src = await api.callLogAudio(id, stream, dest)
      if (src.file) tmpFile.current = src.url
      const { sound: s } = await Audio.Sound.createAsync(
        { uri: src.url, headers: src.headers },
        { shouldPlay: true },
        (st) => { if (st.isLoaded && st.didJustFinish) void stop() },
      )
      sound.current = s
    } catch (e) {
      await stop()
      setPlayError({ id, text: userError(e, "that recording", "play") })
    }
  }

  const renderCall = ({ item }: { item: CallEntry }) => {
    const expanded = open === item.call_id
    const isPlaying = (s: Stream) => playing?.id === item.call_id && playing.stream === s
    return (
      <View>
        <Pressable
          testID={`call-log-row-${item.call_id}`}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setOpen(expanded ? null : item.call_id)}
          style={({ pressed }) => [styles.audRow, pressed ? styles.audRowPressed : null]}
        >
          <View style={styles.audRowBody}>
            <Text style={styles.audTime}>{item.agent} · {callWhen(item.started)} · {callLength(item.duration)} · {item.turns} {item.turns === 1 ? "turn" : "turns"}</Text>
            <Text style={styles.audSubject} numberOfLines={expanded ? undefined : 2}>{callPreview(item)}</Text>
            {expanded ? (
              <View>
                {item.transcript.map((l, i) => (
                  <View key={i} style={styles.clogLine}>
                    <Text style={styles.clogWho}>{speakerLabel(l.who)}</Text>
                    <Text style={styles.clogText}>{l.text}</Text>
                  </View>
                ))}
                <View style={styles.clogPlayRow}>
                  <Pressable testID={`call-log-play-caller-${item.call_id}`} accessibilityRole="button" onPress={() => void play(item.call_id, "caller")}>
                    <Text style={styles.audLink}>{isPlaying("caller") ? "Stop" : "Play your voice"}</Text>
                  </Pressable>
                  <Pressable testID={`call-log-play-reply-${item.call_id}`} accessibilityRole="button" onPress={() => void play(item.call_id, "reply")}>
                    <Text style={styles.audLink}>{isPlaying("reply") ? "Stop" : "Play agent voice"}</Text>
                  </Pressable>
                </View>
                {playError?.id === item.call_id ? <Text accessibilityRole="alert" style={styles.clogPlayError}>{playError.text}</Text> : null}
              </View>
            ) : null}
          </View>
        </Pressable>
      </View>
    )
  }

  return (
    <FlatList
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={[styles.audListContent, { paddingBottom: insets.bottom + 24 }]}
      data={calls}
      keyExtractor={(c) => c.call_id}
      renderItem={renderCall}
      refreshing={loading === "refresh"}
      onRefresh={() => void load("refresh")}
      onEndReachedThreshold={0.5}
      onEndReached={() => { if (next !== null && !olderError) void load("older", next) }}
      ListHeaderComponent={error ? (
        <View style={styles.audErrorBox}>
          <Text testID="call-log-error" accessibilityRole="alert" style={styles.audErrorTitle}>{error}</Text>
          {calls.length ? <Text style={styles.audMuted}>Showing the previously loaded calls.</Text> : null}
          <Pressable accessibilityRole="button" style={styles.audTap} onPress={() => void load(calls.length ? "refresh" : "initial")}>
            <Text style={styles.audLink}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
      ListEmptyComponent={loading === "initial" || !loaded ? (
        error ? null : <View style={styles.audLoading}><ActivityIndicator color={t.textMuted} /></View>
      ) : (
        <View style={styles.audEmpty}>
          <Text testID="call-log-empty" style={styles.audEmptyTitle}>No calls yet</Text>
          <Text style={styles.audMuted}>Calls with the live agent show up here with their words and voice.</Text>
        </View>
      )}
      ListFooterComponent={calls.length ? (
        <View style={styles.audFooter}>
          {olderError ? <Text testID="call-log-older-error" style={styles.audOlderError}>{olderError}</Text> : null}
          {next !== null ? (
            <Pressable testID="call-log-load-older" accessibilityRole="button" disabled={!!loading} style={styles.audTap} onPress={() => void load("older", next)}>
              <Text style={styles.audLink}>{loading === "older" ? "Loading older…" : olderError ? "Try loading older again" : "Load older"}</Text>
            </Pressable>
          ) : (
            <Text style={styles.audBeginning}>Beginning of recorded calls.</Text>
          )}
        </View>
      ) : null}
    />
  )
}
