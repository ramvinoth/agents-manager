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
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 12, gap: 12, paddingBottom: 40 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: "center", gap: 4 }}>
        {trail.map((c, i) => {
          const last = i === trail.length - 1
          return (
            <View key={c.level + c.path} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              {i > 0 ? <Icon name="chevronRight" size={12} color={t.textMuted} /> : null}
              <Pressable
                testID={`map-crumb-${i}`}
                disabled={last}
                accessibilityRole="button"
                onPress={() => setAt({ level: c.level, path: c.path })}
                style={{ paddingVertical: 6, paddingHorizontal: 4, minHeight: 32, justifyContent: "center" }}
              >
                <Text style={{ color: last ? t.text : t.accent, fontWeight: "600", fontSize: 14 }}>{c.label}</Text>
              </Pressable>
            </View>
          )
        })}
      </ScrollView>

      {error ? (
        <View testID="map-error" style={{ padding: 12, borderRadius: 10, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, gap: 8 }}>
          <Text style={{ color: t.text, fontSize: 14 }}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={() => void load()}>
            <Text style={{ color: t.accent, fontWeight: "600", fontSize: 14 }}>Try again</Text>
          </Pressable>
        </View>
      ) : !view ? (
        <View style={{ padding: 32, alignItems: "center", gap: 8 }}>
          <ActivityIndicator accessibilityLabel="Reading the code" />
          <Text style={{ color: t.textMuted, fontSize: 13 }}>Reading the code… a big project's first map takes a few seconds.</Text>
        </View>
      ) : !view.available ? (
        <View testID="map-install" style={{ padding: 12, gap: 6 }}>
          <Text style={{ color: t.text, fontWeight: "600", fontSize: 15 }}>The code map isn't installed on the server.</Text>
          <Text style={{ color: t.textMuted, fontSize: 13 }}>Install it once on the machine running Harman, then reopen the map:</Text>
          <Text selectable style={{ color: t.codeText, backgroundColor: t.codeBg, padding: 8, borderRadius: 6, fontSize: 12 }}>{view.install}</Text>
        </View>
      ) : (
        <>
          <Text style={{ color: t.textMuted, fontSize: 12 }}>
            {view.files} files mapped{view.truncated ? " · showing the most connected" : ""} · highlighted = an agent wrote it in the last 15 min
          </Text>
          {view.nodes.length ? (
            <MermaidView source={view.mermaid} dark={isDarkBg(t.bg)} textColor={t.text} />
          ) : (
            <Text style={{ color: t.textMuted, fontStyle: "italic" }}>No source files here the map can read.</Text>
          )}
          <View style={{ borderRadius: 10, borderWidth: 1, borderColor: t.border, overflow: "hidden" }}>
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
                  style={{
                    flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 12,
                    borderTopWidth: i ? 1 : 0, borderColor: t.border,
                    backgroundColor: n.touched ? t.attentionBg : t.surface,
                  }}
                >
                  <Icon name={ICONS[n.kind]} size={16} color={t.textMuted} />
                  <Text style={{ flex: 1, color: t.text, fontSize: 14 }} numberOfLines={1}>{n.label}</Text>
                  <Text style={{ color: t.textMuted, fontSize: 12 }}>
                    {n.kind === "folder" ? n.files : n.line ? `:${n.line}` : n.symbols || ""}
                  </Text>
                  {n.touched ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.warning }} /> : null}
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
