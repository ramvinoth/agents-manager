import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { ActivityIndicator, Pressable, SectionList, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api } from "../api/client"
import { setToken } from "../state/config"
import { useTheme } from "../lib/useTheme"
import { AUDIT_FILTERS, auditError, auditReducer, auditTime, groupAuditEntries, initialAuditState, type AuditEntry, type AuditFilter, type AuditLoad, type AuditSection } from "../lib/audit"

type Props = NativeStackScreenProps<RootStackParamList, "Audit">

export default function AuditScreen({ navigation }: Props) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const [state, dispatch] = useReducer(auditReducer, undefined, initialAuditState)
  const [filterOpen, setFilterOpen] = useState(false)
  const list = useRef<SectionList<AuditEntry, AuditSection>>(null)
  const request = useRef(0)
  const busy = useRef<AuditLoad | null>(null)
  const sections = useMemo(() => groupAuditEntries(state.rows), [state.rows])
  const selection = AUDIT_FILTERS.find(f => f.value === state.filter)!.label

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

  const buttonStyle = { minHeight: 44, paddingVertical: 12, paddingHorizontal: 16, justifyContent: "center" as const }
  const buttonText = { color: t.text, fontSize: 16, fontWeight: "600" as const }
  const retry = () => void load(state.loaded ? "refresh" : "initial", state.filter)

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, borderBottomWidth: 1, borderColor: t.border }}>
        <Text style={{ color: t.text, fontSize: 16, marginBottom: 8 }}>Recorded control actions</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
          <Pressable testID="audit-result-filter" accessibilityRole="button" accessibilityLabel={`Result: ${selection}`} accessibilityState={{ expanded: filterOpen }} onPress={() => { setFilterOpen(v => !v); if (!filterOpen) list.current?.getScrollResponder()?.scrollTo({ y: 0, animated: false }) }} style={[buttonStyle, { flexShrink: 1, paddingLeft: 0 }]}>
            <Text style={buttonText}>Result: {selection}</Text>
          </Pressable>
          {state.filter !== "all" ? <Pressable testID="audit-filter-reset" accessibilityRole="button" accessibilityLabel="Reset result filter" style={buttonStyle} onPress={() => { setFilterOpen(false); void load("initial", "all") }}><Text style={buttonText}>Reset</Text></Pressable> : null}
        </View>
      </View>
      <SectionList
        // Filter changes intentionally start a new window. Detail/back never remounts it.
        key={state.filter}
        testID="audit-list"
        ref={list}
        sections={sections}
        keyExtractor={item => String(item.id)}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16), flexGrow: 1 }}
        refreshing={state.loading === "refresh"}
        onRefresh={() => void load("refresh", state.filter)}
        ListHeaderComponent={<>
          {filterOpen ? <View style={{ paddingHorizontal: 16, borderBottomWidth: 1, borderColor: t.border }}>
            {AUDIT_FILTERS.map(filter => <Pressable key={filter.value} testID={`audit-filter-${filter.value}`} accessibilityRole="radio" accessibilityState={{ checked: filter.value === state.filter }} accessibilityLabel={filter.label} style={buttonStyle} onPress={() => {
              setFilterOpen(false)
              if (filter.value !== state.filter) void load("initial", filter.value)
            }}><Text style={{ color: t.text, fontSize: 16, fontWeight: filter.value === state.filter ? "700" : "400" }}>{filter.label}{filter.value === state.filter ? " (selected)" : ""}</Text></Pressable>)}
          </View> : null}
          {state.error ? <View style={{ padding: 16 }}>
            <Text testID="audit-error" accessibilityRole="alert" style={{ color: t.text, fontSize: 16 }}>{state.error}</Text>
            {state.loaded ? <Text style={{ color: t.text, fontSize: 14, marginTop: 8 }}>Showing the previously loaded records.</Text> : null}
            <Pressable testID={state.loaded ? "audit-refresh-retry" : "audit-retry"} accessibilityRole="button" style={buttonStyle} onPress={retry}><Text style={buttonText}>Try again</Text></Pressable>
          </View> : null}
        </>}
        ListEmptyComponent={state.loading ? <View style={{ padding: 32 }}><ActivityIndicator accessibilityLabel="Loading audit log" /></View> : !state.error && state.loaded ? <View style={{ padding: 24 }}><Text testID="audit-empty" style={{ color: t.text, fontSize: 16 }}>{state.filter === "all" ? "No recorded actions yet." : "No recorded actions match this result."}</Text></View> : null}
        renderSectionHeader={({ section }) => <Text accessibilityRole="header" style={{ color: t.text, backgroundColor: t.bg, fontSize: 14, fontWeight: "600", paddingHorizontal: 16, paddingTop: 24, paddingBottom: 8 }}>{section.title}</Text>}
        renderItem={({ item }) => <Pressable
          testID={`audit-row-${item.id}`}
          accessibilityRole="button"
          accessibilityLabel={`${item.action}. ${item.target.label}. Actor: ${item.actor}. ${auditTime(item.created_at)}. ${item.result.label}`}
          accessibilityHint="Opens the recorded action details"
          onPress={() => navigation.navigate("AuditEntry", { entry: item })}
          style={({ pressed }) => ({ minHeight: 44, padding: 16, borderBottomWidth: 1, borderColor: t.border, backgroundColor: pressed ? t.surface : t.bg, gap: 5 })}
        >
          <Text style={{ color: t.text, fontSize: 18, fontWeight: "600" }}>{item.action}</Text>
          <Text style={{ color: t.text, fontSize: 16 }}>{item.target.label}</Text>
          <Text style={{ color: t.text, fontSize: 14 }}>Actor: {item.actor}</Text>
          <Text style={{ color: t.text, fontSize: 14 }}>{auditTime(item.created_at)}</Text>
          <Text style={{ color: t.text, fontSize: 14, fontWeight: "500" }}>{item.result.label}</Text>
        </Pressable>}
        ListFooterComponent={<View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          {state.olderError ? <Text testID="audit-older-error" accessibilityRole="alert" style={{ color: t.text, fontSize: 16 }}>{state.olderError} Loaded records are unchanged.</Text> : null}
          {state.nextBefore !== null ? <Pressable testID="audit-load-older" accessibilityRole="button" accessibilityState={{ disabled: !!state.loading }} disabled={!!state.loading} style={buttonStyle} onPress={() => void load("older", state.filter, state.nextBefore!)}>
            <Text style={buttonText}>{state.loading === "older" ? "Loading older…" : state.olderError ? "Try loading older again" : "Load older"}</Text>
          </Pressable> : state.loaded && state.rows.length ? <Text style={{ color: t.text, fontSize: 14, paddingVertical: 16 }}>End of recorded history{state.filter !== "all" ? " for this result" : ""}.</Text> : null}
        </View>}
      />
    </View>
  )
}
