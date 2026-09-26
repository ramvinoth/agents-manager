import React, { useCallback, useEffect, useMemo, useReducer, useRef } from "react"
import { ActivityIndicator, Pressable, ScrollView, SectionList, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api } from "../api/client"
import { setToken, username } from "../state/config"
import { useTheme } from "../lib/useTheme"
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
  const linkText = { color: t.accent, fontSize: 15, fontWeight: "600" as const }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10, gap: 8 }} style={{ flexGrow: 0, borderBottomWidth: 1, borderColor: t.border }}>
        {AUDIT_FILTERS.map(filter => {
          const on = filter.value === state.filter
          return <Pressable key={filter.value} testID={`audit-filter-${filter.value}`} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={filter.label}
            onPress={() => { if (!on) void load("initial", filter.value) }}
            style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, backgroundColor: on ? t.text : t.chipBg }}>
            <Text style={{ color: on ? t.bg : t.text, fontSize: 14, fontWeight: "600" }}>{filter.label}</Text>
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
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16), flexGrow: 1 }}
        refreshing={state.loading === "refresh"}
        onRefresh={() => void load("refresh", state.filter)}
        ListHeaderComponent={state.error ? <View style={{ margin: 16, padding: 14, borderRadius: 12, backgroundColor: t.dangerBg, gap: 6 }}>
          <Text testID="audit-error" accessibilityRole="alert" style={{ color: t.danger, fontSize: 15, fontWeight: "600" }}>{state.error}</Text>
          {state.loaded ? <Text style={{ color: t.textMuted, fontSize: 14 }}>Showing the previously loaded records.</Text> : null}
          <Pressable testID={state.loaded ? "audit-refresh-retry" : "audit-retry"} accessibilityRole="button" style={{ minHeight: 44, justifyContent: "center" }} onPress={retry}><Text style={linkText}>Try again</Text></Pressable>
        </View> : null}
        ListEmptyComponent={state.loading ? <View style={{ padding: 32 }}><ActivityIndicator accessibilityLabel="Loading activity" /></View> : !state.error && state.loaded ? <View style={{ padding: 32, alignItems: "center", gap: 6 }}>
          <Text testID="audit-empty" style={{ color: t.text, fontSize: 17, fontWeight: "600" }}>{state.filter === "all" ? "Nothing recorded yet" : "Nothing here"}</Text>
          <Text style={{ color: t.textMuted, fontSize: 14, textAlign: "center" }}>{state.filter === "all" ? "Every board change, approval and denial will show up here as it happens." : "No recorded actions match this filter."}</Text>
        </View> : null}
        renderSectionHeader={({ section }) => <Text accessibilityRole="header" style={{ color: t.textMuted, backgroundColor: t.bg, fontSize: 12, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase", paddingHorizontal: 16, paddingTop: 18, paddingBottom: 8 }}>{section.title}</Text>}
        renderItem={({ item }) => <AuditRow item={item} self={self} t={t} onPress={() => navigation.navigate("AuditEntry", { entry: item })} />}
        ListFooterComponent={<View style={{ paddingHorizontal: 16, paddingTop: 12, alignItems: "center" }}>
          {state.olderError ? <Text testID="audit-older-error" accessibilityRole="alert" style={{ color: t.danger, fontSize: 14, marginBottom: 6 }}>{state.olderError} Loaded records are unchanged.</Text> : null}
          {state.nextBefore !== null ? <Pressable testID="audit-load-older" accessibilityRole="button" accessibilityState={{ disabled: !!state.loading }} disabled={!!state.loading} style={{ minHeight: 44, justifyContent: "center" }} onPress={() => void load("older", state.filter, state.nextBefore!)}>
            <Text style={linkText}>{state.loading === "older" ? "Loading older…" : state.olderError ? "Try loading older again" : "Load older"}</Text>
          </Pressable> : state.loaded && state.rows.length ? <Text style={{ color: t.textMuted, fontSize: 13, paddingVertical: 16 }}>Beginning of recorded history{state.filter !== "all" ? " for this filter" : ""}.</Text> : null}
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
  const human = kind === "you" || kind === "human"
  return <View accessibilityElementsHidden style={{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center", backgroundColor: human ? t.bubbleUser : t.chipBg }}>
    <Text style={{ color: human ? t.accent : t.text, fontSize: size * 0.45, fontWeight: "700" }}>{(name.trim()[0] || "?").toUpperCase()}</Text>
  </View>
}

function AuditRow({ item, self, t, onPress }: { item: AuditEntry; self: string; t: Theme; onPress: () => void }) {
  const who = formatActor(item.actor, self)
  const subject = auditSubject(item.target)
  const tone = resultTone(item.result.category)
  const chip = toneColors(t, tone)
  return <Pressable
    testID={`audit-row-${item.id}`}
    accessibilityRole="button"
    accessibilityLabel={`${who.name} — ${item.action}, ${subject}. ${auditTime(item.created_at)}. ${item.result.label}`}
    accessibilityHint="Opens the recorded action details"
    onPress={onPress}
    style={({ pressed }) => ({ flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: pressed ? t.surface : t.bg })}
  >
    <ActorBadge name={who.name} kind={who.kind} t={t} />
    <View style={{ flex: 1, gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text numberOfLines={1} style={{ flex: 1, color: t.text, fontSize: 15 }}>
          <Text style={{ fontWeight: "700" }}>{who.name}</Text>
          <Text style={{ color: t.textMuted }}> · {item.action}</Text>
        </Text>
        <Text style={{ color: t.textMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{auditTime(item.created_at)}</Text>
      </View>
      <Text numberOfLines={2} style={{ color: t.text, fontSize: 15, lineHeight: 20 }}>{subject}</Text>
      {tone !== "quiet" ? <View style={{ alignSelf: "flex-start", marginTop: 3, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: chip.bg }}>
        <Text style={{ color: chip.fg, fontSize: 12, fontWeight: "600" }}>{item.result.label}</Text>
      </View> : null}
    </View>
  </Pressable>
}
