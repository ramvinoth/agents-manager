import React, { useCallback, useEffect, useState } from "react"
import { View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { currentHost } from "../state/config"
import { useTheme } from "../lib/useTheme"
import CapabilitiesPanel from "../components/CapabilitiesPanel"

type Props = NativeStackScreenProps<RootStackParamList, "Capabilities">

/**
 * Skills + MCP tools, full screen — the side menu's "Skills & tools" and a
 * session profile's scoped entry. The list itself is CapabilitiesPanel, shared
 * with the thread's drawer.
 */
export default function CapabilitiesScreen({ route, navigation }: Props) {
  const t = useTheme()
  // A session passes its host + cwd (project scope); the menu entry passes
  // nothing → this host, user/global scope.
  const host = route.params?.host || currentHost()
  const cwd = route.params?.cwd
  const scopeTitle = route.params?.title
  useEffect(() => {
    if (scopeTitle) navigation.setOptions({ title: `${scopeTitle} · Skills & tools` })
  }, [scopeTitle])

  // Reload on every focus: a skill saved elsewhere shows when you come back.
  const [focused, setFocused] = useState(false)
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false) }, []))

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <CapabilitiesPanel host={host} cwd={cwd} active={focused} testPrefix="cap" />
    </View>
  )
}
