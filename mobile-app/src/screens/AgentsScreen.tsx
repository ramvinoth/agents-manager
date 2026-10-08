/**
 * AgentsScreen — curated agent templates with preconfigured system prompts,
 * goals, and scheduled jobs. Replaces the old Projects tab.
 *
 * Templates come from the server (/api/agent-templates), the one source of
 * truth: a template carries its plugin (role skills) and lens, which a client
 * copy could only drift from. A failed load says so, with Try again.
 *
 * Layout: compact category filter chips → SectionList grouped by category
 * with rich cards showing per-template icons, descriptions, and a start arrow.
 */
import React, { useCallback, useMemo, useState } from "react"
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  SectionList,
  Text,
  TouchableOpacity,
  View,
} from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type AgentTemplate } from "../api/client"
import { TEMPLATE_CATEGORIES } from "../lib/templateCategories"
import { userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import { useScreenHeader } from "../lib/useScreenHeader"
import Icon, { type IconName } from "../components/Icon"

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList> }

const CATEGORIES = [
  { value: "all", label: "All" },
  ...Object.entries(TEMPLATE_CATEGORIES).map(([value, c]) => ({ value, label: c.label })),
]

export default function AgentsScreen({ navigation }: Props) {
  const t = useTheme()
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null)
  const [error, setError] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const [category, setCategory] = useState("all")

  const load = useCallback((isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    api
      .agentTemplates()
      .then((r) => { setTemplates(r); setError("") })
      .catch((e) => setError(userError(e, "the agent list"))) // a list already shown stays
      .finally(() => setRefreshing(false))
  }, [])

  useScreenHeader(navigation, () => ({ title: "Agents", headerLeft: undefined, headerRight: () => null }), [])
  useFocusEffect(useCallback(() => { load() }, [load]))

  const all = templates ?? []
  const filtered = category === "all" ? all : all.filter((x) => x.category === category)

  const sections = useMemo(() => {
    const groups: Record<string, AgentTemplate[]> = {}
    for (const tmpl of filtered) {
      ;(groups[tmpl.category] ??= []).push(tmpl)
    }
    return Object.keys(TEMPLATE_CATEGORIES)
      .filter((cat) => groups[cat]?.length)
      .map((cat) => ({
        title: TEMPLATE_CATEGORIES[cat]?.label ?? cat,
        color: TEMPLATE_CATEGORIES[cat]?.color ?? t.accent,
        data: groups[cat],
      }))
  }, [filtered, t.accent])

  function pickTemplate(tmpl: AgentTemplate) {
    navigation.navigate("NewChat", { template: tmpl } as never)
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {/* Compact category filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 8, gap: 6 }}
      >
        {CATEGORIES.map((c) => {
          const active = category === c.value
          const catColor = c.value !== "all" ? TEMPLATE_CATEGORIES[c.value]?.color : t.accent
          const count = c.value === "all"
            ? all.length
            : all.filter((x) => x.category === c.value).length
          return (
            <TouchableOpacity
              key={c.value}
              testID={`agents-cat-${c.value}`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 12,
                paddingVertical: 5,
                borderRadius: 14,
                backgroundColor: active ? catColor : t.bg,
                borderWidth: 1,
                borderColor: active ? catColor : t.border,
              }}
              onPress={() => setCategory(c.value)}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: "600",
                  color: active ? t.onAccent : t.textMuted,
                }}
              >
                {c.label}
              </Text>
              {count > 0 ? (
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: "700",
                    color: active ? "rgba(255,255,255,0.8)" : t.textMuted,
                    opacity: active ? 1 : 0.5,
                  }}
                >
                  {count}
                </Text>
              ) : null}
            </TouchableOpacity>
          )
        })}
      </ScrollView>

      <SectionList
        testID="agents-list"
        sections={sections}
        keyExtractor={(item) => String(item.id)}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={error ? (
          <View testID="agents-error" style={{ margin: 12, padding: 12, borderRadius: 10, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, gap: 8 }}>
            <Text style={{ color: t.text, fontSize: 14 }}>{error}</Text>
            <TouchableOpacity testID="agents-retry" onPress={() => load()} accessibilityRole="button">
              <Text style={{ color: t.accent, fontSize: 14, fontWeight: "600" }}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        ListEmptyComponent={templates === null && !error ? (
          <View style={{ padding: 32 }}><ActivityIndicator accessibilityLabel="Loading agents" /></View>
        ) : null}
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor={t.textMuted}
          />
        }
        renderSectionHeader={({ section }) => (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 20,
              paddingTop: 18,
              paddingBottom: 4,
            }}
          >
            <View style={{ width: 3, height: 14, borderRadius: 1.5, backgroundColor: section.color }} />
            <Text
              style={{
                fontSize: 12,
                fontWeight: "700",
                color: t.textMuted,
                letterSpacing: 0.5,
                textTransform: "uppercase",
              }}
            >
              {section.title}
            </Text>
          </View>
        )}
        renderItem={({ item: tmpl }) => {
          const catColor = TEMPLATE_CATEGORIES[tmpl.category]?.color ?? t.accent
          const iconName = (tmpl.icon || "sparkle") as IconName
          return (
            <TouchableOpacity
              testID={`agent-${tmpl.id}`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                marginHorizontal: 12,
                marginTop: 6,
                paddingHorizontal: 12,
                paddingVertical: 12,
                borderRadius: 12,
                backgroundColor: t.surface,
                borderWidth: 1,
                borderColor: t.border,
              }}
              activeOpacity={0.65}
              onPress={() => pickTemplate(tmpl)}
            >
              {/* Icon */}
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: catColor + "18",
                }}
              >
                <Icon name={iconName} size={20} color={catColor} />
              </View>

              {/* Title + description + badges */}
              <View style={{ flex: 1 }}>
                <Text
                  style={{ fontSize: 14, fontWeight: "700", color: t.text }}
                  numberOfLines={1}
                >
                  {tmpl.name}
                </Text>
                {tmpl.description ? (
                  <Text
                    style={{ fontSize: 12, color: t.textMuted, marginTop: 2, lineHeight: 16 }}
                    numberOfLines={2}
                  >
                    {tmpl.description}
                  </Text>
                ) : null}
                {/* Model + schedule badges */}
                {(tmpl.model || tmpl.cron) ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
                    {tmpl.model ? (
                      <View style={{ backgroundColor: t.chipBg, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
                        <Text style={{ fontSize: 10, fontWeight: "700", color: t.textMuted, textTransform: "capitalize" }}>
                          {tmpl.model}
                        </Text>
                      </View>
                    ) : null}
                    {tmpl.cron ? (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                        <Icon name="repeat" size={10} color={t.textMuted} />
                        <Text style={{ fontSize: 10, color: t.textMuted }}>Scheduled</Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>

              <Icon name="chevronRight" size={14} color={t.border} />
            </TouchableOpacity>
          )
        }}
      />
    </View>
  )
}
