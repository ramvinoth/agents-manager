import React, { useCallback, useEffect, useMemo, useReducer, useRef } from "react"
import { ActivityIndicator, Pressable, ScrollView, SectionList, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api } from "../api/client"
import { setToken, username } from "../state/config"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
import type { Theme } from "../lib/theme"
import { formatActor } from "../lib/board"
import { AUDIT_FILTERS, auditError, auditReducer, auditSubject, auditTime, groupAuditEntries, initialAuditState, resultTone, type AuditEntry, type AuditFilter, type AuditLoad, type AuditSection } from "../lib/audit"

type Props = NativeStackScreenProps<RootStackParamList, "Audit">

/**
 * The activity feed: who did what, to which card, grouped by day. Reads as a
 * sentence per row ("Harman moved “Ship the editor” → Review · 14:07"), with a
 * result chip only when the result is worth a glance (an approval, a denial, a
 * failure). Plain successes stay quiet so the exceptions stand out.
 */
export default function AuditScreen({ navigation }: Props) {
  const t = useTheme()
  const styles = useStyles()
  const insets = useSafeAreaInsets()
  const [state, dispatch] = useReducer(auditReducer, undefined, initialAuditState)
  const list = useRef<SectionList<AuditEntry, AuditSection>>(null)
  const request = useRef(0)
  const busy = useRef<AuditLoad | null>(null)
  const sections = useMemo(() => groupAuditEntries(state.rows), [state.rows])
  const self = username()

  const load = useCallback(async (mode: AuditLoad, filter: AuditFilter, before?: number) => {
    // Refresh/filter deliberately supersede older requests. Repeated older taps do not.
    if (mode === "older" && busy.current) return
    const current = ++request.current
    busy.current = mode
    dispatch({ type: "begin", request: current, mode, filter })
    try {
      const page = await api.orgAudit(filter, before)
      if (current !== request.current) return
      dispatch({ type: "success", request: current, page })
      if (mode === "refresh") list.current?.getScrollResponder()?.scrollTo({ y: 0, animated: false })
    } catch (error) {
      if (current !== request.current) return
      if ((error as { status?: number })?.status === 401) {
        setToken(null)
        navigation.replace("Login")
        return
      }
      dispatch({ type: "failure", request: current, error: auditError(error) })
    } finally {
      if (current === request.current) busy.current = null
    }
  }, [navigation])

  useEffect(() => {
    void load("initial", "all")
    return () => { ++request.current; busy.current = null }
  }, [load])

  const retry = () => void load(state.loaded ? "refresh" : "initial", state.filter)

  return (
    <View style={styles.page}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.audFiltersContent} style={styles.audFilters}>
        {AUDIT_FILTERS.map(filter => {
          const on = filter.value === state.filter
          return <Pressable key={filter.value} testID={`audit-filter-${filter.value}`} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={filter.label}
            onPress={() => { if (!on) void load("initial", filter.value) }}
            style={[styles.audFilter, on ? styles.audFilterOn : null]}>
            <Text style={[styles.audFilterText, on ? styles.audFilterTextOn : null]}>{filter.label}</Text>
          </Pressable>
        })}
      </ScrollView>
      <SectionList
        // Filter changes intentionally start a new window. Detail/back never remounts it.
        key={state.filter}
        testID="audit-list"
        ref={list}
        sections={sections}
        keyExtractor={item => String(item.id)}
        stickySectionHeadersEnabled
        contentContainerStyle={[styles.audListContent, { paddingBottom: Math.max(insets.bottom, 16) }]}
        refreshing={state.loading === "refresh"}
        onRefresh={() => void load("refresh", state.filter)}
        ListHeaderComponent={state.error ? <View style={styles.audErrorBox}>
          <Text testID="audit-error" accessibilityRole="alert" style={styles.audErrorTitle}>{state.error}</Text>
          {state.loaded ? <Text style={styles.audMuted}>Showing the previously loaded records.</Text> : null}
          <Pressable testID={state.loaded ? "audit-refresh-retry" : "audit-retry"} accessibilityRole="button" style={styles.audTap} onPress={retry}><Text style={styles.audLink}>Try again</Text></Pressable>
        </View> : null}
        ListEmptyComponent={state.loading ? <View style={styles.audLoading}><ActivityIndicator accessibilityLabel="Loading activity" /></View> : !state.error && state.loaded ? <View style={styles.audEmpty}>
          <Text testID="audit-empty" style={styles.audEmptyTitle}>{state.filter === "all" ? "Nothing recorded yet" : "Nothing here"}</Text>
          <Text style={[styles.audMuted, styles.textCenter]}>{state.filter === "all" ? "Every board change, approval and denial will show up here as it happens." : "No recorded actions match this filter."}</Text>
        </View> : null}
        renderSectionHeader={({ section }) => <Text accessibilityRole="header" style={styles.audSection}>{section.title}</Text>}
        renderItem={({ item }) => <AuditRow item={item} self={self} t={t} onPress={() => navigation.navigate("AuditEntry", { entry: item })} />}
        ListFooterComponent={<View style={styles.audFooter}>
          {state.olderError ? <Text testID="audit-older-error" accessibilityRole="alert" style={styles.audOlderError}>{state.olderError} Loaded records are unchanged.</Text> : null}
          {state.nextBefore !== null ? <Pressable testID="audit-load-older" accessibilityRole="button" accessibilityState={{ disabled: !!state.loading }} disabled={!!state.loading} style={styles.audTap} onPress={() => void load("older", state.filter, state.nextBefore!)}>
            <Text style={styles.audLink}>{state.loading === "older" ? "Loading older…" : state.olderError ? "Try loading older again" : "Load older"}</Text>
          </Pressable> : state.loaded && state.rows.length ? <Text style={styles.audBeginning}>Beginning of recorded history{state.filter !== "all" ? " for this filter" : ""}.</Text> : null}
        </View>}
      />
    </View>
  )
}

export function toneColors(t: Theme, tone: ReturnType<typeof resultTone>): { fg: string; bg: string } {
  if (tone === "attention") return { fg: t.accent, bg: t.chipBg }
  if (tone === "danger") return { fg: t.danger, bg: t.dangerBg }
  return { fg: t.textMuted, bg: t.chipBg }
}

/** Initial-letter avatar: humans get the accent tint, agents the neutral chip. */
export function ActorBadge({ name, kind, t, size = 30 }: { name: string; kind: ReturnType<typeof formatActor>["kind"]; t: Theme; size?: number }) {
  const styles = useStyles()
  const human = kind === "you" || kind === "human"
  return <View accessibilityElementsHidden style={[styles.audBadge, human ? styles.audBadgeHuman : null, { width: size, height: size, borderRadius: size / 2 }]}>
    <Text style={[styles.audBadgeText, human ? styles.audBadgeTextHuman : null, { fontSize: size * 0.45 }]}>{(name.trim()[0] || "?").toUpperCase()}</Text>
  </View>
}

function AuditRow({ item, self, t, onPress }: { item: AuditEntry; self: string; t: Theme; onPress: () => void }) {
  const who = formatActor(item.actor, self)
  const subject = auditSubject(item.target)
  const tone = resultTone(item.result.category)
  const chip = toneColors(t, tone)
  const styles = useStyles()
  return <Pressable
    testID={`audit-row-${item.id}`}
    accessibilityRole="button"
    accessibilityLabel={`${who.name} — ${item.action}, ${subject}. ${auditTime(item.created_at)}. ${item.result.label}`}
    accessibilityHint="Opens the recorded action details"
    onPress={onPress}
    style={({ pressed }) => [styles.audRow, pressed ? styles.audRowPressed : null]}
  >
    <ActorBadge name={who.name} kind={who.kind} t={t} />
    <View style={styles.audRowBody}>
      <View style={styles.audRowHead}>
        <Text numberOfLines={1} style={styles.audRowTitle}>
          <Text style={styles.audBold}>{who.name}</Text>
          <Text style={styles.audAction}> · {item.action}</Text>
        </Text>
        <Text style={styles.audTime}>{auditTime(item.created_at)}</Text>
      </View>
      <Text numberOfLines={2} style={styles.audSubject}>{subject}</Text>
      {tone !== "quiet" ? <View style={[styles.audChip, { backgroundColor: chip.bg }]}>
        <Text style={[styles.audChipText, { color: chip.fg }]}>{item.result.label}</Text>
      </View> : null}
    </View>
  </Pressable>
}
