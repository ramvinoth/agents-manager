import React, { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, FlatList, Modal, ScrollView, Text, TouchableOpacity, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type McpServer, type Skill } from "../api/client"
import { McpEditor, SkillEditor } from "../components/CapabilitiesEditors"
import MarketplaceSheet from "../components/MarketplaceSheet"
import Icon from "../components/Icon"
import { pickable } from "../lib/agentEdit"
import { showActions } from "../lib/actionSheet"
import { userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"

type Props = NativeStackScreenProps<RootStackParamList, "AgentTools">

/**
 * One agent's own skills or MCP tools — a drill-in from Edit agent, so that
 * screen stays a short list of settings. Each saves on its own (not with the
 * agent's form), which is why this needs a created agent. A row is written
 * here, copied from this Mac's setup, or installed from the Marketplace.
 */
export default function AgentToolsScreen({ route }: Props) {
  const { id, kind } = route.params
  const styles = useStyles()
  const t = useTheme()
  const [rows, setRows] = useState<(Skill | McpServer)[] | null>(null)
  const [error, setError] = useState("")
  const [skillEdit, setSkillEdit] = useState<Skill | null | undefined>(undefined)
  const [mcpEdit, setMcpEdit] = useState<McpServer | null | undefined>(undefined)
  const [market, setMarket] = useState(false)
  const [fromMac, setFromMac] = useState(false)
  const noun = kind === "skill" ? "skill" : "MCP tool"
  const load = useCallback(() => {
    setError("")
    api.agentTemplateExtras(id).then((x) => setRows(kind === "skill" ? x.skills : x.mcp))
      .catch((e) => setError(userError(e, `this agent's ${noun}s`)))
  }, [id, kind, noun])
  useFocusEffect(load)

  const add = () => showActions(`Add ${kind === "skill" ? "a skill" : "an MCP tool"}`, [
    { text: kind === "skill" ? "Write a new skill" : "Add manually", onPress: () => (kind === "skill" ? setSkillEdit(null) : setMcpEdit(null)) },
    { text: "From this Mac", onPress: () => setFromMac(true) },
    { text: "Marketplace", onPress: () => setMarket(true) },
  ])

  return (
    <ScrollView style={styles.page} contentContainerStyle={{ paddingBottom: 48 }}>
      <Text style={[styles.aiSectionHint, { marginTop: 16 }]}>
        {kind === "skill" ? "Instructions a chat can call by name, e.g. /weekly-review." : "Tools a chat can use, e.g. a database or a web API."}
        {" "}Every new chat from this agent gets its own copy.
      </Text>
      <View style={[styles.aiGroup, { marginTop: 8 }]}>
        {error ? (
          <TouchableOpacity testID="agent-tools-retry" style={styles.aiRow} onPress={load}>
            <Text style={[styles.error, styles.flex1]}>{error} Tap to try again.</Text>
          </TouchableOpacity>
        ) : !rows ? <View style={styles.aiRow}><ActivityIndicator color={t.textMuted} /></View> : null}
        {(rows ?? []).map((r, i) => (
          <TouchableOpacity key={r.name} testID={`agent-${kind}-${r.name}`} activeOpacity={0.65} style={[styles.aiRow, i ? styles.aiRowSep : null]}
            onPress={() => (kind === "skill" ? setSkillEdit(r as Skill) : setMcpEdit(r as McpServer))}>
            <Icon name={kind === "skill" ? "sparkle" : "tool"} size={16} color={t.accent} />
            <View style={styles.flex1}>
              <Text style={styles.aiRowTitle} numberOfLines={1}>{kind === "skill" ? `/${r.name}` : r.name}</Text>
              <Text style={styles.aiRowSub} numberOfLines={2}>{kind === "skill" ? (r as Skill).description || ""
                : `${(r as McpServer).transport}${(r as McpServer).target ? ` · ${(r as McpServer).target}` : ""}`}</Text>
            </View>
            <Icon name="chevronRight" size={14} color={t.textMuted} />
          </TouchableOpacity>
        ))}
        {rows ? (
          <TouchableOpacity testID={`agent-add-${kind}`} activeOpacity={0.65} onPress={add} accessibilityRole="button"
            style={[styles.aiRow, rows.length ? styles.aiRowSep : null]}>
            <Icon name="add" size={16} color={t.accent} />
            <Text style={styles.aeAction}>Add {noun}…</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {skillEdit !== undefined ? <SkillEditor skill={skillEdit} host="local" agent={id} onClose={() => setSkillEdit(undefined)} onSaved={load} /> : null}
      {mcpEdit !== undefined ? <McpEditor server={mcpEdit} host="local" agent={id} onClose={() => setMcpEdit(undefined)} onSaved={load} /> : null}
      {market ? <MarketplaceSheet kind={kind === "skill" ? "skills" : "mcp"} agent={{ id, name: route.params.name }} onClose={() => setMarket(false)} onInstalled={load} /> : null}
      {fromMac && rows ? <FromThisMac kind={kind} agentId={id} onAgent={rows} onClose={() => setFromMac(false)} onAdded={load} /> : null}
    </ScrollView>
  )
}

/** The skills or MCP servers already set up on this Mac, to copy onto the agent
 *  in one tap. A skill is copied whole (scripts too); an MCP server by its config. */
function FromThisMac({ kind, agentId, onAgent, onClose, onAdded }: {
  kind: "skill" | "mcp"; agentId: number; onAgent: { name: string }[]; onClose: () => void; onAdded: () => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const [rows, setRows] = useState<(Skill | McpServer)[] | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const what = kind === "skill" ? "skills" : "MCP tools"
  const load = useCallback(() => {
    setError(""); setRows(null)
    api.capabilities("local")
      .then((c) => setRows(kind === "skill" ? pickable(c.skills, onAgent) : pickable(c.mcp, onAgent)))
      .catch((e) => setError(userError(e, `this Mac's ${what}`)))
  }, [kind, onAgent, what])
  useEffect(load, [load])

  async function add(r: Skill | McpServer) {
    setBusy(r.name); setError("")
    try {
      await api.agentTemplateExtra(kind === "skill"
        ? { id: agentId, kind, name: r.name, from_path: (r as Skill).path }
        : { id: agentId, kind, name: r.name, config: (r as McpServer).config })
      onAdded(); onClose()
    } catch (e) {
      setError(userError(e, r.name, "add"))
    } finally {
      setBusy("")
    }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.page}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 16, paddingBottom: 8 }}>
          <Text style={{ flex: 1, fontSize: 18, fontWeight: "700", color: t.text }}>{kind === "skill" ? "Skills" : "MCP tools"} on this Mac</Text>
          <TouchableOpacity testID="frommac-close" onPress={onClose} hitSlop={10}><Icon name="close" size={22} color={t.textMuted} /></TouchableOpacity>
        </View>
        <Text style={[styles.hint, { paddingHorizontal: 16 }]}>Tap one to give this agent its own copy. Later changes on the Mac don't reach the copy.</Text>
        {error ? (
          <TouchableOpacity testID="frommac-retry" onPress={load} style={{ padding: 16 }}>
            <Text testID="frommac-error" style={styles.error}>{error} Tap to try again.</Text>
          </TouchableOpacity>
        ) : null}
        {!rows && !error ? <ActivityIndicator color={t.textMuted} style={{ marginTop: 24 }} /> : rows ? (
          <FlatList
            testID="frommac-list"
            data={rows}
            keyExtractor={(r) => r.name}
            contentContainerStyle={{ paddingBottom: 40 }}
            ListEmptyComponent={<Text style={styles.capEmpty}>No other {what} on this Mac. Try the Marketplace.</Text>}
            renderItem={({ item: r }) => (
              <TouchableOpacity testID={`frommac-${r.name}`} style={styles.capRow} disabled={!!busy} onPress={() => add(r)}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>{kind === "skill" ? `/${r.name}` : r.name}</Text>
                  <Text style={[styles.capRowDesc, { color: t.textMuted }]} numberOfLines={2}>
                    {kind === "skill" ? (r as Skill).description || "" : `${(r as McpServer).transport}${(r as McpServer).target ? ` · ${(r as McpServer).target}` : ""}`}
                  </Text>
                </View>
                {busy === r.name ? <ActivityIndicator color={t.textMuted} />
                  : <Text style={styles.capBadge}>{kind === "skill" ? (r as Skill).source : (r as McpServer).scope}</Text>}
              </TouchableOpacity>
            )}
          />
        ) : null}
      </View>
    </Modal>
  )
}
