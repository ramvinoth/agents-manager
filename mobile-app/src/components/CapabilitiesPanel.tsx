/**
 * CapabilitiesPanel — the one Skills / MCP tools list, shared by the full
 * CapabilitiesScreen and the thread's slide-in CapabilitiesDrawer (they differ
 * only in their chrome). Lists /api/capabilities for host + cwd, edits through
 * CapabilitiesEditors, and opens the Marketplace to pull vetted entries.
 * For a local Claude chat the server also returns its plugins: Manager's own are
 * added/removed per chat ("Included" = the agent's default), and skills/MCP can
 * be scoped to "this chat" only. A plugin is whole — add or remove, never edit.
 * A chat's setup is per chat; "Keep on agent" makes it the agent's default
 * (the agent itself is edited in the Agents tab — the hub for its setup).
 * Each tab is one searchable, virtualized list: a Mac with hundreds of skills
 * or plugins stays one scroll and one search away.
 * `testPrefix` keeps the two hosts' testIDs distinct ("cap" / "drawer").
 */
import React, { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, Alert, FlatList, Switch, Text, TextInput, TouchableOpacity, View } from "react-native"
import { api, type Capabilities, type McpServer, type Plugin, type Skill } from "../api/client"
import type { MarketKind } from "../lib/marketplace"
import { userError } from "../lib/errors"
import { textFilter } from "../lib/textFilter"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
import { SkillEditor, McpEditor } from "./CapabilitiesEditors"
import MarketplaceSheet from "./MarketplaceSheet"
import Icon from "./Icon"

type Tab = "skills" | "mcp" | "plugins"

export default function CapabilitiesPanel({ host, cwd, session, active = true, testPrefix }: {
  host: string
  cwd?: string
  /** Session rel path — lets the server include this session's attached plugin skills. */
  session?: string
  /** Reload whenever this turns true (screen focus, drawer open). */
  active?: boolean
  testPrefix: "cap" | "drawer"
}) {
  const styles = useStyles()
  const t = useTheme()
  const [tab, setTab] = useState<Tab>("skills")
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [error, setError] = useState("")
  const [skillEdit, setSkillEdit] = useState<Skill | null | undefined>(undefined)
  const [mcpEdit, setMcpEdit] = useState<McpServer | null | undefined>(undefined)
  const [market, setMarket] = useState<MarketKind | null>(null)
  const [busy, setBusy] = useState("")
  const [query, setQuery] = useState("")

  const load = useCallback(() => {
    setError("")
    api.capabilities(host, cwd, session).then(setCaps).catch(e => { setCaps(null); setError(userError(e, "skills and tools")) })
  }, [host, cwd, session])

  useEffect(() => { if (active) load() }, [active, load])

  const id = (s: string) => `${testPrefix}-${s}`
  // The server lists plugins only for a local Claude chat — the one place they
  // (and "this chat" scope) apply, since they ride --plugin-dir on its runs.
  const plugins = caps?.plugins
  const chat = plugins && session ? session : undefined
  const counts: Record<Tab, number> = {
    skills: caps?.skills.length ?? 0, mcp: caps?.mcp.length ?? 0,
    plugins: plugins?.filter(p => p.active).length ?? 0,
  }
  const tabs: (readonly [Tab, string])[] = [["skills", "Skills"], ["mcp", "MCP tools"], ...(plugins ? [["plugins", "Plugins"] as const] : [])]

  async function toggle(p: Plugin) {
    if (!chat) return
    setBusy(p.name); setError("")
    try {
      await api.chatPlugin({ session: chat, name: p.name, on: !p.active })
      load()
    } catch (e) {
      setError(userError(e, p.name, p.active ? "remove" : "add"))
    } finally {
      setBusy("")
    }
  }

  const agent = chat ? caps?.agent : undefined
  const [kept, setKept] = useState(false)

  function keepOnAgent() {
    if (!agent || !chat) return
    Alert.alert(`Keep on ${agent.name}?`,
      `Every new ${agent.name} chat will start with this chat's plugins, skills and MCP tools. This replaces what ${agent.name} kept before; chats already running are not changed.`, [
        { text: "Cancel", style: "cancel" },
        { text: "Keep", onPress: async () => {
          setBusy("agent"); setError("")
          try {
            await api.chatSaveToAgent(chat)
            setKept(true)
            load()
          } catch (e) {
            setError(userError(e, `this setup on ${agent.name}`, "keep"))
          } finally {
            setBusy("")
          }
        } },
      ])
  }

  function AddRows({ kind }: { kind: MarketKind }) {
    const isSkill = kind === "skills"
    return (
      <View style={{ flexDirection: "row" }}>
        <TouchableOpacity testID={id(`add-${isSkill ? "skill" : "mcp"}`)} style={[styles.capAddRow, { flex: 1 }]}
          onPress={() => (isSkill ? setSkillEdit(null) : setMcpEdit(null))}>
          <Icon name="add" size={16} color={t.accent} />
          <Text style={[styles.capAddText, { color: t.accent }]}>{isSkill ? "New skill" : "Add manually"}</Text>
        </TouchableOpacity>
        {/* The marketplace installs onto the viewer's own machine, so it is offered
            only where that is the session's machine. */}
        {host === "local" ? (
          <TouchableOpacity testID={id(`browse-${kind}`)} style={[styles.capAddRow, { flex: 1 }]} onPress={() => setMarket(kind)}>
            <Icon name="search" size={16} color={t.accent} />
            <Text style={[styles.capAddText, { color: t.accent }]}>Marketplace</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    )
  }

  // The current tab's rows, narrowed by the search (shared across tabs, so a
  // name looked up under Skills is still looked up under MCP tools).
  const all: (Plugin | Skill | McpServer)[] = !caps ? [] : tab === "plugins" ? plugins ?? [] : tab === "skills" ? caps.skills : caps.mcp
  const rows = tab === "mcp"
    ? textFilter(all as McpServer[], query, (m) => [m.name, m.target])
    : textFilter(all as (Plugin | Skill)[], query, (r) => [r.name, r.description])

  const pluginRow = (p: Plugin) => (
    <View testID={id(`plugin-${p.name}`)} style={styles.capRow}>
      <View style={[styles.capRowIcon, { backgroundColor: t.accent + "18" }]}><Icon name="sparkle" size={16} color={t.accent} /></View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>{p.name}</Text>
        {p.description ? <Text style={[styles.capRowDesc, { color: t.textMuted }]} numberOfLines={2}>{p.description}</Text> : null}
      </View>
      {p.included ? <Text style={styles.capBadge}>Included</Text> : null}
      {p.source === "agent" ? (
        <Switch testID={id(`plugin-toggle-${p.name}`)} value={p.active} disabled={!!busy}
          accessibilityLabel={`${p.active ? "Remove" : "Add"} ${p.name}`} onValueChange={() => toggle(p)} />
      ) : <Text style={styles.capBadge}>on this Mac</Text>}
    </View>
  )
  const skillRow = (s: Skill) => (
    <TouchableOpacity testID={id(`skill-${s.name}`)} style={styles.capRow} onPress={() => setSkillEdit(s)}>
      <View style={[styles.capRowIcon, { backgroundColor: t.accent + "18" }]}><Icon name="sparkle" size={16} color={t.accent} /></View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>/{s.name}</Text>
        {s.description ? <Text style={[styles.capRowDesc, { color: t.textMuted }]} numberOfLines={2}>{s.description}</Text> : null}
      </View>
      <Text style={styles.capBadge}>{s.source}</Text>
    </TouchableOpacity>
  )
  const mcpRow = (m: McpServer) => (
    <TouchableOpacity testID={id(`mcp-${m.name}`)} style={styles.capRow} onPress={() => setMcpEdit(m)}>
      <View style={[styles.capRowIcon, { backgroundColor: t.textMuted + "18" }]}><Icon name="tool" size={16} color={t.textMuted} /></View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>{m.name}</Text>
        <Text style={[styles.capRowDesc, { color: t.textMuted }]} numberOfLines={1}>{m.transport}{m.target ? ` · ${m.target}` : ""}</Text>
      </View>
      <Text style={styles.capBadge}>{m.scope}</Text>
    </TouchableOpacity>
  )

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.segRow}>
        {tabs.map(([v, label]) => {
          const on = tab === v
          return (
            <TouchableOpacity key={v} testID={id(`tab-${v}`)} style={[styles.seg, on ? styles.segActive : null]} onPress={() => setTab(v)}>
              <Text style={[styles.segText, on ? styles.segTextActive : null]}>{label}</Text>
              {counts[v] > 0 ? (
                <Text style={[styles.segText, on ? styles.segTextActive : null, styles.capTabCount]}>{counts[v]}</Text>
              ) : null}
            </TouchableOpacity>
          )
        })}
      </View>

      {error ? (
        <View style={{ padding: 18, alignItems: "center", gap: 10 }}>
          <Text testID={id("error")} style={[styles.capEmpty, { padding: 0 }]}>{error}</Text>
          <TouchableOpacity testID={id("retry")} onPress={load}><Text style={{ color: t.accent, fontWeight: "600" }}>Try again</Text></TouchableOpacity>
        </View>
      ) : !caps ? (
        <ActivityIndicator size="small" color={t.textMuted} style={{ marginTop: 24 }} />
      ) : (
        <FlatList<Plugin | Skill | McpServer>
          testID={id("list")}
          data={rows}
          keyExtractor={(r) => tab === "plugins" ? `${(r as Plugin).source}:${r.name}` : tab === "skills" ? (r as Skill).path : `${(r as McpServer).scope}:${r.name}`}
          contentContainerStyle={{ paddingBottom: 40, paddingTop: 4 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListHeaderComponent={<>
            {tab !== "plugins" ? <AddRows kind={tab} /> : null}
            {tab === "plugins" && agent ? (
              <View style={[styles.capRow, { alignItems: "center" }]}>
                <Text style={[styles.capRowDesc, { flex: 1, color: t.textMuted }]}>
                  {kept ? `Saved: new ${agent.name} chats start with this setup.` : `Started from ${agent.name}. Keep this chat's plugins, skills and MCP for its next chats?`}
                </Text>
                <TouchableOpacity testID={id("keep-on-agent")} disabled={!!busy} onPress={keepOnAgent}>
                  <Text style={{ color: t.accent, fontWeight: "600" }}>Keep on agent</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            {all.length > 1 || query ? (
              <TextInput testID={id("search")} style={[styles.input, { marginHorizontal: 16, marginVertical: 8 }]}
                placeholder={`Search ${all.length} ${tab === "mcp" ? "MCP tools" : tab}`} placeholderTextColor={t.textMuted + "80"}
                value={query} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" />
            ) : null}
          </>}
          ListEmptyComponent={<Text style={styles.capEmpty}>{
            query.trim() ? `Nothing matches "${query.trim()}".`
              : tab === "skills" ? "No skills yet. Write one, or pull one from the Marketplace."
              : tab === "mcp" ? "No MCP tools yet. Add one by hand, or pull one from the Marketplace."
              : "No plugins on this server yet."}</Text>}
          renderItem={({ item }) => tab === "plugins" ? pluginRow(item as Plugin) : tab === "skills" ? skillRow(item as Skill) : mcpRow(item as McpServer)}
        />
      )}

      {skillEdit !== undefined && <SkillEditor skill={skillEdit} host={host} cwd={cwd} session={chat} onClose={() => setSkillEdit(undefined)} onSaved={load} />}
      {mcpEdit !== undefined && <McpEditor server={mcpEdit} host={host} cwd={cwd} session={chat} onClose={() => setMcpEdit(undefined)} onSaved={load} />}
      {market ? <MarketplaceSheet kind={market} cwd={cwd} session={chat} onClose={() => setMarket(null)} onInstalled={load} /> : null}
    </View>
  )
}
