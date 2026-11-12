/**
 * CallScreen — a WhatsApp-style voice CALL with Manager.
 *
 * A pure view of the live call owned by CallProvider (src/lib/CallProvider.tsx),
 * which runs the CallKit lifecycle and the listen / think / speak loop above the
 * navigator. Minimize (chevron) leaves the screen WITHOUT hanging up so the rest
 * of the app stays usable; End hangs up and the screen closes itself.
 */
import React, { useEffect, useRef } from "react"
import { Text, View } from "react-native"
import { Pressable } from "../components/Tracked"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { useCall } from "../lib/CallProvider"
import { fmtElapsed } from "../lib/callSession"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"
import { useStyles } from "../lib/styles"

type Props = NativeStackScreenProps<RootStackParamList, "Call">

export default function CallScreen({ route, navigation }: Props) {
  const { path, label: requested } = route.params
  const styles = useStyles()
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { active, label: liveLabel, phase, model, heard, reply, error, muted, elapsed, join, hangUp, toggleMute } = useCall()
  const wasActive = useRef(false)

  // Opening the screen joins the live call, or starts one if none is running.
  useEffect(() => { join(requested, path) }, [join, requested, path])
  const label = liveLabel || requested

  // The call ended (End, CallKit, spoken) -> leave the screen. Minimizing never ends it.
  useEffect(() => {
    if (active) wasActive.current = true
    else if (wasActive.current && navigation.canGoBack()) navigation.goBack()
  }, [active, navigation])

  const statusLine =
    phase === "denied" ? "Microphone access denied"
    : phase === "connecting" ? "Connecting…"
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
      <Pressable
        testID="call-minimize"
        accessibilityLabel="Minimize call"
        onPress={() => navigation.goBack()}
        style={[styles.callMinimize, { top: insets.top + 8 }]}
      >
        <Icon name="chevronDown" size={28} color={t.text} />
      </Pressable>
      {/* Caller identity + live status. */}
      <View style={styles.callIdentity}>
        <View style={styles.callAvatar}>
          <Icon name="sparkle" size={48} color={t.accent} />
        </View>
        <Text style={styles.callName}>Manager</Text>
        <Text style={styles.callLabel} numberOfLines={1}>{label}</Text>
        {/* The server's own name for the model answering, once it has told us. */}
        {model !== null ? (
          <Text style={styles.callCaption} numberOfLines={1}>{`Brain: ${model || "call brain"}`}</Text>
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
