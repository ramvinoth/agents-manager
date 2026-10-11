/**
 * CapabilitiesPanel — the one Skills / MCP tools list, shared by the full
 * CapabilitiesScreen and the thread's slide-in CapabilitiesDrawer (they differ
 * only in their chrome). Lists /api/capabilities for host + cwd, edits through
 * CapabilitiesEditors, and opens the Marketplace to pull vetted entries.
 * For a local Claude chat the server also returns its plugins: Harman's own are
 * added/removed per chat ("Included" = the agent's default), and skills/MCP can
 * be scoped to "this chat" only. A plugin is whole — add or remove, never edit.
 * "Save as plugin" packages the chat's own skills and MCP as a new catalog
 * plugin (badged "Yours", and deletable — a shipped plugin never is).
 * `testPrefix` keeps the two hosts' testIDs distinct ("cap" / "drawer").
 */
import React, { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, Alert, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from "react-native"
import { api, type Capabilities, type McpServer, type Plugin, type Skill } from "../api/client"
import type { MarketKind } from "../lib/marketplace"
import { userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
import { SkillEditor, McpEditor } from "./CapabilitiesEditors"
import MarketplaceSheet from "./MarketplaceSheet"
import SheetModal from "./SheetModal"
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

  // The chat's own extras (scope "this chat") — what "Save as plugin" packages.
  const ownParts = (caps?.skills.filter(s => s.source === "chat").length ?? 0) + (caps?.mcp.filter(m => m.scope === "chat").length ?? 0)
  const [saving, setSaving] = useState<{ name: string; description: string; error: string } | null>(null)

  async function saveAsPlugin() {
    if (!chat || !saving) return
    setBusy("save-plugin")
    try {
      await api.chatSaveAsPlugin(chat, saving.name.trim(), saving.description.trim())
      setSaving(null)
      load()
    } catch (e) {
      setSaving({ ...saving, error: userError(e, "this plugin", "save") })
    } finally {
      setBusy("")
    }
  }

  function deletePlugin(p: Plugin) {
    Alert.alert(`Delete ${p.name}?`, "It leaves the catalog for every chat and agent. Chats already using it lose its skills and MCP tools on their next run.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        setBusy(p.name); setError("")
        try { await api.pluginDelete(p.name); load() }
        catch (e) { setError(userError(e, p.name, "delete")) }
        finally { setBusy("") }
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
        <ScrollView contentContainerStyle={{ paddingBottom: 40, paddingTop: 4 }} keyboardShouldPersistTaps="handled">
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
          {tab === "plugins" && chat ? (
            <TouchableOpacity testID={id("save-as-plugin")} style={styles.capAddRow} disabled={!!busy || !ownParts}
              onPress={() => setSaving({ name: "", description: "", error: "" })}>
              <Icon name="folderPlus" size={16} color={ownParts ? t.accent : t.textMuted} />
              <Text style={[styles.capAddText, { color: ownParts ? t.accent : t.textMuted }]}>
                {ownParts ? "Save this chat's skills and MCP as a plugin" : "Add a skill or MCP tool for this chat to save it as a plugin"}
              </Text>
            </TouchableOpacity>
          ) : null}
          {tab === "plugins" ? (
            (plugins ?? []).map(p => (
              <View key={`${p.source}:${p.name}`} testID={id(`plugin-${p.name}`)} style={styles.capRow}>
                <View style={[styles.capRowIcon, { backgroundColor: t.accent + "18" }]}><Icon name="sparkle" size={16} color={t.accent} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>{p.name}</Text>
                  {p.description ? <Text style={[styles.capRowDesc, { color: t.textMuted }]} numberOfLines={2}>{p.description}</Text> : null}
                </View>
                {p.kind === "user" ? (
                  <TouchableOpacity testID={id(`plugin-delete-${p.name}`)} accessibilityLabel={`Delete ${p.name}`} hitSlop={8}
                    disabled={!!busy} onPress={() => deletePlugin(p)}>
                    <Icon name="trash" size={14} color={t.danger} />
                  </TouchableOpacity>
                ) : null}
                {p.kind === "user" ? <Text style={styles.capBadge}>Yours</Text> : null}
                {p.included ? <Text style={styles.capBadge}>Included</Text> : null}
                {p.source === "agent" ? (
                  <Switch testID={id(`plugin-toggle-${p.name}`)} value={p.active} disabled={!!busy}
                    accessibilityLabel={`${p.active ? "Remove" : "Add"} ${p.name}`} onValueChange={() => toggle(p)} />
                ) : <Text style={styles.capBadge}>on this Mac</Text>}
              </View>
            ))
          ) : tab === "skills" ? (
            caps.skills.length ? caps.skills.map(s => (
              <TouchableOpacity key={s.path} testID={id(`skill-${s.name}`)} style={styles.capRow} onPress={() => setSkillEdit(s)}>
                <View style={[styles.capRowIcon, { backgroundColor: t.accent + "18" }]}><Icon name="sparkle" size={16} color={t.accent} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>/{s.name}</Text>
                  {s.description ? <Text style={[styles.capRowDesc, { color: t.textMuted }]} numberOfLines={2}>{s.description}</Text> : null}
                </View>
                <Text style={styles.capBadge}>{s.source}</Text>
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
                <Text style={styles.capBadge}>{m.scope}</Text>
              </TouchableOpacity>
            )) : <Text style={styles.capEmpty}>No MCP tools yet. Add one by hand, or pull one from the Marketplace.</Text>
          )}
        </ScrollView>
      )}

      {skillEdit !== undefined && <SkillEditor skill={skillEdit} host={host} cwd={cwd} session={chat} onClose={() => setSkillEdit(undefined)} onSaved={load} />}
      {mcpEdit !== undefined && <McpEditor server={mcpEdit} host={host} cwd={cwd} session={chat} onClose={() => setMcpEdit(undefined)} onSaved={load} />}
      <SheetModal visible={!!saving} onClose={() => setSaving(null)}>
        <View style={styles.sheetGrabber} />
        <Text style={styles.actionSheetTitle}>Save as plugin</Text>
        <View style={{ paddingHorizontal: 20, paddingBottom: 20 }}>
          <Text style={styles.hint}>
            Packs this chat's {ownParts === 1 ? "skill or MCP tool" : `${ownParts} skills and MCP tools`} into a plugin any chat or agent can add. This chat keeps its own copy.
          </Text>
          <Text style={styles.label}>Name</Text>
          <TextInput testID={id("plugin-name")} style={styles.input} autoCapitalize="none" autoCorrect={false} autoFocus
            placeholder="research-kit" placeholderTextColor={t.textMuted + "80"}
            value={saving?.name ?? ""} onChangeText={v => saving && setSaving({ ...saving, name: v.toLowerCase(), error: "" })} />
          <Text style={styles.hint}>Lowercase letters, digits and dashes.</Text>
          <Text style={styles.label}>What it's for</Text>
          <TextInput testID={id("plugin-description")} style={styles.input} placeholder="One line"
            placeholderTextColor={t.textMuted + "80"}
            value={saving?.description ?? ""} onChangeText={v => saving && setSaving({ ...saving, description: v })} />
          {saving?.error ? <Text style={styles.error}>{saving.error}</Text> : null}
          <TouchableOpacity testID={id("plugin-save")} style={[styles.button, !saving?.name.trim() || busy ? { opacity: 0.5 } : null]}
            disabled={!saving?.name.trim() || !!busy} onPress={saveAsPlugin}>
            {busy === "save-plugin" ? <ActivityIndicator color={t.onAccent} /> : <Text style={styles.buttonText}>Save plugin</Text>}
          </TouchableOpacity>
        </View>
      </SheetModal>
      {market ? <MarketplaceSheet kind={market} cwd={cwd} session={chat} onClose={() => setMarket(null)} onInstalled={load} /> : null}
    </View>
  )
}
