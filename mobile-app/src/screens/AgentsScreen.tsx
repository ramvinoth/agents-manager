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
 * "+" makes a personal agent (only its owner sees it); long-press a card to
 * edit or delete your own, or duplicate any agent — a built-in is never edited.
 */
import React, { useCallback, useMemo, useState } from "react"
import {
  ActivityIndicator,
  Alert,
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
import { LEVEL_NAME } from "../lib/harmanLevel"
import { TEMPLATE_CATEGORIES } from "../lib/templateCategories"
import { userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
import { useScreenHeader } from "../lib/useScreenHeader"
import { showActions } from "../lib/actionSheet"
import HeaderButton from "../components/HeaderButton"
import Icon, { type IconName } from "../components/Icon"

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList> }

const CATEGORIES = [
  { value: "all", label: "All" },
  ...Object.entries(TEMPLATE_CATEGORIES).map(([value, c]) => ({ value, label: c.label })),
]

export default function AgentsScreen({ navigation }: Props) {
  const t = useTheme()
  const styles = useStyles()
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

  useScreenHeader(navigation, () => ({
    title: "Agents", headerLeft: undefined,
    headerRight: () => (
      <HeaderButton testID="agents-new" label="New agent" icon="add" size={24} color={t.accent} style={{ marginRight: 4 }}
        onPress={() => navigation.navigate("AgentEdit")} />
    ),
  }), [t])
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

  async function duplicate(tmpl: AgentTemplate) {
    try {
      const { template } = await api.agentTemplateDuplicate(tmpl.id)
      load()
      navigation.navigate("AgentEdit", { template })
    } catch (e) {
      Alert.alert("Couldn't duplicate", userError(e, tmpl.name, "duplicate"))
    }
  }

  function confirmDelete(tmpl: AgentTemplate) {
    Alert.alert(`Delete ${tmpl.name}?`, "Chats already started from it keep running; new chats can't start from it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => {
        api.agentTemplateDelete(tmpl.id).then(() => load()).catch((e) => Alert.alert("Couldn't delete", userError(e, tmpl.name, "delete")))
      } },
    ])
  }

  function agentActions(tmpl: AgentTemplate) {
    showActions(tmpl.name, [
      ...(tmpl.editable ? [{ text: "Edit", onPress: () => navigation.navigate("AgentEdit", { template: tmpl }) }] : []),
      { text: "Duplicate", onPress: () => duplicate(tmpl) },
      ...(tmpl.editable ? [{ text: "Delete", destructive: true, onPress: () => confirmDelete(tmpl) }] : []),
    ])
  }

  return (
    <View style={styles.page}>
      {/* Compact category filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.agCats}
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
              style={[styles.agCat, active ? { backgroundColor: catColor, borderColor: catColor } : null]}
              onPress={() => setCategory(c.value)}
            >
              <Text style={[styles.agCatText, active ? styles.agCatTextActive : null]}>{c.label}</Text>
              {count > 0 ? (
                <Text style={[styles.agCatCount, active ? styles.agCatCountActive : null]}>{count}</Text>
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
          <View testID="agents-error" style={styles.mapErrorBox}>
            <Text style={styles.mapBody}>{error}</Text>
            <TouchableOpacity testID="agents-retry" onPress={() => load()} accessibilityRole="button">
              <Text style={styles.mapLink}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        ListEmptyComponent={templates === null && !error ? (
          <View style={styles.audLoading}><ActivityIndicator accessibilityLabel="Loading agents" /></View>
        ) : null}
        contentContainerStyle={styles.calListContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor={t.textMuted}
          />
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.agSection}>
            <View style={[styles.agSectionBar, { backgroundColor: section.color }]} />
            <Text style={styles.agSectionTitle}>{section.title}</Text>
          </View>
        )}
        renderItem={({ item: tmpl }) => {
          const catColor = TEMPLATE_CATEGORIES[tmpl.category]?.color ?? t.accent
          const iconName = (tmpl.icon || "sparkle") as IconName
          return (
            <TouchableOpacity
              testID={`agent-${tmpl.id}`}
              style={styles.agCard}
              activeOpacity={0.65}
              onPress={() => pickTemplate(tmpl)}
              onLongPress={() => agentActions(tmpl)}
              accessibilityHint="Long-press for edit, duplicate and delete"
            >
              {/* Icon */}
              <View style={[styles.agIcon, { backgroundColor: catColor + "18" }]}>
                <Icon name={iconName} size={20} color={catColor} />
              </View>

              {/* Title + description + badges */}
              <View style={styles.flex1}>
                <Text
                  style={styles.agName}
                  numberOfLines={1}
                >
                  {tmpl.name}
                </Text>
                {tmpl.description ? (
                  <Text
                    style={styles.agDesc}
                    numberOfLines={2}
                  >
                    {tmpl.description}
                  </Text>
                ) : null}
                {/* Level + model + schedule badges. The level is what a chat
                    started from this agent may do on the board ("from the agent
                    it was started from" in the chat's Trust settings). */}
                {(tmpl.owner_user_id != null || tmpl.level || tmpl.model || tmpl.jobs?.length) ? (
                  <View style={styles.agBadges}>
                    {tmpl.owner_user_id != null ? (
                      <View testID={`agent-yours-${tmpl.id}`} style={[styles.agBadge, { backgroundColor: t.accent + "22" }]}>
                        <Text style={[styles.agBadgeText, { color: t.accent }]}>Yours</Text>
                      </View>
                    ) : null}
                    {tmpl.level ? (
                      <View testID={`agent-level-${tmpl.id}`} style={styles.agBadge}>
                        <Text style={styles.agBadgeText}>
                          {LEVEL_NAME[tmpl.level]}
                        </Text>
                      </View>
                    ) : null}
                    {tmpl.model ? (
                      <View style={styles.agBadge}>
                        <Text style={[styles.agBadgeText, styles.agCapitalize]}>
                          {tmpl.model}
                        </Text>
                      </View>
                    ) : null}
                    {tmpl.jobs?.length ? (
                      <View style={styles.agJobs}>
                        <Icon name="repeat" size={10} color={t.textMuted} />
                        <Text style={styles.agJobsText}>
                          {tmpl.jobs.length === 1 ? "1 scheduled job" : `${tmpl.jobs.length} scheduled jobs`}
                        </Text>
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
