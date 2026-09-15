import React, { useCallback, useEffect, useState } from "react"
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Capabilities, type McpServer, type Skill } from "../api/client"
import { currentHost } from "../state/config"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"
import { SkillEditor, McpEditor } from "../components/CapabilitiesEditors"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "Capabilities">

/**
 * Skills + MCP tools manager — the mobile counterpart of the web RhsPanel
 * Capabilities tab. Lists both from /api/capabilities (host- and project-aware)
 * and offers add / edit / delete for each, mirroring the server CRUD the web UI
 * already uses (skill save/delete, mcp save/delete).
 */
export default function CapabilitiesScreen({ route, navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()
  // Scope: a session passes its host + working dir (project-scoped skills/MCP);
  // the global entry (Profile → Capabilities) passes nothing → the host default,
  // cwd undefined, which the server reads as the user/global scope.
  const host = route.params?.host || currentHost()
  const cwd = route.params?.cwd

  // When opened for a specific session, title the header with its name so it's
  // clear WHICH scope you're editing (vs the global "Skills & tools").
  const scopeTitle = route.params?.title
  useEffect(() => {
    if (scopeTitle) navigation.setOptions({ title: `${scopeTitle} · Skills & tools` })
  }, [scopeTitle])

  const [tab, setTab] = useState<"skills" | "mcp">("skills")
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [loading, setLoading] = useState(true)
  const [skillEdit, setSkillEdit] = useState<Skill | null | undefined>(undefined)
  const [mcpEdit, setMcpEdit] = useState<McpServer | null | undefined>(undefined)

  const load = useCallback(() => {
    setLoading(true)
    api
      .capabilities(host, cwd)
      .then(setCaps)
      .catch(() => setCaps({ skills: [], mcp: [] }))
      .finally(() => setLoading(false))
  }, [host, cwd])

  useFocusEffect(useCallback(() => load(), [load]))

  const skillCount = caps?.skills.length ?? 0
  const mcpCount = caps?.mcp.length ?? 0

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {/* Skills / MCP tab switch with counts. */}
      <View style={styles.segRow}>
        {([["skills", "Skills", skillCount], ["mcp", "MCP tools", mcpCount]] as const).map(([v, label, count]) => {
          const active = tab === v
          return (
            <TouchableOpacity
              key={v}
              testID={`cap-tab-${v}`}
              style={[styles.seg, active ? styles.segActive : null]}
              onPress={() => setTab(v as "skills" | "mcp")}
            >
              <Text style={[styles.segText, active ? styles.segTextActive : null]}>
                {label}
              </Text>
              {!loading && count > 0 ? (
                <Text style={[styles.segText, active ? styles.segTextActive : null, styles.capTabCount]}>
                  {count}
                </Text>
              ) : null}
            </TouchableOpacity>
          )
        })}
      </View>

      {loading ? (
        <ActivityIndicator size="small" color={t.textMuted} style={{ marginTop: 24 }} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 40, paddingTop: 4 }}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          {tab === "skills" ? (
            <>
              <TouchableOpacity testID="cap-add-skill" style={styles.capAddRow} onPress={() => setSkillEdit(null)}>
                <Icon name="add" size={16} color={t.accent} />
                <Text style={[styles.capAddText, { color: t.accent }]}>New skill</Text>
              </TouchableOpacity>
              {skillCount ? (
                caps!.skills.map((s) => (
                  <TouchableOpacity key={s.path} testID={`cap-skill-${s.name}`} style={styles.capRow} onPress={() => setSkillEdit(s)}>
                    <View style={[styles.capRowIcon, { backgroundColor: t.accent + "18" }]}>
                      <Icon name="sparkle" size={16} color={t.accent} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>
                        /{s.name}
                      </Text>
                      {s.description ? (
                        <Text style={[styles.capRowDesc, { color: t.textMuted }]} numberOfLines={2}>
                          {s.description}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={[styles.capBadge, { color: t.textMuted, borderColor: t.border }]}>{s.source}</Text>
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={styles.capEmpty}>No skills found.</Text>
              )}
            </>
          ) : (
            <>
              <TouchableOpacity testID="cap-add-mcp" style={styles.capAddRow} onPress={() => setMcpEdit(null)}>
                <Icon name="add" size={16} color={t.accent} />
                <Text style={[styles.capAddText, { color: t.accent }]}>Add MCP server</Text>
              </TouchableOpacity>
              {mcpCount ? (
                caps!.mcp.map((m) => (
                  <TouchableOpacity key={`${m.scope}:${m.name}`} testID={`cap-mcp-${m.name}`} style={styles.capRow} onPress={() => setMcpEdit(m)}>
                    <View style={[styles.capRowIcon, { backgroundColor: t.textMuted + "18" }]}>
                      <Icon name="tool" size={16} color={t.textMuted} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>
                        {m.name}
                      </Text>
                      <Text style={[styles.capRowDesc, { color: t.textMuted }]} numberOfLines={1}>
                        {m.transport}
                        {m.target ? ` · ${m.target}` : ""}
                      </Text>
                    </View>
                    <Text style={[styles.capBadge, { color: t.textMuted, borderColor: t.border }]}>{m.scope}</Text>
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={styles.capEmpty}>No MCP servers configured.</Text>
              )}
            </>
          )}
        </ScrollView>
      )}

      {skillEdit !== undefined && (
        <SkillEditor skill={skillEdit} host={host} cwd={cwd} onClose={() => setSkillEdit(undefined)} onSaved={load} />
      )}
      {mcpEdit !== undefined && (
        <McpEditor server={mcpEdit} host={host} cwd={cwd} onClose={() => setMcpEdit(undefined)} onSaved={load} />
      )}
    </View>
  )
}
