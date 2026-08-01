import React, { useEffect, useState } from "react"
import { ActivityIndicator, ScrollView, Text, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type SessionSummary } from "../api/client"
import { compactNumber, durationBetween, shortModel, topTools } from "../lib/stats"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "SessionInfo">

/** Read-only stats for a session: volume, token spend, tool mix, models used. */
export default function SessionInfoScreen({ route }: Props) {
  const styles = useStyles()
  const { host, path } = route.params
  const [s, setS] = useState<SessionSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const t = useTheme()

  useEffect(() => {
    api
      .sessionSummary(host, path)
      .then(setS)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [host, path])

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: t.bg }]}>
        <ActivityIndicator />
      </View>
    )
  }
  if (error || !s) {
    return (
      <View style={[styles.center, { backgroundColor: t.bg, padding: 24 }]}>
        <Text style={[styles.error, { color: t.danger }]}>{error || "No summary available."}</Text>
      </View>
    )
  }

  const tools = topTools(s.tools)
  const maxTool = tools.length ? tools[0].count : 1
  const dur = durationBetween(s.startTime, s.endTime)

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 16 }}>
      <View style={styles.statGrid}>
        <Stat label="Messages" value={compactNumber(s.userMessages + s.assistantMessages)} t={t} />
        <Stat label="You" value={compactNumber(s.userMessages)} t={t} />
        <Stat label="Agent" value={compactNumber(s.assistantMessages)} t={t} />
        <Stat label="Tokens in" value={compactNumber(s.totalInput)} t={t} />
        <Stat label="Tokens out" value={compactNumber(s.totalOutput)} t={t} />
        {dur ? <Stat label="Duration" value={dur} t={t} /> : null}
      </View>

      {s.cwd ? (
        <>
          <Text style={[styles.drawerSection, { color: t.textMuted }]}>WORKING DIRECTORY</Text>
          <Text style={[styles.statPath, { color: t.text }]}>{s.cwd}</Text>
        </>
      ) : null}

      {s.models?.length ? (
        <>
          <Text style={[styles.drawerSection, { color: t.textMuted }]}>MODELS</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 16 }}>
            {s.models.map((m) => (
              <View key={m} style={[styles.pill, { backgroundColor: t.chipBg, marginLeft: 0 }]}>
                <Text style={[styles.pillText, { color: t.text }]}>{shortModel(m)}</Text>
              </View>
            ))}
          </View>
        </>
      ) : null}

      {tools.length ? (
        <>
          <Text style={[styles.drawerSection, { color: t.textMuted }]}>TOOL USE</Text>
          <View style={{ paddingHorizontal: 16 }}>
            {tools.map((tool) => (
              <View key={tool.name} style={styles.toolBarRow}>
                <Text style={[styles.toolBarName, { color: t.text }]} numberOfLines={1}>
                  {tool.name}
                </Text>
                {/* Width is proportional to the most-used tool, so the mix reads at a glance. */}
                <View style={[styles.toolBarTrack, { backgroundColor: t.chipBg }]}>
                  <View style={[styles.toolBarFill, { width: `${Math.max(4, (tool.count / maxTool) * 100)}%` }]} />
                </View>
                <Text style={[styles.toolBarCount, { color: t.textMuted }]}>{tool.count}</Text>
              </View>
            ))}
          </View>
        </>
      ) : null}

      <View style={{ height: 40 }} />
    </ScrollView>
  )
}

function Stat({ label, value, t }: { label: string; value: string; t: { text: string; textMuted: string; chipBg: string } }) {
  const styles = useStyles()
  return (
    <View style={[styles.statCard, { backgroundColor: t.chipBg }]}>
      <Text style={[styles.statValue, { color: t.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: t.textMuted }]}>{label}</Text>
    </View>
  )
}
