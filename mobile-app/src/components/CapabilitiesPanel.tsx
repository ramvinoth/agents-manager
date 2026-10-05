/**
 * CapabilitiesPanel — the one Skills / MCP tools list, shared by the full
 * CapabilitiesScreen and the thread's slide-in CapabilitiesDrawer (they differ
 * only in their chrome). Lists /api/capabilities for host + cwd, edits through
 * CapabilitiesEditors, and opens the Marketplace to pull vetted entries.
 * `testPrefix` keeps the two hosts' testIDs distinct ("cap" / "drawer").
 */
import React, { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native"
import { api, type Capabilities, type McpServer, type Skill } from "../api/client"
import type { MarketKind } from "../lib/marketplace"
import { userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../screens/styles"
import { SkillEditor, McpEditor } from "./CapabilitiesEditors"
import MarketplaceSheet from "./MarketplaceSheet"
import Icon from "./Icon"

type Tab = "skills" | "mcp"

export default function CapabilitiesPanel({ host, cwd, active = true, testPrefix }: {
  host: string
  cwd?: string
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

  const load = useCallback(() => {
    setError("")
    api.capabilities(host, cwd).then(setCaps).catch(e => { setCaps(null); setError(userError(e, "skills and tools")) })
  }, [host, cwd])

  useEffect(() => { if (active) load() }, [active, load])

  const id = (s: string) => `${testPrefix}-${s}`
  const counts: Record<Tab, number> = { skills: caps?.skills.length ?? 0, mcp: caps?.mcp.length ?? 0 }

  function AddRows({ kind }: { kind: Tab }) {
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

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.segRow}>
        {([["skills", "Skills"], ["mcp", "MCP tools"]] as const).map(([v, label]) => {
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
        <ScrollView contentContainerStyle={{ paddingBottom: 40, paddingTop: 4 }} keyboardShouldPersistTaps="handled">
          <AddRows kind={tab} />
          {tab === "skills" ? (
            caps.skills.length ? caps.skills.map(s => (
              <TouchableOpacity key={s.path} testID={id(`skill-${s.name}`)} style={styles.capRow} onPress={() => setSkillEdit(s)}>
                <View style={[styles.capRowIcon, { backgroundColor: t.accent + "18" }]}><Icon name="sparkle" size={16} color={t.accent} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>/{s.name}</Text>
                  {s.description ? <Text style={[styles.capRowDesc, { color: t.textMuted }]} numberOfLines={2}>{s.description}</Text> : null}
                </View>
                <Text style={[styles.capBadge, { color: t.textMuted, borderColor: t.border }]}>{s.source}</Text>
              </TouchableOpacity>
            )) : <Text style={styles.capEmpty}>No skills yet. Write one, or pull one from the Marketplace.</Text>
          ) : (
            caps.mcp.length ? caps.mcp.map(m => (
              <TouchableOpacity key={`${m.scope}:${m.name}`} testID={id(`mcp-${m.name}`)} style={styles.capRow} onPress={() => setMcpEdit(m)}>
                <View style={[styles.capRowIcon, { backgroundColor: t.textMuted + "18" }]}><Icon name="tool" size={16} color={t.textMuted} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>{m.name}</Text>
                  <Text style={[styles.capRowDesc, { color: t.textMuted }]} numberOfLines={1}>{m.transport}{m.target ? ` · ${m.target}` : ""}</Text>
                </View>
                <Text style={[styles.capBadge, { color: t.textMuted, borderColor: t.border }]}>{m.scope}</Text>
              </TouchableOpacity>
            )) : <Text style={styles.capEmpty}>No MCP tools yet. Add one by hand, or pull one from the Marketplace.</Text>
          )}
        </ScrollView>
      )}

      {skillEdit !== undefined && <SkillEditor skill={skillEdit} host={host} cwd={cwd} onClose={() => setSkillEdit(undefined)} onSaved={load} />}
      {mcpEdit !== undefined && <McpEditor server={mcpEdit} host={host} cwd={cwd} onClose={() => setMcpEdit(undefined)} onSaved={load} />}
      {market ? <MarketplaceSheet kind={market} cwd={cwd} onClose={() => setMarket(null)} onInstalled={load} /> : null}
    </View>
  )
}
