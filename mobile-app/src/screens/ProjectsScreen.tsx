import React, { useCallback, useEffect, useState } from "react"
import { FlatList, Text, TouchableOpacity, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api } from "../api/client"
import {
  activeProject,
  currentHost,
  setActiveProject,
  setKnownProjects,
  subscribeChatFilter,
} from "../state/config"
import { useTheme } from "../lib/useTheme"
import { HostHeaderButton } from "../components/HostPicker"
import Icon from "../components/Icon"
import { useStyles } from "./styles"

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList> }

function shortProject(p: string): string {
  const parts = p.split("/").filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

/**
 * Projects tab: filter the Chats list by project, scoped to the current host.
 * Derives its list from the SAME session `.project` values Chats filters on
 * (fetched via api.sessions), so a picked project always matches — the
 * /api/projects `cwd` format differs from a session's decoded `project` path
 * and never matched, which showed "no chats". Re-scopes when the host changes.
 * "All chats" clears the filter. Picking one jumps back to Chats.
 */
export default function ProjectsScreen({ navigation }: Props) {
  const [host, setHost] = useState(currentHost())
  const [projects, setProjects] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(activeProject())
  const styles = useStyles()
  const t = useTheme()

  const load = useCallback(async (h: string) => {
    try {
      const sessions = await api.sessions(h)
      const set = new Set<string>()
      for (const s of sessions) if (s.project) set.add(s.project)
      const list = Array.from(set).sort()
      setProjects(list)
      setKnownProjects(list) // publish so Chats sees the same options
    } catch {
      setProjects([])
    }
  }, [])

  useEffect(() => {
    load(host)
  }, [host, load])

  useEffect(() => {
    return subscribeChatFilter(() => {
      setHost((prev) => {
        const h = currentHost()
        return prev === h ? prev : h
      })
      setActive(activeProject())
    })
  }, [])

  // On focus, own the shared header: host picker on the left, and explicitly
  // CLEAR headerRight (Projects has no top-right action) so a sibling tab's
  // icon — e.g. Files' upload — doesn't linger here.
  useFocusEffect(
    useCallback(() => {
      navigation.setOptions({
        title: "Projects",
        headerLeft: () => <HostHeaderButton navigation={navigation} />,
        headerRight: () => null,
      })
    }, [navigation])
  )

  function pick(p: string | null) {
    setActiveProject(p)
    setActive(p)
    navigation.navigate("Home", { screen: "Chats" } as never)
  }

  const rows: (string | null)[] = [null, ...projects]

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <FlatList
        testID="projects-list"
        data={rows}
        keyExtractor={(p) => p ?? "__all__"}
        ListEmptyComponent={<Text style={[styles.hint, { padding: 16 }]}>No projects on this host.</Text>}
        renderItem={({ item: p }) => {
          const on = active === p
          return (
            <TouchableOpacity
              testID={`project-pick-${p ? shortProject(p) : "all"}`}
              style={[styles.projectRow, { borderBottomColor: t.border }]}
              onPress={() => pick(p)}
            >
              <Icon name={p ? "folder" : "menu"} size={18} color={t.textMuted} />
              <Text style={[styles.projectName, { color: on ? t.text : t.textMuted }]} numberOfLines={1}>
                {p ? shortProject(p) : "All chats"}
              </Text>
              {on ? <Icon name="check" size={16} color={t.accent} /> : null}
            </TouchableOpacity>
          )
        }}
      />
    </View>
  )
}
