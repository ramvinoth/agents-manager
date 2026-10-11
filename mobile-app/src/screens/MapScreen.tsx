/**
 * MapScreen — a project's code as a drill-down graph (the Map lens, server:
 * viewer/codemap.py via GET /api/org/map). One level at a time: top folders →
 * a folder's files → one file's classes and functions. The Mermaid diagram is
 * a picture (no taps inside the WebView), so drilling happens in the list
 * under it; breadcrumbs climb back. Files an agent wrote in the last 15
 * minutes are highlighted (amber in the diagram), re-read every few seconds while the screen is focused.
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type MapLevel, type MapNode, type MapView } from "../api/client"
import { crumbs, drillTarget } from "../lib/codeMap"
import { userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
import MermaidView from "../components/MermaidView"
import { isDarkBg } from "../components/Markdown"
import Icon, { type IconName } from "../components/Icon"

type Props = NativeStackScreenProps<RootStackParamList, "Map">

const POLL_MS = 5000
const ICONS: Record<MapNode["kind"], IconName> = {
  folder: "folder", file: "file", class: "code", function: "code", method: "code",
}

export default function MapScreen({ navigation, route }: Props) {
  const t = useTheme()
  const styles = useStyles()
  const { project, session, title } = route.params
  const [at, setAt] = useState<{ level: MapLevel; path: string }>({ level: "project", path: "" })
  const [view, setView] = useState<MapView | null>(null)
  const [error, setError] = useState("")
  const request = useRef(0)

  useEffect(() => { navigation.setOptions({ title: `Map · ${title}` }) }, [navigation, title])

  const load = useCallback(async () => {
    const current = ++request.current
    try {
      const v = await api.orgMap({ project, session }, at.level, at.path)
      if (current !== request.current) return
      setView(v); setError("")
    } catch (e) {
      if (current === request.current) setError(userError(e, "the code map"))
    }
  }, [project, session, at])

  // Re-read while focused so an agent's edits light up; a level change
  // clears the old picture so it never pretends to be the new level.
  useFocusEffect(useCallback(() => {
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load]))
  useEffect(() => { setView(null) }, [at])

  const trail = crumbs(at, title)
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.mapContent}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.mapCrumbs}>
        {trail.map((c, i) => {
          const last = i === trail.length - 1
          return (
            <View key={c.level + c.path} style={styles.mapCrumb}>
              {i > 0 ? <Icon name="chevronRight" size={12} color={t.textMuted} /> : null}
              <Pressable
                testID={`map-crumb-${i}`}
                disabled={last}
                accessibilityRole="button"
                onPress={() => setAt({ level: c.level, path: c.path })}
                style={styles.mapCrumbBtn}
              >
                <Text style={[styles.mapCrumbText, last ? styles.mapCrumbTextLast : null]}>{c.label}</Text>
              </Pressable>
            </View>
          )
        })}
      </ScrollView>

      {error ? (
        <View testID="map-error" style={styles.mapErrorBox}>
          <Text style={styles.mapBody}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={() => void load()}>
            <Text style={styles.mapLink}>Try again</Text>
          </Pressable>
        </View>
      ) : !view ? (
        <View style={styles.mapLoading}>
          <ActivityIndicator accessibilityLabel="Reading the code" />
          <Text style={styles.mapHint}>Reading the code… a big project's first map takes a few seconds.</Text>
        </View>
      ) : !view.available ? (
        <View testID="map-install" style={styles.mapInstall}>
          <Text style={styles.mapInstallTitle}>The code map isn't installed on the server.</Text>
          <Text style={styles.mapHint}>Install it once on the machine running Harman, then reopen the map:</Text>
          <Text selectable style={styles.mapCode}>{view.install}</Text>
        </View>
      ) : (
        <>
          <Text style={styles.mapMeta}>
            {view.files} files mapped{view.truncated ? " · showing the most connected" : ""} · highlighted = an agent wrote it in the last 15 min
          </Text>
          {view.nodes.length ? (
            <MermaidView source={view.mermaid} dark={isDarkBg(t.bg)} textColor={t.text} />
          ) : (
            <Text style={styles.emptyItalic}>No source files here the map can read.</Text>
          )}
          <View style={styles.mapList}>
            {view.nodes.map((n, i) => {
              const next = drillTarget(n)
              const here = view.level === "file" && n.id === view.path
              return (
                <Pressable
                  key={n.id}
                  testID={`map-node-${i}`}
                  disabled={!next || here}
                  accessibilityRole={next && !here ? "button" : undefined}
                  accessibilityLabel={`${n.label}${n.touched ? ", an agent edited this" : ""}`}
                  onPress={() => next && setAt(next)}
                  style={[styles.mapRow, i ? styles.mapRowDivided : null, n.touched ? styles.mapRowTouched : null]}
                >
                  <Icon name={ICONS[n.kind]} size={16} color={t.textMuted} />
                  <Text style={[styles.mapBody, styles.flex1]} numberOfLines={1}>{n.label}</Text>
                  <Text style={styles.mapMeta}>
                    {n.kind === "folder" ? n.files : n.line ? `:${n.line}` : n.symbols || ""}
                  </Text>
                  {n.touched ? <View style={styles.mapDot} /> : null}
                  {next && !here ? <Icon name="chevronRight" size={14} color={t.textMuted} /> : null}
                </Pressable>
              )
            })}
          </View>
        </>
      )}
    </ScrollView>
  )
}
